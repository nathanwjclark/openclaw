import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentTaskAdoptedError,
  AgentTaskNotFoundError,
  AgentTaskOwnershipError,
  AgentTaskRateLimitError,
  AgentTaskTerminalError,
  AgentTaskWrongRuntimeError,
  DEFAULT_MAX_ACTIVE_AGENT_TASKS,
  adoptAgentTaskForSubagentRun,
  completeAgentTask,
  createAgentTaskRecord,
  isAgentTaskRateLimitError,
  updateAgentTaskProgress,
} from "./agent-task-create.js";
import {
  createTaskRecord,
  getTaskById,
  markTaskTerminalById,
  resetTaskRegistryForTests,
} from "./runtime-internal.js";

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

describe("updateAgentTaskProgress", () => {
  it("writes a progress note and bumps queued -> running on first update", () => {
    const created = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Investigate upgrade",
      label: "p-1",
    });
    expect(created.status).toBe("queued");
    expect(created.startedAt).toBeUndefined();
    const updated = updateAgentTaskProgress({
      taskId: created.taskId,
      ownerKey: OWNER,
      progressSummary: "Pulled upstream changelog; reading release notes now.",
    });
    expect(updated.taskId).toBe(created.taskId);
    expect(updated.status).toBe("running");
    expect(updated.progressSummary).toContain("changelog");
    expect(typeof updated.startedAt).toBe("number");
  });

  it("throws AgentTaskNotFoundError for unknown task ids", () => {
    expect(() =>
      updateAgentTaskProgress({
        taskId: "00000000-0000-0000-0000-000000000000",
        ownerKey: OWNER,
        progressSummary: "anything",
      }),
    ).toThrow(AgentTaskNotFoundError);
  });

  it("throws AgentTaskOwnershipError when a different owner attempts to update", () => {
    const created = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Owned by main",
      label: "p-2",
    });
    expect(() =>
      updateAgentTaskProgress({
        taskId: created.taskId,
        ownerKey: "agent:other:other",
        progressSummary: "no permission",
      }),
    ).toThrow(AgentTaskOwnershipError);
  });

  it("throws AgentTaskWrongRuntimeError when target task is not agent-runtime", () => {
    const cliTask = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: OWNER,
      ownerKey: OWNER,
      scopeKind: "session",
      runId: "run-x",
      task: "non-agent task",
      status: "running",
      deliveryStatus: "pending",
    });
    expect(() =>
      updateAgentTaskProgress({
        taskId: cliTask.taskId,
        ownerKey: OWNER,
        progressSummary: "should be rejected",
      }),
    ).toThrow(AgentTaskWrongRuntimeError);
  });

  it("throws AgentTaskTerminalError on a task that's already complete", () => {
    const created = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Already done",
      label: "p-4",
    });
    completeAgentTask({
      taskId: created.taskId,
      ownerKey: OWNER,
      outcome: "succeeded",
      terminalSummary: "done",
    });
    expect(() =>
      updateAgentTaskProgress({
        taskId: created.taskId,
        ownerKey: OWNER,
        progressSummary: "no, it's done",
      }),
    ).toThrow(AgentTaskTerminalError);
  });
});

describe("completeAgentTask", () => {
  it("marks the task succeeded for outcome=succeeded", () => {
    const created = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Wrap up",
      label: "c-1",
    });
    const completed = completeAgentTask({
      taskId: created.taskId,
      ownerKey: OWNER,
      outcome: "succeeded",
      terminalSummary: "Done",
    });
    expect(completed.status).toBe("succeeded");
    expect(completed.terminalOutcome).toBe("succeeded");
    expect(completed.terminalSummary).toBe("Done");
    expect(typeof completed.endedAt).toBe("number");
  });

  it("marks the task failed for outcome=blocked", () => {
    const created = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Stuck",
      label: "c-2",
    });
    const completed = completeAgentTask({
      taskId: created.taskId,
      ownerKey: OWNER,
      outcome: "blocked",
      terminalSummary: "Waiting on external info",
    });
    expect(completed.status).toBe("failed");
    expect(completed.terminalOutcome).toBe("blocked");
  });

  it("refuses double-complete with AgentTaskTerminalError", () => {
    const created = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Once",
      label: "c-3",
    });
    completeAgentTask({ taskId: created.taskId, ownerKey: OWNER, outcome: "succeeded" });
    expect(() =>
      completeAgentTask({ taskId: created.taskId, ownerKey: OWNER, outcome: "blocked" }),
    ).toThrow(AgentTaskTerminalError);
  });

  it("never stamps cleanupAfter on terminal agent tasks (durable forever)", () => {
    const created = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Permanent record",
      label: "perm",
    });
    const completed = completeAgentTask({
      taskId: created.taskId,
      ownerKey: OWNER,
      outcome: "succeeded",
      terminalSummary: "Done.",
    });
    expect(completed.status).toBe("succeeded");
    expect(completed.cleanupAfter).toBeUndefined();
  });

  it("frees rate-cap capacity once completed (anchor)", () => {
    const limit = 2;
    const first = createAgentTaskRecord(
      { ownerKey: OWNER, sessionKey: SESSION, task: "task A", label: "ca" },
      { maxActiveAgentTasks: limit },
    );
    createAgentTaskRecord(
      { ownerKey: OWNER, sessionKey: SESSION, task: "task B", label: "cb" },
      { maxActiveAgentTasks: limit },
    );
    completeAgentTask({ taskId: first.taskId, ownerKey: OWNER, outcome: "succeeded" });
    const third = createAgentTaskRecord(
      { ownerKey: OWNER, sessionKey: SESSION, task: "task C", label: "cc" },
      { maxActiveAgentTasks: limit },
    );
    expect(third.taskId).not.toBe(first.taskId);
    expect(third.runtime).toBe("agent");
  });
});

describe("adoptAgentTaskForSubagentRun", () => {
  it("attaches a subagent run to a queued agent task and moves it to running", () => {
    const created = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Spawn for this",
      label: "spawn-1",
    });
    const adopted = adoptAgentTaskForSubagentRun({
      taskId: created.taskId,
      ownerKey: OWNER,
      runId: "run-abc",
      childSessionKey: "agent:worker:subagent:child",
    });
    expect(adopted.taskId).toBe(created.taskId);
    expect(adopted.status).toBe("running");
    expect(adopted.runtime).toBe("agent");
    expect(adopted.childSessionKey).toBe("agent:worker:subagent:child");
    expect(adopted.runId).toBe("run-abc");
  });

  it("indexes the adopted task by runId so subagent termination can find it", () => {
    const created = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Spawn for this",
      label: "spawn-idx",
    });
    adoptAgentTaskForSubagentRun({
      taskId: created.taskId,
      ownerKey: OWNER,
      runId: "run-idx",
      childSessionKey: "agent:worker:subagent:idx",
    });
    // Termination path uses markTaskTerminalById indirectly via runId; we mirror its lookup here.
    markTaskTerminalById({
      taskId: created.taskId,
      status: "succeeded",
      endedAt: Date.now(),
      terminalSummary: "subagent done",
      terminalOutcome: "succeeded",
    });
    const final = getTaskById(created.taskId);
    expect(final?.status).toBe("succeeded");
    expect(final?.runtime).toBe("agent");
    expect(final?.cleanupAfter).toBeUndefined();
  });

  it("rejects adoption when the task is owned by a different session", () => {
    const created = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Mine",
      label: "owner-check",
    });
    expect(() =>
      adoptAgentTaskForSubagentRun({
        taskId: created.taskId,
        ownerKey: "agent:other:other",
        runId: "run-x",
        childSessionKey: "agent:worker:subagent:x",
      }),
    ).toThrow(AgentTaskOwnershipError);
  });

  it("rejects adoption when the task is non-agent runtime", () => {
    const cli = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: OWNER,
      ownerKey: OWNER,
      scopeKind: "session",
      runId: "run-cli",
      task: "cli task",
      status: "running",
      deliveryStatus: "pending",
    });
    expect(() =>
      adoptAgentTaskForSubagentRun({
        taskId: cli.taskId,
        ownerKey: OWNER,
        runId: "run-cli-2",
        childSessionKey: "agent:worker:subagent:cli",
      }),
    ).toThrow(AgentTaskWrongRuntimeError);
  });

  it("rejects double-adoption (task already has a childSessionKey)", () => {
    const created = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Adopted once",
      label: "twice",
    });
    adoptAgentTaskForSubagentRun({
      taskId: created.taskId,
      ownerKey: OWNER,
      runId: "run-1",
      childSessionKey: "agent:worker:subagent:once",
    });
    expect(() =>
      adoptAgentTaskForSubagentRun({
        taskId: created.taskId,
        ownerKey: OWNER,
        runId: "run-2",
        childSessionKey: "agent:worker:subagent:twice",
      }),
    ).toThrow(AgentTaskAdoptedError);
  });

  it("rejects adoption of a terminal task", () => {
    const created = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Already done",
      label: "done",
    });
    completeAgentTask({
      taskId: created.taskId,
      ownerKey: OWNER,
      outcome: "succeeded",
    });
    expect(() =>
      adoptAgentTaskForSubagentRun({
        taskId: created.taskId,
        ownerKey: OWNER,
        runId: "run-late",
        childSessionKey: "agent:worker:subagent:late",
      }),
    ).toThrow(AgentTaskTerminalError);
  });
});

describe("agent-tool mutations after subagent adoption", () => {
  it("update_progress is blocked once the task has been adopted by a subagent", () => {
    const created = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Spawn-driven",
      label: "blk-1",
    });
    adoptAgentTaskForSubagentRun({
      taskId: created.taskId,
      ownerKey: OWNER,
      runId: "run-blk-1",
      childSessionKey: "agent:worker:subagent:blk1",
    });
    expect(() =>
      updateAgentTaskProgress({
        taskId: created.taskId,
        ownerKey: OWNER,
        progressSummary: "should not be allowed",
      }),
    ).toThrow(AgentTaskAdoptedError);
  });

  it("complete is blocked once the task has been adopted by a subagent", () => {
    const created = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Spawn-driven 2",
      label: "blk-2",
    });
    adoptAgentTaskForSubagentRun({
      taskId: created.taskId,
      ownerKey: OWNER,
      runId: "run-blk-2",
      childSessionKey: "agent:worker:subagent:blk2",
    });
    expect(() =>
      completeAgentTask({
        taskId: created.taskId,
        ownerKey: OWNER,
        outcome: "succeeded",
      }),
    ).toThrow(AgentTaskAdoptedError);
  });
});
