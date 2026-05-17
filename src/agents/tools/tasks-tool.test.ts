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
});

describe("isAgentTasksToolEnabled", () => {
  it("returns false by default", () => {
    expect(isAgentTasksToolEnabled(undefined)).toBe(false);
    expect(isAgentTasksToolEnabled({})).toBe(false);
    expect(isAgentTasksToolEnabled({ tools: {} })).toBe(false);
    expect(isAgentTasksToolEnabled({ tools: { experimental: {} } })).toBe(false);
  });

  it("returns true when the experimental flag is explicitly set", () => {
    expect(isAgentTasksToolEnabled({ tools: { experimental: { agentTasks: true } } })).toBe(true);
  });

  it("returns false when the flag is explicitly disabled", () => {
    expect(isAgentTasksToolEnabled({ tools: { experimental: { agentTasks: false } } })).toBe(false);
  });
});
