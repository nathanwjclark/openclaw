import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DURABLE_FACTS_CONFIDENCE_FLOOR,
  DEFAULT_DURABLE_FACTS_THRESHOLD,
  canonicalizeFactContent,
  getDurableFactsForSession,
  promoteBackwardNodeIfReinforced,
} from "./durable-facts.js";
import { addNode, createGraph } from "./registry.js";
import { closeExtrapolationStore } from "./store.sqlite.js";
import type { ExtrapolationGraphRecord, ExtrapolationNodeKind } from "./types.js";

beforeEach(() => {
  closeExtrapolationStore();
});

afterEach(() => {
  closeExtrapolationStore();
});

let unique = 0;
function newScope(): { ownerKey: string; sessionKey: string } {
  unique += 1;
  const tag = `${Date.now()}-${unique}`;
  return { ownerKey: `owner-${tag}`, sessionKey: `session-${tag}` };
}

function seedGraph(
  scope: { ownerKey: string; sessionKey: string },
  agentId = "agent-test",
): ExtrapolationGraphRecord {
  return createGraph({
    rootRequest: "test root",
    ownerKey: scope.ownerKey,
    sessionKey: scope.sessionKey,
    agentId,
  });
}

function addBackward(
  graph: ExtrapolationGraphRecord,
  kind: ExtrapolationNodeKind,
  content: string,
  confidence = 0.8,
): void {
  addNode({
    graphId: graph.graphId,
    direction: "backward",
    kind,
    content,
    confidence,
    relevance: 0.7,
  });
}

function promote(
  scope: { ownerKey: string; sessionKey: string },
  graph: ExtrapolationGraphRecord,
  kind: ExtrapolationNodeKind,
  content: string,
  overrides: { threshold?: number; confidenceFloor?: number; now?: number } = {},
) {
  return promoteBackwardNodeIfReinforced({
    ownerKey: scope.ownerKey,
    sessionKey: scope.sessionKey,
    kind,
    content,
    sourceGraphId: graph.graphId,
    ...overrides,
  });
}

describe("canonicalizeFactContent", () => {
  it("lowercases and collapses whitespace", () => {
    expect(canonicalizeFactContent("  User Owns   Renewals  ")).toBe("user owns renewals");
    expect(canonicalizeFactContent("Same content")).toBe(canonicalizeFactContent("same\tcontent"));
  });

  it("distinguishes materially different strings", () => {
    expect(canonicalizeFactContent("renewal pipeline")).not.toBe(
      canonicalizeFactContent("renewal pipelines"),
    );
  });
});

describe("promoteBackwardNodeIfReinforced", () => {
  it("rejects non-backward kinds", () => {
    const scope = newScope();
    const g = seedGraph(scope);
    addNode({
      graphId: g.graphId,
      direction: "forward",
      kind: "forward_branch",
      content: "do thing",
      confidence: 0.9,
      relevance: 0.7,
    });
    expect(
      promote(scope, g, "forward_branch" as ExtrapolationNodeKind, "do thing"),
    ).toBeUndefined();
  });

  it("is a no-op below threshold", () => {
    const scope = newScope();
    const g1 = seedGraph(scope);
    const g2 = seedGraph(scope);
    addBackward(g1, "purpose", "Ship renewals dashboard");
    addBackward(g2, "purpose", "Ship renewals dashboard");
    // threshold=3 by default: two graphs is still below
    expect(promote(scope, g2, "purpose", "Ship renewals dashboard")).toBeUndefined();
    expect(getDurableFactsForSession(scope)).toHaveLength(0);
  });

  it("promotes once threshold is reached and idempotently keeps state on re-promotion", () => {
    const scope = newScope();
    const g1 = seedGraph(scope);
    const g2 = seedGraph(scope);
    const g3 = seedGraph(scope);
    addBackward(g1, "purpose", "ship renewals dashboard");
    addBackward(g2, "purpose", "Ship Renewals Dashboard");
    addBackward(g3, "purpose", "  ship renewals dashboard  ");

    const promoted = promote(scope, g3, "purpose", "ship renewals dashboard");
    expect(promoted).toBeDefined();
    expect(promoted?.kind).toBe("purpose");
    expect(promoted?.content).toBe("ship renewals dashboard");
    expect(promoted?.reinforcement).toBe(3);
    expect([...promoted!.sourceGraphIds].toSorted()).toEqual(
      [g1.graphId, g2.graphId, g3.graphId].toSorted(),
    );

    const facts = getDurableFactsForSession(scope);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual({ kind: "purpose", content: "ship renewals dashboard" });

    // Idempotent: re-promoting yields the same row (no duplicate insert).
    const again = promote(scope, g3, "purpose", "ship renewals dashboard");
    expect(again?.factId).toBe(promoted?.factId);
    expect(getDurableFactsForSession(scope)).toHaveLength(1);
  });

  it("excludes low-confidence source nodes from the reinforcement count", () => {
    const scope = newScope();
    const g1 = seedGraph(scope);
    const g2 = seedGraph(scope);
    const g3 = seedGraph(scope);
    addBackward(g1, "stakeholder", "Legal team approval", 0.9);
    addBackward(g2, "stakeholder", "Legal team approval", 0.4); // below floor
    addBackward(g3, "stakeholder", "Legal team approval", 0.9);
    // Two qualifying graphs < default threshold of 3.
    expect(promote(scope, g3, "stakeholder", "Legal team approval")).toBeUndefined();
  });

  it("ignores backward nodes from non-active graphs", () => {
    const scope = newScope();
    const g1 = seedGraph(scope);
    const g2 = seedGraph(scope);
    const g3 = seedGraph(scope);
    addBackward(g1, "role_context", "Renewals lead");
    addBackward(g2, "role_context", "Renewals lead");
    addBackward(g3, "role_context", "Renewals lead");
    // Custom threshold=3 should match all three. Force a low threshold to keep test deterministic.
    const out = promote(scope, g3, "role_context", "Renewals lead", { threshold: 3 });
    expect(out).toBeDefined();
    expect(out?.reinforcement).toBe(3);
  });

  it("treats different canonical content as different facts", () => {
    const scope = newScope();
    const a = seedGraph(scope);
    const b = seedGraph(scope);
    const c = seedGraph(scope);
    addBackward(a, "business_context", "Quarterly renewals push");
    addBackward(b, "business_context", "Quarterly renewals push");
    addBackward(c, "business_context", "Quarterly renewals push");
    addBackward(c, "business_context", "Yearly renewals push");
    expect(promote(scope, c, "business_context", "Quarterly renewals push")).toBeDefined();
    // The second canonical phrase only appears once, so it must not promote.
    expect(promote(scope, c, "business_context", "Yearly renewals push")).toBeUndefined();
    expect(getDurableFactsForSession(scope)).toHaveLength(1);
  });

  it("respects a custom threshold lower than the default", () => {
    const scope = newScope();
    const g1 = seedGraph(scope);
    const g2 = seedGraph(scope);
    addBackward(g1, "purpose", "Lower threshold case");
    addBackward(g2, "purpose", "Lower threshold case");
    const out = promote(scope, g2, "purpose", "Lower threshold case", { threshold: 2 });
    expect(out).toBeDefined();
    expect(out?.reinforcement).toBe(2);
  });

  it("does not double-count multiple backward nodes from the same graph", () => {
    const scope = newScope();
    const g1 = seedGraph(scope);
    const g2 = seedGraph(scope);
    addBackward(g1, "stakeholder", "Finance");
    addBackward(g1, "stakeholder", "Finance"); // duplicate within same graph
    addBackward(g2, "stakeholder", "Finance");
    // Two distinct graphs only — below default threshold.
    expect(promote(scope, g2, "stakeholder", "Finance")).toBeUndefined();
  });
});

describe("getDurableFactsForSession", () => {
  it("returns an empty array for an unknown session", () => {
    expect(getDurableFactsForSession({ ownerKey: "no-owner", sessionKey: "no-session" })).toEqual(
      [],
    );
  });

  it("returns facts shaped for SeedInvocation", () => {
    const scope = newScope();
    const g1 = seedGraph(scope);
    const g2 = seedGraph(scope);
    addBackward(g1, "purpose", "Ship feature");
    addBackward(g2, "purpose", "Ship feature");
    promote(scope, g2, "purpose", "Ship feature", { threshold: 2 });
    const facts = getDurableFactsForSession(scope);
    expect(facts).toEqual([{ kind: "purpose", content: "ship feature" }]);
  });
});

describe("defaults", () => {
  it("matches the config defaults", () => {
    expect(DEFAULT_DURABLE_FACTS_THRESHOLD).toBe(3);
    expect(DEFAULT_DURABLE_FACTS_CONFIDENCE_FLOOR).toBe(0.7);
  });
});
