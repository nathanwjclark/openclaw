import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyBackwardChainPrefix,
  BACKWARD_CHAIN_PREFIX_MAX_LINE_CHARS,
  BACKWARD_CHAIN_PREFIX_MAX_NODES,
  buildBackwardChainPrefix,
} from "./backward-chain.js";
import { addNode, createGraph, updateNode } from "./registry.js";
import { closeExtrapolationStore } from "./store.sqlite.js";

beforeEach(() => {
  closeExtrapolationStore();
});

afterEach(() => {
  closeExtrapolationStore();
});

function seedGraph(overrides: Partial<Parameters<typeof createGraph>[0]> = {}) {
  return createGraph({
    rootRequest: "drive renewal for client X",
    ownerKey: `owner-${Math.random().toString(36).slice(2, 8)}`,
    sessionKey: `session-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "agent-test",
    now: 1_700_000_000_000,
    ...overrides,
  });
}

describe("buildBackwardChainPrefix", () => {
  it("returns undefined when the graph is missing", () => {
    expect(buildBackwardChainPrefix({ graphId: "no-such-graph" })).toBeUndefined();
  });

  it("returns undefined when the graph has no backward context and no ancestor chain", () => {
    const graph = seedGraph();
    const forward = addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "forward_branch",
      content: "do the thing",
    });
    expect(
      buildBackwardChainPrefix({ graphId: graph.graphId, nodeId: forward.nodeId }),
    ).toBeUndefined();
  });

  it("includes backward nodes and the source node when nodeId is provided", () => {
    const graph = seedGraph();
    addNode({
      graphId: graph.graphId,
      direction: "backward",
      kind: "purpose",
      content: "client X renewal closes the quarter",
      now: 1_700_000_000_001,
    });
    addNode({
      graphId: graph.graphId,
      direction: "backward",
      kind: "stakeholder",
      content: "Alex (procurement) is decision-maker",
      now: 1_700_000_000_002,
    });
    const forward = addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "forward_branch",
      content: "send renewal terms",
      now: 1_700_000_000_003,
    });
    const prefix = buildBackwardChainPrefix({ graphId: graph.graphId, nodeId: forward.nodeId });
    expect(prefix).toBeDefined();
    expect(prefix).toContain("client X renewal closes the quarter");
    expect(prefix).toContain("Alex (procurement)");
    expect(prefix).toContain("send renewal terms");
    expect(prefix).toContain("Root request: drive renewal for client X");
    expect(prefix).toMatch(/Original task:\s*$/);
  });

  it("orders backward nodes deterministically by createdAt then nodeId", () => {
    const graph = seedGraph();
    addNode({
      graphId: graph.graphId,
      direction: "backward",
      kind: "purpose",
      content: "older",
      now: 1_700_000_000_001,
    });
    addNode({
      graphId: graph.graphId,
      direction: "backward",
      kind: "role_context",
      content: "newer",
      now: 1_700_000_000_999,
    });
    const prefix = buildBackwardChainPrefix({ graphId: graph.graphId });
    expect(prefix).toBeDefined();
    const olderIdx = (prefix as string).indexOf("older");
    const newerIdx = (prefix as string).indexOf("newer");
    expect(olderIdx).toBeLessThan(newerIdx);
  });

  it("excludes pruned and invalidated backward nodes", () => {
    const graph = seedGraph();
    const dead = addNode({
      graphId: graph.graphId,
      direction: "backward",
      kind: "purpose",
      content: "stale framing",
      now: 1_700_000_000_001,
    });
    updateNode(dead.nodeId, { status: "invalidated", resolution: "reconsidered" });
    addNode({
      graphId: graph.graphId,
      direction: "backward",
      kind: "purpose",
      content: "live framing",
      now: 1_700_000_000_002,
    });
    const prefix = buildBackwardChainPrefix({ graphId: graph.graphId });
    expect(prefix).toContain("live framing");
    expect(prefix).not.toContain("stale framing");
  });

  it("walks the ancestor chain from nodeId via parentNodeId", () => {
    const graph = seedGraph();
    const parent = addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "forward_branch",
      content: "plan call",
      now: 1_700_000_000_001,
    });
    const child = addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "dependency",
      content: "draft slides for call",
      parentNodeId: parent.nodeId,
      now: 1_700_000_000_002,
    });
    const prefix = buildBackwardChainPrefix({ graphId: graph.graphId, nodeId: child.nodeId });
    expect(prefix).toContain("Ancestor");
    expect(prefix).toContain("plan call");
    expect(prefix).toContain("draft slides for call");
  });

  it("caps the number of backward nodes included", () => {
    const graph = seedGraph();
    for (let i = 0; i < BACKWARD_CHAIN_PREFIX_MAX_NODES + 3; i += 1) {
      addNode({
        graphId: graph.graphId,
        direction: "backward",
        kind: "stakeholder",
        content: `stakeholder ${i}`,
        now: 1_700_000_000_000 + i,
      });
    }
    const prefix = buildBackwardChainPrefix({ graphId: graph.graphId });
    expect(prefix).toBeDefined();
    const matches = (prefix as string).match(/stakeholder \d+/g) ?? [];
    expect(matches.length).toBe(BACKWARD_CHAIN_PREFIX_MAX_NODES);
  });

  it("truncates very long content per line", () => {
    const graph = seedGraph();
    const longContent = "x".repeat(BACKWARD_CHAIN_PREFIX_MAX_LINE_CHARS + 200);
    addNode({
      graphId: graph.graphId,
      direction: "backward",
      kind: "business_context",
      content: longContent,
    });
    const prefix = buildBackwardChainPrefix({ graphId: graph.graphId });
    expect(prefix).toBeDefined();
    for (const line of (prefix as string).split("\n")) {
      // Allow some slack for the leading "- Label: " bullet text.
      expect(line.length).toBeLessThanOrEqual(BACKWARD_CHAIN_PREFIX_MAX_LINE_CHARS + 50);
    }
  });
});

describe("applyBackwardChainPrefix", () => {
  it("returns the original task when no prefix can be built", () => {
    expect(applyBackwardChainPrefix("just do it", { graphId: "missing-graph" })).toBe("just do it");
  });

  it("prepends the prefix and preserves the original task body", () => {
    const graph = seedGraph();
    addNode({
      graphId: graph.graphId,
      direction: "backward",
      kind: "purpose",
      content: "annual renewal cycle",
    });
    const out = applyBackwardChainPrefix("send the renewal terms", { graphId: graph.graphId });
    expect(out).toContain("annual renewal cycle");
    expect(out.endsWith("send the renewal terms")).toBe(true);
    expect(out).toMatch(/Context from extrapolation graph/);
  });
});
