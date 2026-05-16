import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "./task-registry.types.js";

const { scheduleRevisionMock } = vi.hoisted(() => ({
  scheduleRevisionMock: vi.fn(),
}));

vi.mock("../extrapolation/revision.js", () => ({
  scheduleRevision: scheduleRevisionMock,
}));

const { warnMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
}));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    subsystem: "tasks/detached-runtime",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  }),
}));

// Imported after mocks so the runtime picks them up.
const {
  finalizeTaskRunByRunId,
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
  getDetachedTaskLifecycleRuntime,
} = await import("./detached-task-runtime.js");

function fakeTask(overrides?: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: "task-1",
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    runId: "run-1",
    task: "do the thing",
    status: "succeeded",
    deliveryStatus: "delivered",
    notifyPolicy: "done_only",
    createdAt: 1,
    ...overrides,
  };
}

function flushMicrotasks() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe("finalizeTaskRunByRunId — extrapolation hook", () => {
  beforeEach(() => {
    scheduleRevisionMock.mockReset();
    scheduleRevisionMock.mockResolvedValue({
      graphId: "g1",
      applied: true,
      addedCount: 0,
      resolvedCount: 0,
      invalidatedCount: 0,
      iteration: 0,
      heartbeatRequested: false,
    });
    warnMock.mockReset();
  });

  afterEach(() => {
    resetDetachedTaskLifecycleRuntimeForTests();
  });

  it("does not call scheduleRevision when the finalized task carries no graph id", () => {
    const task = fakeTask();
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      finalizeTaskRunByRunId: vi.fn(() => [task]),
    });
    finalizeTaskRunByRunId({ runId: "run-1", status: "succeeded", endedAt: 50 });
    expect(scheduleRevisionMock).not.toHaveBeenCalled();
  });

  it("fires scheduleRevision when the finalized task carries extrapolation ids", async () => {
    const task = fakeTask({
      extrapolationGraphId: "graph-abc",
      extrapolationNodeId: "node-xyz",
      childSessionKey: "agent:child:foo",
      terminalSummary: "all done",
    });
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      finalizeTaskRunByRunId: vi.fn(() => [task]),
    });
    finalizeTaskRunByRunId({
      runId: "run-1",
      status: "succeeded",
      endedAt: 50,
      terminalSummary: "all done",
    });
    expect(scheduleRevisionMock).toHaveBeenCalledTimes(1);
    const args = scheduleRevisionMock.mock.calls[0][0];
    expect(args.graphId).toBe("graph-abc");
    expect(args.nodeId).toBe("node-xyz");
    expect(args.evidence.status).toBe("succeeded");
    expect(args.evidence.terminalSummary).toBe("all done");
    expect(args.evidence.childSessionKey).toBe("agent:child:foo");
    expect(args.evidence.endedAt).toBe(50);
    expect(typeof args.callGateway).toBe("function");
    await flushMicrotasks();
  });

  it("forwards error and falls back to task fields when finalize params omit them", async () => {
    const task = fakeTask({
      extrapolationGraphId: "g2",
      terminalSummary: "task wrote summary",
      error: "underlying-error",
    });
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      finalizeTaskRunByRunId: vi.fn(() => [task]),
    });
    finalizeTaskRunByRunId({ runId: "run-1", status: "failed", endedAt: 99 });
    const args = scheduleRevisionMock.mock.calls[0][0];
    expect(args.evidence.terminalSummary).toBe("task wrote summary");
    expect(args.evidence.error).toBe("underlying-error");
    await flushMicrotasks();
  });

  it("does not propagate scheduleRevision failures back to the caller", async () => {
    scheduleRevisionMock.mockReset();
    scheduleRevisionMock.mockRejectedValue(new Error("revision boom"));
    const task = fakeTask({ extrapolationGraphId: "g3" });
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      finalizeTaskRunByRunId: vi.fn(() => [task]),
    });
    expect(() =>
      finalizeTaskRunByRunId({ runId: "run-1", status: "succeeded", endedAt: 10 }),
    ).not.toThrow();
    await flushMicrotasks();
    expect(warnMock).toHaveBeenCalled();
  });

  it("hooks all returned task records (e.g. when finalize bumps a parent task too)", async () => {
    const child = fakeTask({ taskId: "task-child", extrapolationGraphId: "graph-child" });
    const parent = fakeTask({ taskId: "task-parent", extrapolationGraphId: "graph-parent" });
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      finalizeTaskRunByRunId: vi.fn(() => [child, parent]),
    });
    finalizeTaskRunByRunId({ runId: "run-1", status: "succeeded", endedAt: 50 });
    expect(scheduleRevisionMock).toHaveBeenCalledTimes(2);
    const ids = scheduleRevisionMock.mock.calls.map((c) => String(c[0].graphId)).toSorted();
    expect(ids).toEqual(["graph-child", "graph-parent"]);
    await flushMicrotasks();
  });
});
