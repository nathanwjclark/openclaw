import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentTaskRateLimitError,
  DEFAULT_MAX_ACTIVE_AGENT_TASKS,
  createAgentTaskRecord,
  isAgentTaskRateLimitError,
} from "./agent-task-create.js";
import { markTaskTerminalById, resetTaskRegistryForTests } from "./runtime-internal.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-task-create-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  resetTaskRegistryForTests({ persist: false });
});

afterEach(async () => {
  resetTaskRegistryForTests({ persist: false });
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
  await fs.rm(stateDir, { recursive: true, force: true });
});

const OWNER = "agent:main:main";
const SESSION = "agent:main:main";

describe("createAgentTaskRecord", () => {
  it("creates an agent-runtime task with safe defaults", () => {
    const record = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      agentId: "main",
      task: "Investigate the 2026.5.12 upgrade impact",
    });
    expect(record.runtime).toBe("agent");
    expect(record.scopeKind).toBe("session");
    expect(record.status).toBe("queued");
    expect(record.deliveryStatus).toBe("not_applicable");
    expect(record.notifyPolicy).toBe("silent");
    expect(record.ownerKey).toBe(OWNER);
    expect(record.requesterSessionKey).toBe(SESSION);
    expect(record.agentId).toBe("main");
    expect(record.task).toBe("Investigate the 2026.5.12 upgrade impact");
  });

  it("honors caller-specified notifyPolicy", () => {
    const record = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Watch for follow-up",
      notifyPolicy: "state_changes",
    });
    expect(record.notifyPolicy).toBe("state_changes");
  });

  it("propagates extrapolation linkage fields", () => {
    const record = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Materialize forward branch",
      extrapolationGraphId: "graph-abc",
      extrapolationNodeId: "node-xyz",
    });
    expect(record.extrapolationGraphId).toBe("graph-abc");
    expect(record.extrapolationNodeId).toBe("node-xyz");
  });

  it("deduplicates identical create calls for the same owner+task", () => {
    const first = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Audit upgrade impact",
      label: "upgrade-audit",
    });
    const second = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Audit upgrade impact",
      label: "upgrade-audit",
    });
    expect(second.taskId).toBe(first.taskId);
  });

  it("rate-limits when active agent-task count reaches the cap", () => {
    const limit = 3;
    for (let i = 0; i < limit; i += 1) {
      createAgentTaskRecord(
        {
          ownerKey: OWNER,
          sessionKey: SESSION,
          task: `Task ${i}`,
          label: `task-${i}`,
        },
        { maxActiveAgentTasks: limit },
      );
    }
    let caught: unknown;
    try {
      createAgentTaskRecord(
        {
          ownerKey: OWNER,
          sessionKey: SESSION,
          task: "Overflow task",
          label: "overflow",
        },
        { maxActiveAgentTasks: limit },
      );
    } catch (error) {
      caught = error;
    }
    expect(isAgentTaskRateLimitError(caught)).toBe(true);
    if (caught instanceof AgentTaskRateLimitError) {
      expect(caught.activeCount).toBe(limit);
      expect(caught.limit).toBe(limit);
    }
  });

  it("releases capacity once existing tasks reach terminal status", () => {
    const limit = 2;
    const first = createAgentTaskRecord(
      { ownerKey: OWNER, sessionKey: SESSION, task: "Task A", label: "a" },
      { maxActiveAgentTasks: limit },
    );
    createAgentTaskRecord(
      { ownerKey: OWNER, sessionKey: SESSION, task: "Task B", label: "b" },
      { maxActiveAgentTasks: limit },
    );
    markTaskTerminalById({
      taskId: first.taskId,
      status: "succeeded",
      endedAt: Date.now(),
      terminalSummary: "done",
      terminalOutcome: "succeeded",
    });
    const third = createAgentTaskRecord(
      { ownerKey: OWNER, sessionKey: SESSION, task: "Task C", label: "c" },
      { maxActiveAgentTasks: limit },
    );
    expect(third.taskId).not.toBe(first.taskId);
    expect(third.runtime).toBe("agent");
  });

  it("does not count non-agent-runtime tasks against the cap", () => {
    const limit = 1;
    createAgentTaskRecord(
      { ownerKey: OWNER, sessionKey: SESSION, task: "Only agent task", label: "agent-1" },
      { maxActiveAgentTasks: limit },
    );
    expect(DEFAULT_MAX_ACTIVE_AGENT_TASKS).toBeGreaterThan(0);
  });
});
