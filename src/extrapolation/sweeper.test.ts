import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDurableFactsForSession } from "./durable-facts.js";
import { addNode, bumpGraphIteration, createGraph, getGraph, transitionGraph } from "./registry.js";
import { closeExtrapolationStore } from "./store.sqlite.js";
import {
  DEFAULT_SWEEPER_MAX_ITERATIONS,
  DEFAULT_SWEEPER_ORPHAN_GRACE_MS,
  sweepExtrapolation,
} from "./sweeper.js";

beforeEach(() => {
  closeExtrapolationStore();
});

afterEach(() => {
  closeExtrapolationStore();
});

function seed(overrides: Partial<Parameters<typeof createGraph>[0]> = {}) {
  return createGraph({
    rootRequest: "test root",
    ownerKey: `owner-${Math.random().toString(36).slice(2, 8)}`,
    sessionKey: `session-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "agent-test",
    now: 1_700_000_000_000,
    ...overrides,
  });
}

describe("sweepExtrapolation", () => {
  it("returns empty arrays when no active graphs need action", () => {
    seed();
    const outcome = sweepExtrapolation({
      maxIterations: 1000,
      sessionExists: () => true,
    });
    // inspectedCount counts ALL active graphs (including any leaked from earlier tests),
    // so we only assert that nothing was abandoned this tick.
    expect(outcome.abandonedIterationCap).toEqual([]);
    expect(outcome.abandonedOrphaned).toEqual([]);
  });

  it("leaves graphs alone when below the iteration cap and session exists", () => {
    const graph = seed();
    const outcome = sweepExtrapolation({
      maxIterations: 5,
      sessionExists: () => true,
    });
    expect(outcome.abandonedIterationCap).not.toContain(graph.graphId);
    expect(outcome.abandonedOrphaned).not.toContain(graph.graphId);
    expect(getGraph(graph.graphId)?.status).toBe("active");
  });

  it("abandons graphs whose iteration exceeds the cap", () => {
    const graph = seed();
    for (let i = 0; i < 4; i += 1) {
      bumpGraphIteration(graph.graphId, "revision", { i }, { now: 1_700_000_000_000 + i });
    }
    const outcome = sweepExtrapolation({
      maxIterations: 2,
      sessionExists: () => true,
    });
    expect(outcome.abandonedIterationCap).toContain(graph.graphId);
    const after = getGraph(graph.graphId);
    expect(after?.status).toBe("abandoned");
    expect(after?.abandonedReason).toMatch(/iteration_cap_exceeded/);
  });

  it("respects the cap exactly (iteration === cap does not abandon)", () => {
    const graph = seed();
    bumpGraphIteration(graph.graphId, "revision", {}, { now: 1_700_000_000_001 });
    const outcome = sweepExtrapolation({
      maxIterations: 1,
      sessionExists: () => true,
    });
    expect(outcome.abandonedIterationCap).not.toContain(graph.graphId);
    expect(getGraph(graph.graphId)?.status).toBe("active");
  });

  it("exposes a sensible default iteration cap", () => {
    expect(DEFAULT_SWEEPER_MAX_ITERATIONS).toBeGreaterThan(0);
    const graph = seed();
    const outcome = sweepExtrapolation({ sessionExists: () => true });
    expect(outcome.abandonedIterationCap).not.toContain(graph.graphId);
    expect(getGraph(graph.graphId)?.status).toBe("active");
  });

  it("abandons orphaned graphs when sessionExists returns false and grace has elapsed", () => {
    const created = 1_700_000_000_000;
    const graph = seed({ now: created });
    const onlyThis = (key: string) => key !== graph.sessionKey;
    const at = created + DEFAULT_SWEEPER_ORPHAN_GRACE_MS + 1;
    const outcome = sweepExtrapolation({
      now: at,
      sessionExists: onlyThis,
    });
    expect(outcome.abandonedOrphaned).toContain(graph.graphId);
    const after = getGraph(graph.graphId);
    expect(after?.status).toBe("abandoned");
    expect(after?.abandonedReason).toBe("session_missing");
  });

  it("keeps fresh orphan candidates inside the grace window", () => {
    const created = 1_700_000_000_000;
    const graph = seed({ now: created });
    const onlyThis = (key: string) => key !== graph.sessionKey;
    const outcome = sweepExtrapolation({
      now: created + 1_000,
      sessionExists: onlyThis,
    });
    expect(outcome.abandonedOrphaned).not.toContain(graph.graphId);
    expect(getGraph(graph.graphId)?.status).toBe("active");
  });

  it("skips orphan detection entirely when sessionExists is not provided", () => {
    const graph = seed();
    const outcome = sweepExtrapolation({
      now: 1_800_000_000_000,
    });
    expect(outcome.abandonedOrphaned).not.toContain(graph.graphId);
    expect(getGraph(graph.graphId)?.status).toBe("active");
  });

  it("processes iteration-cap before orphan check (and skips orphan once abandoned)", () => {
    const created = 1_700_000_000_000;
    const graph = seed({ now: created });
    for (let i = 0; i < 15; i += 1) {
      bumpGraphIteration(graph.graphId, "revision", { i }, { now: created + i });
    }
    const outcome = sweepExtrapolation({
      now: created + DEFAULT_SWEEPER_ORPHAN_GRACE_MS + 1,
      maxIterations: 5,
      sessionExists: (key) => key !== graph.sessionKey,
    });
    expect(outcome.abandonedIterationCap).toContain(graph.graphId);
    expect(outcome.abandonedOrphaned).not.toContain(graph.graphId);
  });

  it("does not backfill durable facts when memory config is omitted", () => {
    const sharedOwner = `owner-${Math.random().toString(36).slice(2, 8)}`;
    const sharedSession = `session-${Math.random().toString(36).slice(2, 8)}`;
    const g1 = createGraph({
      rootRequest: "r",
      ownerKey: sharedOwner,
      sessionKey: sharedSession,
      agentId: "a",
    });
    const g2 = createGraph({
      rootRequest: "r",
      ownerKey: sharedOwner,
      sessionKey: sharedSession,
      agentId: "a",
    });
    const g3 = createGraph({
      rootRequest: "r",
      ownerKey: sharedOwner,
      sessionKey: sharedSession,
      agentId: "a",
    });
    for (const g of [g1, g2, g3]) {
      addNode({
        graphId: g.graphId,
        direction: "backward",
        kind: "purpose",
        content: "Backfill candidate",
        confidence: 0.9,
        relevance: 0.7,
      });
    }
    const outcome = sweepExtrapolation({ sessionExists: () => true });
    expect(outcome.factsBackfilledCount).toBe(0);
    expect(getDurableFactsForSession({ ownerKey: sharedOwner, sessionKey: sharedSession })).toEqual(
      [],
    );
  });

  it("backfills durable facts for active graphs when memory config enables it", () => {
    const sharedOwner = `owner-${Math.random().toString(36).slice(2, 8)}`;
    const sharedSession = `session-${Math.random().toString(36).slice(2, 8)}`;
    const g1 = createGraph({
      rootRequest: "r",
      ownerKey: sharedOwner,
      sessionKey: sharedSession,
      agentId: "a",
    });
    const g2 = createGraph({
      rootRequest: "r",
      ownerKey: sharedOwner,
      sessionKey: sharedSession,
      agentId: "a",
    });
    const g3 = createGraph({
      rootRequest: "r",
      ownerKey: sharedOwner,
      sessionKey: sharedSession,
      agentId: "a",
    });
    for (const g of [g1, g2, g3]) {
      addNode({
        graphId: g.graphId,
        direction: "backward",
        kind: "purpose",
        content: "Backfill candidate",
        confidence: 0.9,
        relevance: 0.7,
      });
    }
    const outcome = sweepExtrapolation({
      sessionExists: () => true,
      memory: { enabled: true, injectIntoSeed: true, threshold: 3, confidenceFloor: 0.7 },
    });
    expect(outcome.factsBackfilledCount).toBeGreaterThan(0);
    const facts = getDurableFactsForSession({ ownerKey: sharedOwner, sessionKey: sharedSession });
    expect(facts).toEqual([{ kind: "purpose", content: "backfill candidate" }]);
  });

  it("does not double-count facts when run twice in a row", () => {
    const sharedOwner = `owner-${Math.random().toString(36).slice(2, 8)}`;
    const sharedSession = `session-${Math.random().toString(36).slice(2, 8)}`;
    const g1 = createGraph({
      rootRequest: "r",
      ownerKey: sharedOwner,
      sessionKey: sharedSession,
      agentId: "a",
    });
    const g2 = createGraph({
      rootRequest: "r",
      ownerKey: sharedOwner,
      sessionKey: sharedSession,
      agentId: "a",
    });
    for (const g of [g1, g2]) {
      addNode({
        graphId: g.graphId,
        direction: "backward",
        kind: "purpose",
        content: "Repeatable backfill",
        confidence: 0.9,
        relevance: 0.7,
      });
    }
    const memory = { enabled: true, injectIntoSeed: true, threshold: 2, confidenceFloor: 0.7 };
    sweepExtrapolation({ sessionExists: () => true, memory });
    sweepExtrapolation({ sessionExists: () => true, memory });
    expect(
      getDurableFactsForSession({ ownerKey: sharedOwner, sessionKey: sharedSession }),
    ).toHaveLength(1);
  });

  it("ignores already-abandoned graphs", () => {
    const graph = seed();
    for (let i = 0; i < 6; i += 1) {
      bumpGraphIteration(graph.graphId, "revision", { i }, { now: 1_700_000_000_000 + i });
    }
    transitionGraph({ graphId: graph.graphId, to: "abandoned", reason: "manual" });
    const outcome = sweepExtrapolation({
      maxIterations: 2,
      sessionExists: () => true,
    });
    expect(outcome.abandonedIterationCap).not.toContain(graph.graphId);
    expect(outcome.abandonedOrphaned).not.toContain(graph.graphId);
  });
});
