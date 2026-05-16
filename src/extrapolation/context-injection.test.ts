import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mergeExtraSystemPrompts,
  renderExtrapolationContext,
  renderExtrapolationContextForRun,
} from "./context-injection.js";
import { addNode, createGraph, transitionGraph, updateNode } from "./registry.js";
import { closeExtrapolationStore } from "./store.sqlite.js";

beforeEach(() => {
  closeExtrapolationStore();
});

afterEach(() => {
  closeExtrapolationStore();
});

function seedGraph(overrides: Partial<Parameters<typeof createGraph>[0]> = {}) {
  return createGraph({
    rootRequest: "drive process with client X",
    ownerKey: `owner-${Math.random().toString(36).slice(2, 8)}`,
    sessionKey: `session-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "agent-test",
    now: 1_700_000_000_000,
    ...overrides,
  });
}

describe("renderExtrapolationContext", () => {
  it("returns empty when no active graphs", () => {
    const result = renderExtrapolationContext({ sessionKey: "no-such-session" });
    expect(result.rendered).toBe("");
    expect(result.graphCount).toBe(0);
  });

  it("excludes graphs that are not active", () => {
    const graph = seedGraph();
    transitionGraph({ graphId: graph.graphId, to: "resolved", now: 1 });
    const result = renderExtrapolationContext({ sessionKey: graph.sessionKey });
    expect(result.rendered).toBe("");
    expect(result.graphCount).toBe(0);
  });

  it("renders backward, forward, gap, assumption, and invalidator sections", () => {
    const graph = seedGraph();
    addNode({
      graphId: graph.graphId,
      direction: "backward",
      kind: "purpose",
      content: "drive renewal of client X contract",
    });
    addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "forward_branch",
      content: "review last 3 emails from client X",
      relevance: 0.8,
    });
    addNode({
      graphId: graph.graphId,
      direction: "lateral",
      kind: "gap",
      content: "client X budget signal unknown",
      relevance: 0.9,
    });
    addNode({
      graphId: graph.graphId,
      direction: "lateral",
      kind: "assumption",
      content: "renewal is decided this quarter",
    });
    addNode({
      graphId: graph.graphId,
      direction: "lateral",
      kind: "invalidator",
      content: "client X has terminated the engagement",
    });

    const result = renderExtrapolationContext({ sessionKey: graph.sessionKey });
    expect(result.graphCount).toBe(1);
    expect(result.rendered).toContain("## Active extrapolation graphs");
    expect(result.rendered).toContain(
      "### Graph: drive process with client X [active, iteration 0]",
    );
    expect(result.rendered).toContain("**Purpose chain (backward):**");
    expect(result.rendered).toContain("**Forward branches:**");
    expect(result.rendered).toContain("**Open gaps");
    expect(result.rendered).toContain("client X budget signal unknown");
    expect(result.rendered).toContain("**Assumptions:**");
    expect(result.rendered).toContain("renewal is decided this quarter");
    expect(result.rendered).toContain("**Invalidators to watch:**");
    expect(result.rendered).toContain("terminated the engagement");
  });

  it("hides gaps below the configured relevance threshold", () => {
    const graph = seedGraph();
    addNode({
      graphId: graph.graphId,
      direction: "lateral",
      kind: "gap",
      content: "low-rel gap",
      relevance: 0.3,
    });
    addNode({
      graphId: graph.graphId,
      direction: "lateral",
      kind: "gap",
      content: "high-rel gap",
      relevance: 0.9,
    });
    const result = renderExtrapolationContext(
      { sessionKey: graph.sessionKey },
      { config: { extrapolation: { defaults: { gapRelevanceThreshold: 0.5 } } } },
    );
    expect(result.rendered).toContain("high-rel gap");
    expect(result.rendered).not.toContain("low-rel gap");
  });

  it("flags promoted forward nodes with task id and resolution text", () => {
    const graph = seedGraph();
    const node = addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "forward_branch",
      content: "investigate gmail thread",
    });
    updateNode(node.nodeId, { status: "promoted", promotedTaskId: "task-xyz" }, { now: 2 });
    updateNode(
      node.nodeId,
      { status: "resolved", resolution: "no signal in last 30 days" },
      { now: 3 },
    );
    const result = renderExtrapolationContext({ sessionKey: graph.sessionKey });
    expect(result.rendered).toContain("[resolved]");
    expect(result.rendered).toContain("no signal in last 30 days");
  });

  it("omits pruned nodes from rendering", () => {
    const graph = seedGraph();
    const node = addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "forward_branch",
      content: "obsolete branch",
    });
    updateNode(node.nodeId, { status: "pruned" }, { now: 2 });
    const result = renderExtrapolationContext({ sessionKey: graph.sessionKey });
    expect(result.rendered).not.toContain("obsolete branch");
  });
});

describe("renderExtrapolationContextForRun", () => {
  it("is empty when no sessionKey or agentId", () => {
    expect(renderExtrapolationContextForRun({}).rendered).toBe("");
    expect(renderExtrapolationContextForRun({ sessionKey: "x" }).rendered).toBe("");
    expect(renderExtrapolationContextForRun({ agentId: "x" }).rendered).toBe("");
  });

  it("is empty when extrapolation is disabled for the agent", () => {
    const graph = seedGraph({ agentId: "agent-off" });
    addNode({
      graphId: graph.graphId,
      direction: "lateral",
      kind: "gap",
      content: "should not appear",
      relevance: 0.9,
    });
    const result = renderExtrapolationContextForRun({
      sessionKey: graph.sessionKey,
      agentId: "agent-off",
      config: { extrapolation: { enabled: false } },
    });
    expect(result.rendered).toBe("");
  });

  it("renders when extrapolation is enabled for the agent", () => {
    const graph = seedGraph({ agentId: "agent-on" });
    addNode({
      graphId: graph.graphId,
      direction: "lateral",
      kind: "gap",
      content: "visible gap",
      relevance: 0.9,
    });
    const result = renderExtrapolationContextForRun({
      sessionKey: graph.sessionKey,
      agentId: "agent-on",
      config: { extrapolation: { enabled: true } },
    });
    expect(result.rendered).toContain("visible gap");
    expect(result.graphCount).toBe(1);
  });

  it("respects per-agent override on top of disabled master switch", () => {
    const graph = seedGraph({ agentId: "agent-override" });
    addNode({
      graphId: graph.graphId,
      direction: "lateral",
      kind: "gap",
      content: "override visible",
      relevance: 0.9,
    });
    const result = renderExtrapolationContextForRun({
      sessionKey: graph.sessionKey,
      agentId: "agent-override",
      config: {
        extrapolation: {
          enabled: false,
          perAgent: { "agent-override": { enabled: true } },
        },
      },
    });
    expect(result.rendered).toContain("override visible");
  });
});

describe("mergeExtraSystemPrompts", () => {
  it("returns undefined when all parts are empty", () => {
    expect(mergeExtraSystemPrompts(undefined, "", "  ")).toBeUndefined();
  });

  it("preserves a single non-empty part", () => {
    expect(mergeExtraSystemPrompts("only", undefined)).toBe("only");
  });

  it("joins multiple parts with a blank line", () => {
    expect(mergeExtraSystemPrompts("alpha", undefined, "beta")).toBe("alpha\n\nbeta");
  });
});
