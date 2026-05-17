import { describe, expect, it } from "vitest";
import {
  validateTasksCompleteParams,
  validateTasksCreateParams,
  validateTasksUpdateProgressParams,
} from "../index.js";

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

describe("tasks.updateProgress protocol contract", () => {
  it("accepts a valid payload", () => {
    const ok = validateTasksUpdateProgressParams({
      taskId: "task-1",
      ownerKey: "agent:main:main",
      progressSummary: "Pulled changelog; mapping deltas.",
    });
    expect(ok).toBe(true);
    expect(validateTasksUpdateProgressParams.errors).toBeFalsy();
  });

  it("rejects empty progressSummary", () => {
    const ok = validateTasksUpdateProgressParams({
      taskId: "task-1",
      ownerKey: "agent:main:main",
      progressSummary: "",
    });
    expect(ok).toBe(false);
  });

  it("rejects unknown properties", () => {
    const ok = validateTasksUpdateProgressParams({
      taskId: "task-1",
      ownerKey: "agent:main:main",
      progressSummary: "valid",
      status: "running",
    });
    expect(ok).toBe(false);
  });
});

describe("tasks.complete protocol contract", () => {
  it("accepts outcome=succeeded with a terminalSummary", () => {
    const ok = validateTasksCompleteParams({
      taskId: "task-1",
      ownerKey: "agent:main:main",
      outcome: "succeeded",
      terminalSummary: "Done.",
    });
    expect(ok).toBe(true);
    expect(validateTasksCompleteParams.errors).toBeFalsy();
  });

  it("accepts outcome=blocked without a terminalSummary", () => {
    const ok = validateTasksCompleteParams({
      taskId: "task-1",
      ownerKey: "agent:main:main",
      outcome: "blocked",
    });
    expect(ok).toBe(true);
  });

  it("rejects an unknown outcome", () => {
    const ok = validateTasksCompleteParams({
      taskId: "task-1",
      ownerKey: "agent:main:main",
      outcome: "cancelled",
    });
    expect(ok).toBe(false);
  });
});
