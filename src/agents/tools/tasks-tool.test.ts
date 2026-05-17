import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetTaskRegistryForTests } from "../../tasks/runtime-internal.js";
import { createTasksTool, isAgentTasksToolEnabled } from "./tasks-tool.js";

type ToolResult = Awaited<ReturnType<ReturnType<typeof createTasksTool>["execute"]>>;

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tasks-tool-"));
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

function buildTool(overrides: Partial<Parameters<typeof createTasksTool>[0]> = {}) {
  return createTasksTool({
    agentId: "main",
    ownerKey: OWNER,
    sessionKey: SESSION,
    ...overrides,
  });
}

function parsePayload(result: ToolResult): Record<string, unknown> {
  const details = (result as { details?: unknown }).details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return details as Record<string, unknown>;
  }
  const text = (result as { text?: string }).text;
  if (typeof text === "string" && text.trim().length > 0) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  throw new Error(`tool result did not produce a parseable payload: ${JSON.stringify(result)}`);
}

describe("tasks agent tool", () => {
  it("creates a queued agent-runtime task and returns the task_id", async () => {
    const tool = buildTool();
    const result = await tool.execute("call-1", {
      action: "create",
      task: "Investigate the 2026.5.12 upgrade impact",
      label: "upgrade-audit",
    });
    const payload = parsePayload(result);
    expect(payload.status).toBe("ok");
    expect(typeof payload.task_id).toBe("string");
    expect(payload.task_status).toBe("queued");
    expect(payload.label).toBe("upgrade-audit");
  });

  it("rejects unknown actions", async () => {
    const tool = buildTool();
    await expect(tool.execute("call-x", { action: "destroy_everything" })).rejects.toThrow(
      /unknown action/,
    );
  });

  it("rejects an invalid notify_policy value", async () => {
    const tool = buildTool();
    await expect(
      tool.execute("call-2", {
        action: "create",
        task: "Bad policy",
        notify_policy: "yell_in_caps",
      }),
    ).rejects.toThrow(/notify_policy/);
  });

  it("returns the same task_id for an active duplicate create call", async () => {
    const tool = buildTool();
    const first = parsePayload(
      await tool.execute("call-a", {
        action: "create",
        task: "Audit upgrade impact",
        label: "audit-dup",
      }),
    );
    const second = parsePayload(
      await tool.execute("call-b", {
        action: "create",
        task: "Audit upgrade impact",
        label: "audit-dup",
      }),
    );
    expect(second.task_id).toBe(first.task_id);
  });

  it("requires the 'task' field", async () => {
    const tool = buildTool();
    await expect(tool.execute("call-3", { action: "create" })).rejects.toThrow(/task/);
  });

  it("propagates extrapolation linkage fields into the created record", async () => {
    const tool = buildTool();
    const payload = parsePayload(
      await tool.execute("call-4", {
        action: "create",
        task: "Materialize forward branch",
        extrapolation_graph_id: "graph-abc",
        extrapolation_node_id: "node-xyz",
      }),
    );
    expect(payload.status).toBe("ok");
    expect(typeof payload.task_id).toBe("string");
  });

  it("update_progress writes a progress note and moves status to running", async () => {
    const tool = buildTool();
    const created = parsePayload(
      await tool.execute("call-up-1", {
        action: "create",
        task: "Audit upgrade",
        label: "upgrade",
      }),
    );
    expect(created.task_status).toBe("queued");
    const updated = parsePayload(
      await tool.execute("call-up-2", {
        action: "update_progress",
        task_id: created.task_id as string,
        progress_summary: "Pulled changelog; mapping deltas.",
      }),
    );
    expect(updated.status).toBe("ok");
    expect(updated.task_status).toBe("running");
  });

  it("update_progress returns not_found for an unknown task id", async () => {
    const tool = buildTool();
    const payload = parsePayload(
      await tool.execute("call-nf", {
        action: "update_progress",
        task_id: "00000000-0000-0000-0000-000000000000",
        progress_summary: "ignored",
      }),
    );
    expect(payload.status).toBe("not_found");
  });

  it("complete with outcome='succeeded' marks the task succeeded", async () => {
    const tool = buildTool();
    const created = parsePayload(
      await tool.execute("call-c1", { action: "create", task: "wrap", label: "wrap" }),
    );
    const completed = parsePayload(
      await tool.execute("call-c2", {
        action: "complete",
        task_id: created.task_id as string,
        outcome: "succeeded",
        terminal_summary: "Done.",
      }),
    );
    expect(completed.status).toBe("ok");
    expect(completed.task_status).toBe("succeeded");
    expect(completed.terminal_outcome).toBe("succeeded");
  });

  it("complete with outcome='blocked' marks the task failed/blocked", async () => {
    const tool = buildTool();
    const created = parsePayload(
      await tool.execute("call-b1", { action: "create", task: "stuck", label: "stuck" }),
    );
    const completed = parsePayload(
      await tool.execute("call-b2", {
        action: "complete",
        task_id: created.task_id as string,
        outcome: "blocked",
      }),
    );
    expect(completed.task_status).toBe("failed");
    expect(completed.terminal_outcome).toBe("blocked");
  });

  it("complete returns already_terminal on second call", async () => {
    const tool = buildTool();
    const created = parsePayload(
      await tool.execute("call-d1", { action: "create", task: "once", label: "once" }),
    );
    await tool.execute("call-d2", {
      action: "complete",
      task_id: created.task_id as string,
      outcome: "succeeded",
    });
    const second = parsePayload(
      await tool.execute("call-d3", {
        action: "complete",
        task_id: created.task_id as string,
        outcome: "blocked",
      }),
    );
    expect(second.status).toBe("already_terminal");
  });

  it("complete requires a valid outcome value", async () => {
    const tool = buildTool();
    const created = parsePayload(
      await tool.execute("call-e1", { action: "create", task: "x", label: "x" }),
    );
    await expect(
      tool.execute("call-e2", {
        action: "complete",
        task_id: created.task_id as string,
        outcome: "explosively",
      }),
    ).rejects.toThrow(/outcome/);
  });

  it("list_mine returns active and recent terminal tasks for the owner", async () => {
    const tool = buildTool();
    const a = parsePayload(
      await tool.execute("lm-1", { action: "create", task: "Active A", label: "a" }),
    );
    parsePayload(await tool.execute("lm-2", { action: "create", task: "Active B", label: "b" }));
    const c = parsePayload(
      await tool.execute("lm-3", { action: "create", task: "To complete", label: "c" }),
    );
    await tool.execute("lm-4", {
      action: "complete",
      task_id: c.task_id as string,
      outcome: "succeeded",
    });
    const list = parsePayload(await tool.execute("lm-5", { action: "list_mine" }));
    expect(list.status).toBe("ok");
    expect(list.active_count).toBe(2);
    expect(list.terminal_count).toBe(1);
    const tasks = list.tasks as Array<Record<string, unknown>>;
    expect(tasks.length).toBe(3);
    expect(tasks.some((t) => t.task_id === a.task_id)).toBe(true);
    expect(tasks.some((t) => t.task_id === c.task_id && t.status === "succeeded")).toBe(true);
  });

  it("list_mine with include_terminal=false drops terminal entries", async () => {
    const tool = buildTool();
    const c = parsePayload(
      await tool.execute("lm-it-1", { action: "create", task: "Completed", label: "ct" }),
    );
    await tool.execute("lm-it-2", {
      action: "complete",
      task_id: c.task_id as string,
      outcome: "succeeded",
    });
    parsePayload(await tool.execute("lm-it-3", { action: "create", task: "Active", label: "act" }));
    const list = parsePayload(
      await tool.execute("lm-it-4", { action: "list_mine", include_terminal: false }),
    );
    expect(list.active_count).toBe(1);
    expect(list.terminal_count).toBe(1);
    expect(list.returned_count).toBe(1);
    const tasks = list.tasks as Array<Record<string, unknown>>;
    expect(tasks.every((t) => t.status === "queued" || t.status === "running")).toBe(true);
  });

  it("list_mine status filter narrows to that status only", async () => {
    const tool = buildTool();
    await tool.execute("lf-1", { action: "create", task: "A", label: "a" });
    await tool.execute("lf-2", { action: "create", task: "B", label: "b" });
    const list = parsePayload(
      await tool.execute("lf-3", { action: "list_mine", status: "queued" }),
    );
    const tasks = list.tasks as Array<Record<string, unknown>>;
    expect(tasks.length).toBe(2);
    expect(tasks.every((t) => t.status === "queued")).toBe(true);
  });

  it("list_mine rejects an unknown status literal", async () => {
    const tool = buildTool();
    await expect(
      tool.execute("lf-x", { action: "list_mine", status: "almost_done" }),
    ).rejects.toThrow(/status/);
  });

  it("get returns full task detail for the owner's task", async () => {
    const tool = buildTool();
    const created = parsePayload(
      await tool.execute("g-1", { action: "create", task: "Look at me", label: "look" }),
    );
    const fetched = parsePayload(
      await tool.execute("g-2", { action: "get", task_id: created.task_id as string }),
    );
    expect(fetched.status).toBe("ok");
    const task = fetched.task as Record<string, unknown>;
    expect(task.task_id).toBe(created.task_id);
    expect(task.label).toBe("look");
    expect(task.runtime).toBe("agent");
  });

  it("get returns not_found for an unknown task id", async () => {
    const tool = buildTool();
    const payload = parsePayload(
      await tool.execute("g-nf", {
        action: "get",
        task_id: "00000000-0000-0000-0000-000000000000",
      }),
    );
    expect(payload.status).toBe("not_found");
  });

  it("get reads tasks created under a different ownerKey (global-owner convention)", async () => {
    // Pre-global-owner this returned status: "ownership_mismatch". Tasks are now visible
    // across owners on this install — see GLOBAL_OWNER_KEY in task-registry.types.ts.
    const otherTool = buildTool({ ownerKey: "agent:other:other", sessionKey: "agent:other:other" });
    const other = parsePayload(
      await otherTool.execute("om-1", { action: "create", task: "theirs", label: "theirs" }),
    );
    const myTool = buildTool();
    const payload = parsePayload(
      await myTool.execute("om-2", { action: "get", task_id: other.task_id as string }),
    );
    expect(payload.status).toBe("ok");
    expect((payload.task as { task_id: string }).task_id).toBe(other.task_id);
  });
});

describe("isAgentTasksToolEnabled", () => {
  it("returns true by default (tasks is the agent's central backlog)", () => {
    expect(isAgentTasksToolEnabled(undefined)).toBe(true);
    expect(isAgentTasksToolEnabled({})).toBe(true);
    expect(isAgentTasksToolEnabled({ tools: {} })).toBe(true);
    expect(isAgentTasksToolEnabled({ tools: { experimental: {} } })).toBe(true);
  });

  it("returns true when the experimental flag is explicitly set", () => {
    expect(isAgentTasksToolEnabled({ tools: { experimental: { agentTasks: true } } })).toBe(true);
  });

  it("returns false only when the flag is explicitly disabled", () => {
    expect(isAgentTasksToolEnabled({ tools: { experimental: { agentTasks: false } } })).toBe(false);
  });
});
