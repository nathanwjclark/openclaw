import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addNode,
  bumpGraphIteration,
  createGraph,
  ExtrapolationConcurrencyError,
  ExtrapolationNotFoundError,
  getAuditForGraph,
  getGraph,
  getNodesForGraph,
  listGraphsByStatus,
  listGraphsForOwner,
  listGraphsForSession,
  transitionGraph,
  updateNode,
} from "./registry.js";
import { closeExtrapolationStore } from "./store.sqlite.js";

beforeEach(() => {
  closeExtrapolationStore();
});

afterEach(() => {
  closeExtrapolationStore();
});

function seed(overrides: Partial<Parameters<typeof createGraph>[0]> = {}) {
  return createGraph({
    rootRequest: "advance the client engagement",
    ownerKey: `owner-${Math.random().toString(36).slice(2, 8)}`,
    sessionKey: `session-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "agent-test",
    now: 1_700_000_000_000,
    ...overrides,
  });
}

describe("extrapolation registry", () => {
  it("creates a graph with seed audit at iteration 0", () => {
    const graph = seed();
    expect(graph.status).toBe("active");
    expect(graph.iteration).toBe(0);
    expect(graph.revisionToken).toBe(0);
    const audit = getAuditForGraph(graph.graphId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.kind).toBe("seed");
  });

  it("adds nodes only to active graphs and rejects kind/direction mismatch", () => {
    const graph = seed();
    addNode({
      graphId: graph.graphId,
      direction: "backward",
      kind: "purpose",
      content: "renewal",
      now: 1_700_000_000_001,
    });
    const nodes = getNodesForGraph(graph.graphId);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.status).toBe("open");

    expect(() =>
      addNode({
        graphId: graph.graphId,
        direction: "forward",
        kind: "purpose",
        content: "x",
      }),
    ).toThrow();

    transitionGraph({ graphId: graph.graphId, to: "resolved", now: 1_700_000_000_002 });
    expect(() =>
      addNode({
        graphId: graph.graphId,
        direction: "forward",
        kind: "forward_branch",
        content: "y",
      }),
    ).toThrow(/resolved graph/);
  });

  it("transitions active to resolved and records the audit row", () => {
    const graph = seed();
    const resolved = transitionGraph({
      graphId: graph.graphId,
      to: "resolved",
      now: 1_700_000_000_010,
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).toBe(1_700_000_000_010);
    expect(resolved.revisionToken).toBe(1);

    const audit = getAuditForGraph(graph.graphId);
    expect(audit.map((a) => a.kind)).toEqual(["seed", "state_transition"]);
  });

  it("rejects exits from terminal graph states", () => {
    const graph = seed();
    transitionGraph({ graphId: graph.graphId, to: "abandoned", reason: "test", now: 1 });
    expect(() => transitionGraph({ graphId: graph.graphId, to: "resolved" })).toThrow();
  });

  it("bumps iteration and revision token under optimistic concurrency", () => {
    const graph = seed();
    const after = bumpGraphIteration(graph.graphId, "revision", { added: 0 }, { now: 1 });
    expect(after.iteration).toBe(1);
    expect(after.revisionToken).toBe(1);
    expect(getGraph(graph.graphId)?.iteration).toBe(1);
  });

  it("surfaces ExtrapolationNotFoundError for missing ids", () => {
    expect(() => transitionGraph({ graphId: "nonexistent", to: "resolved" })).toThrow(
      ExtrapolationNotFoundError,
    );
    expect(() => updateNode("nonexistent", { status: "resolved" })).toThrow(
      ExtrapolationNotFoundError,
    );
  });

  it("updates a node status with validated transitions and stamps resolved_at", () => {
    const graph = seed();
    const node = addNode({
      graphId: graph.graphId,
      direction: "lateral",
      kind: "gap",
      content: "missing context",
      now: 1,
    });
    const promoted = updateNode(
      node.nodeId,
      { status: "promoted", promotedTaskId: "task-abc" },
      { now: 2 },
    );
    expect(promoted.status).toBe("promoted");
    expect(promoted.promotedTaskId).toBe("task-abc");

    const resolved = updateNode(
      node.nodeId,
      { status: "resolved", resolution: "found in email" },
      { now: 3 },
    );
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toBe("found in email");
    expect(resolved.resolvedAt).toBe(3);

    // open -> open after terminal is rejected by state machine
    expect(() => updateNode(node.nodeId, { status: "open" })).toThrow();
  });

  it("lists by session, owner, and status", () => {
    const a = seed({ ownerKey: "owner-x", sessionKey: "session-x" });
    const b = seed({ ownerKey: "owner-x", sessionKey: "session-x" });
    const c = seed({ ownerKey: "owner-y", sessionKey: "session-y" });
    transitionGraph({ graphId: b.graphId, to: "resolved", now: 100 });

    expect(
      listGraphsForSession("session-x")
        .map((g) => g.graphId)
        .toSorted(),
    ).toEqual([a.graphId, b.graphId].toSorted());
    expect(listGraphsForOwner("owner-y").map((g) => g.graphId)).toEqual([c.graphId]);
    const activeIds = listGraphsByStatus("active").map((g) => g.graphId);
    expect(activeIds).toContain(a.graphId);
    expect(activeIds).toContain(c.graphId);
    expect(activeIds).not.toContain(b.graphId);
  });

  it("ExtrapolationConcurrencyError is exported", () => {
    // Sanity: bumpGraphIteration's underlying optimistic concurrency error type is reachable.
    expect(ExtrapolationConcurrencyError.name).toBe("ExtrapolationConcurrencyError");
  });
});
