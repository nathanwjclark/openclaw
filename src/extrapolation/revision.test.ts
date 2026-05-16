import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addNode,
  createGraph,
  getNode,
  getNodesForGraph,
  transitionGraph,
  updateNode,
} from "./registry.js";
import { scheduleRevision } from "./revision.js";
import type { RevisionDelta } from "./revision.runtime.js";
import { closeExtrapolationStore } from "./store.sqlite.js";

beforeEach(() => {
  closeExtrapolationStore();
});

afterEach(() => {
  closeExtrapolationStore();
});

function seedGraph(overrides: Partial<Parameters<typeof createGraph>[0]> = {}) {
  return createGraph({
    rootRequest: "advance client X engagement",
    ownerKey: `owner-${Math.random().toString(36).slice(2, 8)}`,
    sessionKey: `session-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "agent-test",
    ...overrides,
  });
}

function emptyDelta(summary = "no change"): RevisionDelta {
  return { summary, added: [], resolved: [], invalidated: [] };
}

describe("scheduleRevision", () => {
  it("returns skipped when graph does not exist", async () => {
    const outcome = await scheduleRevision({
      graphId: "no-such-graph",
      evidence: { status: "succeeded" },
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.skippedReason).toBe("graph_not_found");
  });

  it("returns skipped when graph is not active", async () => {
    const graph = seedGraph();
    transitionGraph({ graphId: graph.graphId, to: "resolved" });
    const outcome = await scheduleRevision({
      graphId: graph.graphId,
      evidence: { status: "succeeded" },
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.skippedReason).toBe("graph_status_resolved");
  });

  it("copies terminal summary onto a promoted source node and resolves it on success", async () => {
    const graph = seedGraph();
    const node = addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "forward_branch",
      content: "investigate budget signal",
    });
    updateNode(node.nodeId, { status: "promoted", promotedTaskId: "task-xyz" });
    const outcome = await scheduleRevision({
      graphId: graph.graphId,
      nodeId: node.nodeId,
      evidence: {
        status: "succeeded",
        terminalSummary: "Q2 approval email found",
        childSessionKey: "agent:foo:bar",
      },
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.evidenceCopiedToNodeId).toBe(node.nodeId);
    const after = getNode(node.nodeId);
    expect(after?.status).toBe("resolved");
    expect(after?.resolution).toBe("Q2 approval email found");
    expect(after?.promotedChildSessionKey).toBe("agent:foo:bar");
  });

  it("leaves a promoted source node as promoted on failure but stamps the error", async () => {
    const graph = seedGraph();
    const node = addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "forward_branch",
      content: "search inbox",
    });
    updateNode(node.nodeId, { status: "promoted", promotedTaskId: "task-1" });
    await scheduleRevision({
      graphId: graph.graphId,
      nodeId: node.nodeId,
      evidence: { status: "failed", error: "rate limit", terminalSummary: "blocked by API quota" },
    });
    const after = getNode(node.nodeId);
    expect(after?.status).toBe("promoted");
    expect(after?.resolution).toContain("blocked by API quota");
    expect(after?.resolution).toContain("rate limit");
  });

  it("skips the model pass when neither callGateway nor runRevision is provided", async () => {
    const graph = seedGraph();
    const node = addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "forward_branch",
      content: "branch",
    });
    const fireHeartbeatWake = vi.fn();
    const outcome = await scheduleRevision({
      graphId: graph.graphId,
      nodeId: node.nodeId,
      evidence: { status: "succeeded", terminalSummary: "done" },
      fireHeartbeatWake,
    });
    expect(outcome.addedCount).toBe(0);
    expect(outcome.resolvedCount).toBe(0);
    expect(outcome.invalidatedCount).toBe(0);
    expect(outcome.heartbeatRequested).toBe(false);
    expect(fireHeartbeatWake).not.toHaveBeenCalled();
  });

  it("applies a delta from runRevision, bumps iteration, and fires heartbeat-wake", async () => {
    const graph = seedGraph();
    const gap = addNode({
      graphId: graph.graphId,
      direction: "lateral",
      kind: "gap",
      content: "client X budget unknown",
    });
    addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "forward_branch",
      content: "send renewal terms",
    });

    const runRevision = vi.fn().mockResolvedValue({
      summary: "budget confirmed",
      added: [
        {
          direction: "forward",
          kind: "dependency",
          content: "loop in legal",
          confidence: 0.6,
          relevance: 0.7,
        },
      ],
      resolved: [{ nodeId: gap.nodeId, resolution: "budget approved per Q2 email" }],
      invalidated: [],
    } satisfies RevisionDelta);
    const fireHeartbeatWake = vi.fn();

    const outcome = await scheduleRevision({
      graphId: graph.graphId,
      evidence: { status: "succeeded", terminalSummary: "Q2 approval located" },
      runRevision,
      fireHeartbeatWake,
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.addedCount).toBe(1);
    expect(outcome.resolvedCount).toBe(1);
    expect(outcome.iteration).toBe(1);
    expect(outcome.heartbeatRequested).toBe(true);
    expect(fireHeartbeatWake).toHaveBeenCalledTimes(1);
    const wakeArgs = fireHeartbeatWake.mock.calls[0][0];
    expect(wakeArgs.graphId).toBe(graph.graphId);
    expect(wakeArgs.sessionKey).toBe(graph.sessionKey);
    expect(wakeArgs.agentId).toBe(graph.agentId);

    const after = getNodesForGraph(graph.graphId);
    const resolvedGap = after.find((n) => n.nodeId === gap.nodeId);
    expect(resolvedGap?.status).toBe("resolved");
    expect(resolvedGap?.resolution).toBe("budget approved per Q2 email");
    expect(after.some((n) => n.kind === "dependency" && n.content === "loop in legal")).toBe(true);
  });

  it("does not fire heartbeat-wake on an empty delta", async () => {
    const graph = seedGraph();
    const runRevision = vi.fn().mockResolvedValue(emptyDelta());
    const fireHeartbeatWake = vi.fn();
    const outcome = await scheduleRevision({
      graphId: graph.graphId,
      evidence: { status: "succeeded" },
      runRevision,
      fireHeartbeatWake,
    });
    expect(outcome.heartbeatRequested).toBe(false);
    expect(outcome.iteration).toBe(0);
    expect(fireHeartbeatWake).not.toHaveBeenCalled();
  });

  it("never throws when runRevision fails — best-effort enrichment only", async () => {
    const graph = seedGraph();
    const node = addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "forward_branch",
      content: "branch",
    });
    const runRevision = vi.fn().mockRejectedValue(new Error("model timed out"));
    const fireHeartbeatWake = vi.fn();
    const outcome = await scheduleRevision({
      graphId: graph.graphId,
      nodeId: node.nodeId,
      evidence: { status: "succeeded", terminalSummary: "ok" },
      runRevision,
      fireHeartbeatWake,
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.addedCount).toBe(0);
    expect(fireHeartbeatWake).not.toHaveBeenCalled();
  });

  it("clips added nodes to the remaining budget", async () => {
    const graph = seedGraph({ budgetNodes: 2 });
    addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "forward_branch",
      content: "first",
    });
    const runRevision = vi.fn().mockResolvedValue({
      summary: "many adds",
      added: [
        {
          direction: "forward",
          kind: "forward_branch",
          content: "second",
          confidence: 0.5,
          relevance: 0.5,
        },
        {
          direction: "forward",
          kind: "forward_branch",
          content: "third",
          confidence: 0.5,
          relevance: 0.5,
        },
      ],
      resolved: [],
      invalidated: [],
    } satisfies RevisionDelta);
    const outcome = await scheduleRevision({
      graphId: graph.graphId,
      evidence: { status: "succeeded" },
      runRevision,
      fireHeartbeatWake: vi.fn(),
    });
    expect(outcome.addedCount).toBe(1);
    expect(getNodesForGraph(graph.graphId)).toHaveLength(2);
  });

  it("handles a missing source nodeId gracefully", async () => {
    const graph = seedGraph();
    const outcome = await scheduleRevision({
      graphId: graph.graphId,
      nodeId: "node-does-not-exist",
      evidence: { status: "succeeded" },
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.evidenceCopiedToNodeId).toBeUndefined();
  });
});
