import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promoteExtrapolationNodeAfterSpawn } from "./promotion.js";
import { addNode, createGraph, getGraph, getNode, transitionGraph } from "./registry.js";
import { closeExtrapolationStore } from "./store.sqlite.js";

beforeEach(() => {
  closeExtrapolationStore();
});

afterEach(() => {
  closeExtrapolationStore();
});

function seedGraph(overrides: Partial<Parameters<typeof createGraph>[0]> = {}) {
  return createGraph({
    rootRequest: "drive client X engagement",
    ownerKey: `owner-${Math.random().toString(36).slice(2, 8)}`,
    sessionKey: `session-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "agent-test",
    ...overrides,
  });
}

function makeForwardNode(graphId: string, content: string) {
  return addNode({
    graphId,
    direction: "forward",
    kind: "forward_branch",
    content,
  });
}

describe("promoteExtrapolationNodeAfterSpawn", () => {
  it("marks the source node promoted with task id and child session key on first promotion", async () => {
    const graph = seedGraph();
    const node = makeForwardNode(graph.graphId, "branch A");
    const linkTaskByRunIdToFlow = vi.fn();
    const createManagedFlow = vi.fn();
    const outcome = await promoteExtrapolationNodeAfterSpawn({
      graphId: graph.graphId,
      nodeId: node.nodeId,
      runId: "run-A",
      childSessionKey: "agent:child:A",
      linkTaskByRunIdToFlow,
      createManagedFlow,
    });
    expect(outcome.promoted).toBe(true);
    expect(outcome.promotionCount).toBe(1);
    expect(outcome.flowId).toBeUndefined();
    const after = getNode(node.nodeId);
    expect(after?.status).toBe("promoted");
    expect(after?.promotedTaskId).toBe("run-A");
    expect(after?.promotedChildSessionKey).toBe("agent:child:A");
    expect(createManagedFlow).not.toHaveBeenCalled();
    expect(linkTaskByRunIdToFlow).not.toHaveBeenCalled();
  });

  it("creates a managed flow and links both tasks on the second promotion in the same graph", async () => {
    const graph = seedGraph();
    const nodeA = makeForwardNode(graph.graphId, "branch A");
    const nodeB = makeForwardNode(graph.graphId, "branch B");
    const linkTaskByRunIdToFlow = vi.fn();
    const createManagedFlow = vi.fn().mockReturnValue("flow-1");

    await promoteExtrapolationNodeAfterSpawn({
      graphId: graph.graphId,
      nodeId: nodeA.nodeId,
      runId: "run-A",
      childSessionKey: "agent:child:A",
      linkTaskByRunIdToFlow,
      createManagedFlow,
    });
    expect(createManagedFlow).not.toHaveBeenCalled();

    const outcome = await promoteExtrapolationNodeAfterSpawn({
      graphId: graph.graphId,
      nodeId: nodeB.nodeId,
      runId: "run-B",
      childSessionKey: "agent:child:B",
      linkTaskByRunIdToFlow,
      createManagedFlow,
    });
    expect(outcome.promoted).toBe(true);
    expect(outcome.promotionCount).toBe(2);
    expect(outcome.flowId).toBe("flow-1");

    expect(createManagedFlow).toHaveBeenCalledTimes(1);
    const flowArgs = createManagedFlow.mock.calls[0][0];
    expect(flowArgs.goal).toBe(graph.rootRequest);
    expect(flowArgs.controllerId).toBe("core/extrapolation");
    expect(flowArgs.stateJson).toEqual({ extrapolation_graph_id: graph.graphId });
    expect(flowArgs.ownerKey).toBe(graph.ownerKey);

    expect(linkTaskByRunIdToFlow).toHaveBeenCalledTimes(2);
    const runIdsLinked = linkTaskByRunIdToFlow.mock.calls.map((c) => String(c[0].runId)).toSorted();
    expect(runIdsLinked).toEqual(["run-A", "run-B"]);

    const refreshed = getGraph(graph.graphId);
    expect(refreshed?.flowId).toBe("flow-1");
    expect(refreshed?.iteration).toBe(1);
  });

  it("3rd+ promotions stamp parent_flow_id directly without creating a new flow", async () => {
    const graph = seedGraph();
    const a = makeForwardNode(graph.graphId, "A");
    const b = makeForwardNode(graph.graphId, "B");
    const c = makeForwardNode(graph.graphId, "C");
    const linkTaskByRunIdToFlow = vi.fn();
    const createManagedFlow = vi.fn().mockReturnValue("flow-1");

    await promoteExtrapolationNodeAfterSpawn({
      graphId: graph.graphId,
      nodeId: a.nodeId,
      runId: "run-A",
      childSessionKey: "agent:child:A",
      linkTaskByRunIdToFlow,
      createManagedFlow,
    });
    await promoteExtrapolationNodeAfterSpawn({
      graphId: graph.graphId,
      nodeId: b.nodeId,
      runId: "run-B",
      childSessionKey: "agent:child:B",
      linkTaskByRunIdToFlow,
      createManagedFlow,
    });
    linkTaskByRunIdToFlow.mockClear();
    createManagedFlow.mockClear();

    const outcome = await promoteExtrapolationNodeAfterSpawn({
      graphId: graph.graphId,
      nodeId: c.nodeId,
      runId: "run-C",
      childSessionKey: "agent:child:C",
      linkTaskByRunIdToFlow,
      createManagedFlow,
    });
    expect(outcome.promotionCount).toBe(3);
    expect(outcome.flowId).toBe("flow-1");
    expect(createManagedFlow).not.toHaveBeenCalled();
    expect(linkTaskByRunIdToFlow).toHaveBeenCalledTimes(1);
    expect(linkTaskByRunIdToFlow.mock.calls[0][0]).toEqual({
      runId: "run-C",
      flowId: "flow-1",
    });
  });

  it("does nothing when the graph is missing", async () => {
    const outcome = await promoteExtrapolationNodeAfterSpawn({
      graphId: "no-such-graph",
      nodeId: "no-such-node",
      runId: "run-X",
      childSessionKey: "agent:child:X",
      linkTaskByRunIdToFlow: vi.fn(),
      createManagedFlow: vi.fn(),
    });
    expect(outcome.promoted).toBe(false);
    expect(outcome.skippedReason).toBe("graph_not_found");
  });

  it("does nothing when the graph is not active", async () => {
    const graph = seedGraph();
    const node = makeForwardNode(graph.graphId, "branch");
    transitionGraph({ graphId: graph.graphId, to: "abandoned", reason: "test" });
    const outcome = await promoteExtrapolationNodeAfterSpawn({
      graphId: graph.graphId,
      nodeId: node.nodeId,
      runId: "run-X",
      childSessionKey: "agent:child:X",
      linkTaskByRunIdToFlow: vi.fn(),
      createManagedFlow: vi.fn(),
    });
    expect(outcome.promoted).toBe(false);
    expect(outcome.skippedReason).toBe("graph_status_abandoned");
  });

  it("does nothing when the node already has a non-open status", async () => {
    const graph = seedGraph();
    const node = makeForwardNode(graph.graphId, "branch");
    const linkTaskByRunIdToFlow = vi.fn();
    const createManagedFlow = vi.fn();
    // First promotion succeeds.
    await promoteExtrapolationNodeAfterSpawn({
      graphId: graph.graphId,
      nodeId: node.nodeId,
      runId: "run-A",
      childSessionKey: "agent:child:A",
      linkTaskByRunIdToFlow,
      createManagedFlow,
    });
    // Second attempt on same node is a no-op.
    const outcome = await promoteExtrapolationNodeAfterSpawn({
      graphId: graph.graphId,
      nodeId: node.nodeId,
      runId: "run-B",
      childSessionKey: "agent:child:B",
      linkTaskByRunIdToFlow,
      createManagedFlow,
    });
    expect(outcome.promoted).toBe(false);
    expect(outcome.skippedReason).toBe("node_status_promoted");
  });

  it("rejects a node from a different graph", async () => {
    const graphA = seedGraph();
    const graphB = seedGraph();
    const nodeInB = makeForwardNode(graphB.graphId, "wrong graph");
    const outcome = await promoteExtrapolationNodeAfterSpawn({
      graphId: graphA.graphId,
      nodeId: nodeInB.nodeId,
      runId: "run-X",
      childSessionKey: "agent:child:X",
      linkTaskByRunIdToFlow: vi.fn(),
      createManagedFlow: vi.fn(),
    });
    expect(outcome.promoted).toBe(false);
    expect(outcome.skippedReason).toBe("node_not_found");
  });

  it("falls back to no-flow when createManagedFlow returns undefined", async () => {
    const graph = seedGraph();
    const a = makeForwardNode(graph.graphId, "A");
    const b = makeForwardNode(graph.graphId, "B");
    const linkTaskByRunIdToFlow = vi.fn();
    const createManagedFlow = vi.fn().mockReturnValue(undefined);

    await promoteExtrapolationNodeAfterSpawn({
      graphId: graph.graphId,
      nodeId: a.nodeId,
      runId: "run-A",
      childSessionKey: "agent:child:A",
      linkTaskByRunIdToFlow,
      createManagedFlow,
    });
    const outcome = await promoteExtrapolationNodeAfterSpawn({
      graphId: graph.graphId,
      nodeId: b.nodeId,
      runId: "run-B",
      childSessionKey: "agent:child:B",
      linkTaskByRunIdToFlow,
      createManagedFlow,
    });
    expect(outcome.flowId).toBeUndefined();
    expect(linkTaskByRunIdToFlow).not.toHaveBeenCalled();
    const refreshed = getGraph(graph.graphId);
    expect(refreshed?.flowId).toBeUndefined();
  });
});
