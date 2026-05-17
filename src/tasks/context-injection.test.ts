import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completeAgentTask,
  createAgentTaskRecord,
  updateAgentTaskProgress,
} from "./agent-task-create.js";
import { renderTasksContext, renderTasksContextForRun } from "./context-injection.js";
import { createTaskRecord, resetTaskRegistryForTests } from "./runtime-internal.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tasks-injection-"));
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

describe("renderTasksContext", () => {
  it("returns empty rendered text when the owner has no tasks", () => {
    const result = renderTasksContext({ ownerKey: OWNER });
    expect(result.rendered).toBe("");
    expect(result.activeCount).toBe(0);
    expect(result.terminalCount).toBe(0);
  });

  it("renders active tasks under an Active heading", () => {
    createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Investigate the 2026.5.12 upgrade",
      label: "upgrade",
    });
    const result = renderTasksContext({ ownerKey: OWNER });
    expect(result.activeCount).toBe(1);
    expect(result.rendered).toContain("## Open tasks");
    expect(result.rendered).toContain("### Active (1)");
    expect(result.rendered).toContain("upgrade");
    expect(result.rendered).toContain("[queued]");
  });

  it("renders recent terminal tasks under their own heading and marks them terminal", () => {
    const t = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Wrap up",
      label: "wrap",
    });
    completeAgentTask({
      taskId: t.taskId,
      ownerKey: OWNER,
      outcome: "succeeded",
      terminalSummary: "Done.",
    });
    const result = renderTasksContext({ ownerKey: OWNER });
    expect(result.terminalCount).toBe(1);
    expect(result.rendered).toContain("### Recently completed");
    expect(result.rendered).toContain("[succeeded outcome=succeeded]");
    expect(result.rendered).toContain("Done.");
  });

  it("includes non-agent runtimes from the same owner (e.g. subagent runs)", () => {
    createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: OWNER,
      ownerKey: OWNER,
      scopeKind: "session",
      childSessionKey: "agent:worker:subagent:child",
      runId: "subagent-run-1",
      task: "Spawned subagent",
      status: "running",
      deliveryStatus: "pending",
    });
    const result = renderTasksContext({ ownerKey: OWNER });
    expect(result.activeCount).toBe(1);
    expect(result.rendered).toContain("[subagent]");
    expect(result.rendered).toContain("child: agent:worker:subagent:child");
  });

  it("renders progress summary for in-flight tasks", () => {
    const t = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Investigate",
      label: "inv",
    });
    updateAgentTaskProgress({
      taskId: t.taskId,
      ownerKey: OWNER,
      progressSummary: "Pulled changelog; mapping deltas.",
    });
    const result = renderTasksContext({ ownerKey: OWNER });
    expect(result.rendered).toContain("[running]");
    expect(result.rendered).toContain("progress: Pulled changelog");
  });

  it("orders active by createdAt ascending so the prompt cache stays stable", () => {
    const first = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "First task",
      label: "first",
    });
    const second = createAgentTaskRecord({
      ownerKey: OWNER,
      sessionKey: SESSION,
      task: "Second task",
      label: "second",
    });
    const result = renderTasksContext({ ownerKey: OWNER });
    const firstIdx = result.rendered.indexOf(first.taskId);
    const secondIdx = result.rendered.indexOf(second.taskId);
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });
});

describe("renderTasksContextForRun", () => {
  it("returns empty when the feature flag is explicitly disabled", () => {
    createAgentTaskRecord({ ownerKey: OWNER, sessionKey: SESSION, task: "x", label: "x" });
    const result = renderTasksContextForRun({
      sessionKey: OWNER,
      agentId: "main",
      config: { tools: { experimental: { agentTasks: false } } },
    });
    expect(result.rendered).toBe("");
  });

  it("renders by default (flag absent) since the feature is on by default", () => {
    createAgentTaskRecord({ ownerKey: OWNER, sessionKey: SESSION, task: "x", label: "x" });
    const result = renderTasksContextForRun({
      sessionKey: OWNER,
      agentId: "main",
    });
    expect(result.rendered).toContain("## Open tasks");
  });

  it("renders when the flag is explicitly enabled", () => {
    createAgentTaskRecord({ ownerKey: OWNER, sessionKey: SESSION, task: "x", label: "x" });
    const result = renderTasksContextForRun({
      sessionKey: OWNER,
      agentId: "main",
      config: { tools: { experimental: { agentTasks: true } } },
    });
    expect(result.rendered).toContain("## Open tasks");
  });

  it("returns empty when sessionKey is missing", () => {
    createAgentTaskRecord({ ownerKey: OWNER, sessionKey: SESSION, task: "x", label: "x" });
    const result = renderTasksContextForRun({
      agentId: "main",
      config: { tools: { experimental: { agentTasks: true } } },
    });
    expect(result.rendered).toBe("");
  });
});
