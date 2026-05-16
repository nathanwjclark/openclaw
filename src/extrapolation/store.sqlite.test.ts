import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeExtrapolationStore,
  insertAuditRecord,
  insertFactRecord,
  insertGraphRecord,
  insertNodeRecord,
  selectAuditByGraph,
  selectFactByHash,
  selectFactsBySession,
  selectGraphById,
  selectGraphsByOwner,
  selectGraphsBySession,
  selectGraphsByStatus,
  selectNodeById,
  selectNodesByGraph,
  updateFactRecord,
  updateGraphRecord,
  updateNodeRecord,
} from "./store.sqlite.js";
import type {
  ExtrapolationGraphRecord,
  ExtrapolationNodeRecord,
  SessionDurableFactRecord,
} from "./types.js";

function fakeGraph(overrides: Partial<ExtrapolationGraphRecord> = {}): ExtrapolationGraphRecord {
  return {
    graphId: `graph-${Math.random().toString(36).slice(2, 10)}`,
    rootRequest: "drive process forward with client",
    ownerKey: "owner-alpha",
    sessionKey: "session-alpha-main",
    agentId: "agent-alpha",
    status: "active",
    iteration: 0,
    budgetNodes: 50,
    revisionToken: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function fakeNode(
  graphId: string,
  overrides: Partial<ExtrapolationNodeRecord> = {},
): ExtrapolationNodeRecord {
  return {
    nodeId: `node-${Math.random().toString(36).slice(2, 10)}`,
    graphId,
    direction: "forward",
    kind: "forward_branch",
    content: "investigate gmail thread",
    confidence: 0.6,
    relevance: 0.8,
    status: "open",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function fakeFact(overrides: Partial<SessionDurableFactRecord> = {}): SessionDurableFactRecord {
  return {
    factId: `fact-${Math.random().toString(36).slice(2, 10)}`,
    ownerKey: "owner-alpha",
    sessionKey: "session-alpha-main",
    kind: "role_context",
    content: "user owns the customer-success pipeline",
    contentHash: "hash-1",
    confidence: 0.8,
    reinforcement: 1,
    sourceGraphIds: ["graph-1"],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  closeExtrapolationStore();
});

afterEach(() => {
  closeExtrapolationStore();
});

describe("extrapolation sqlite store", () => {
  it("round-trips a graph and its nodes", () => {
    const graph = fakeGraph();
    insertGraphRecord(graph);
    const nodeA = fakeNode(graph.graphId, { kind: "purpose", direction: "backward" });
    const nodeB = fakeNode(graph.graphId, { kind: "gap", direction: "lateral" });
    insertNodeRecord(nodeA);
    insertNodeRecord(nodeB);

    expect(selectGraphById(graph.graphId)).toEqual(graph);
    const nodes = selectNodesByGraph(graph.graphId)
      .map((n) => n.nodeId)
      .toSorted();
    expect(nodes).toEqual([nodeA.nodeId, nodeB.nodeId].toSorted());
    expect(selectNodeById(nodeA.nodeId)).toMatchObject({ kind: "purpose" });
  });

  it("enforces optimistic concurrency on graph updates", () => {
    const graph = fakeGraph();
    insertGraphRecord(graph);

    const bumped = { ...graph, iteration: 1, revisionToken: 1, updatedAt: graph.updatedAt + 1 };
    expect(updateGraphRecord(bumped, 0)).toBe(true);
    expect(selectGraphById(graph.graphId)?.iteration).toBe(1);

    // Same expected token must fail now that revision has advanced.
    expect(updateGraphRecord({ ...bumped, iteration: 2 }, 0)).toBe(false);
    expect(selectGraphById(graph.graphId)?.iteration).toBe(1);
  });

  it("filters by session_key, owner_key, and status", () => {
    const g1 = fakeGraph({ sessionKey: "session-a", ownerKey: "owner-a", status: "active" });
    const g2 = fakeGraph({ sessionKey: "session-a", ownerKey: "owner-a", status: "resolved" });
    const g3 = fakeGraph({ sessionKey: "session-b", ownerKey: "owner-b", status: "active" });
    insertGraphRecord(g1);
    insertGraphRecord(g2);
    insertGraphRecord(g3);

    expect(
      selectGraphsBySession("session-a")
        .map((g) => g.graphId)
        .toSorted(),
    ).toEqual([g1.graphId, g2.graphId].toSorted());
    expect(selectGraphsByOwner("owner-b").map((g) => g.graphId)).toEqual([g3.graphId]);
    const activeFromThisTest = selectGraphsByStatus("active")
      .filter((g) => g.ownerKey === "owner-a" || g.ownerKey === "owner-b")
      .map((g) => g.graphId)
      .toSorted();
    expect(activeFromThisTest).toEqual([g1.graphId, g3.graphId].toSorted());
  });

  it("appends audit records in time order", () => {
    const graph = fakeGraph();
    insertGraphRecord(graph);
    insertAuditRecord({
      graphId: graph.graphId,
      iteration: 0,
      at: 1,
      kind: "seed",
      contentJson: '{"n":1}',
    });
    insertAuditRecord({
      graphId: graph.graphId,
      iteration: 1,
      at: 2,
      kind: "revision",
      contentJson: '{"n":2}',
    });
    const rows = selectAuditByGraph(graph.graphId);
    expect(rows.map((r) => r.kind)).toEqual(["seed", "revision"]);
    expect(rows[0]?.auditId).toBeTypeOf("number");
  });

  it("upserts session durable facts with hash uniqueness scoped to session", () => {
    const fact = fakeFact();
    insertFactRecord(fact);
    expect(selectFactByHash(fact.sessionKey, fact.contentHash)?.factId).toBe(fact.factId);

    // Same hash, different session, allowed.
    const other = fakeFact({ sessionKey: "session-other", contentHash: "hash-1" });
    insertFactRecord(other);
    expect(selectFactsBySession(fact.ownerKey, fact.sessionKey)).toHaveLength(1);

    // Same hash, same session, must fail due to unique index.
    expect(() => insertFactRecord(fakeFact({ contentHash: "hash-1" }))).toThrow();

    // Revoking allows reinsertion under the partial unique index.
    updateFactRecord({ ...fact, revokedAt: 1_700_000_999_000, updatedAt: 1_700_000_999_000 });
    expect(() => insertFactRecord(fakeFact({ contentHash: "hash-1" }))).not.toThrow();
  });

  it("updates node fields without losing earlier columns", () => {
    const graph = fakeGraph();
    insertGraphRecord(graph);
    const node = fakeNode(graph.graphId);
    insertNodeRecord(node);
    updateNodeRecord({
      ...node,
      status: "resolved",
      resolution: "answer found in thread #42",
      resolvedAt: 1_700_000_111_111,
      updatedAt: 1_700_000_111_111,
    });
    const reloaded = selectNodeById(node.nodeId);
    expect(reloaded?.status).toBe("resolved");
    expect(reloaded?.resolution).toBe("answer found in thread #42");
    expect(reloaded?.kind).toBe("forward_branch");
    expect(reloaded?.content).toBe("investigate gmail thread");
  });
});
