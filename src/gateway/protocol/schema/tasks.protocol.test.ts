import { describe, expect, it } from "vitest";
import { validateTasksCreateParams } from "../index.js";

describe("tasks.create protocol contract", () => {
  it("accepts a minimal payload an agent tool would send", () => {
    const params = {
      task: "Investigate the 2026.5.12 upgrade impact",
      ownerKey: "agent:main:main",
      sessionKey: "agent:main:main",
    };
    const ok = validateTasksCreateParams(params);
    expect(ok).toBe(true);
    expect(validateTasksCreateParams.errors).toBeFalsy();
  });

  it("accepts a fully populated payload including extrapolation linkage", () => {
    const params = {
      task: "Materialize forward branch from extrapolation node",
      ownerKey: "agent:main:main",
      sessionKey: "agent:main:main",
      agentId: "main",
      label: "fwd-materialize",
      taskKind: "follow-up",
      parentTaskId: "task-parent",
      parentFlowId: "flow-parent",
      notifyPolicy: "silent",
      extrapolationGraphId: "graph-abc",
      extrapolationNodeId: "node-xyz",
    };
    const ok = validateTasksCreateParams(params);
    expect(ok).toBe(true);
    expect(validateTasksCreateParams.errors).toBeFalsy();
  });

  it("rejects unknown properties so schema drift surfaces as a validation error", () => {
    const params = {
      task: "Valid task",
      ownerKey: "agent:main:main",
      sessionKey: "agent:main:main",
      systemPrompt: "this field does not exist on tasks.create",
    };
    const ok = validateTasksCreateParams(params);
    expect(ok).toBe(false);
    expect(JSON.stringify(validateTasksCreateParams.errors)).toContain("systemPrompt");
  });

  it("rejects payloads missing required ownership fields", () => {
    const params = {
      task: "Missing ownership",
    };
    const ok = validateTasksCreateParams(params);
    expect(ok).toBe(false);
  });

  it("rejects unsupported notifyPolicy values", () => {
    const params = {
      task: "Bad policy",
      ownerKey: "agent:main:main",
      sessionKey: "agent:main:main",
      notifyPolicy: "shout_loudly",
    };
    const ok = validateTasksCreateParams(params);
    expect(ok).toBe(false);
  });
});
