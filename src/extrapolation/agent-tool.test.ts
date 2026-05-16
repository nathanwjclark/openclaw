import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtrapolationTool } from "./agent-tool.js";
import { addNode, createGraph, getGraph, getNodesForGraph } from "./registry.js";
import { closeExtrapolationStore } from "./store.sqlite.js";

beforeEach(() => {
  closeExtrapolationStore();
});

afterEach(() => {
  closeExtrapolationStore();
});

const SEED_JSON = JSON.stringify({
  summary: "renewal scoping",
  nodes: [
    {
      direction: "backward",
      kind: "purpose",
      content: "drive renewal",
      confidence: 0.8,
      relevance: 0.9,
    },
    {
      direction: "lateral",
      kind: "gap",
      content: "budget signal unknown",
      confidence: 0.5,
      relevance: 0.8,
    },
  ],
});

function buildTool(overrides: Partial<Parameters<typeof createExtrapolationTool>[0]> = {}) {
  return createExtrapolationTool({
    agentId: "agent-test",
    ownerKey: "owner-test",
    sessionKey: `session-${Math.random().toString(36).slice(2, 8)}`,
    callGateway: vi.fn().mockResolvedValue({ result: { payloads: [{ text: SEED_JSON }] } }),
    ...overrides,
  });
}

async function run(
  tool: ReturnType<typeof createExtrapolationTool>,
  args: Record<string, unknown>,
) {
  const result = await tool.execute("call-1", args);
  const text = typeof result === "object" && result && "content" in result ? "" : "";
  return { result, text };
}

describe("extrapolation agent tool", () => {
  it("seeds a graph from a request and persists the nodes", async () => {
    const sessionKey = `session-${Math.random().toString(36).slice(2, 8)}`;
    const tool = buildTool({ sessionKey });
    const { result } = await run(tool, {
      action: "seed",
      request: "advance the client engagement",
    });
    const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.status).toBe("ok");
    expect(payload.node_count).toBe(2);

    const graph = getGraph(payload.graph_id);
    expect(graph?.rootRequest).toBe("advance the client engagement");
    const nodes = getNodesForGraph(payload.graph_id);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.direction).toSorted()).toEqual(["backward", "lateral"]);
  });

  it("respects an explicit budget_nodes override", async () => {
    const tool = buildTool();
    const { result } = await run(tool, {
      action: "seed",
      request: "x",
      budget_nodes: 1,
    });
    const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.node_count).toBe(1);
    expect(payload.budget_nodes).toBe(1);
  });

  it("updates a node via patch", async () => {
    const graph = createGraph({
      rootRequest: "x",
      ownerKey: "owner",
      sessionKey: "session",
      agentId: "agent",
    });
    const node = addNode({
      graphId: graph.graphId,
      direction: "lateral",
      kind: "gap",
      content: "missing context",
    });
    const tool = buildTool();
    const { result } = await run(tool, {
      action: "update",
      node_id: node.nodeId,
      patch: { status: "resolved", resolution: "found in email" },
    });
    const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.status).toBe("ok");
    expect(payload.node.status).toBe("resolved");
    expect(payload.node.resolution).toBe("found in email");
  });

  it("closes a graph to resolved or abandoned", async () => {
    const graph = createGraph({
      rootRequest: "x",
      ownerKey: "owner",
      sessionKey: "session",
      agentId: "agent",
    });
    const tool = buildTool();
    const { result } = await run(tool, {
      action: "close",
      graph_id: graph.graphId,
      status: "resolved",
    });
    const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.graph.status).toBe("resolved");
  });

  it("revise returns not_implemented but validates graph existence", async () => {
    const tool = buildTool();
    await expect(run(tool, { action: "revise", graph_id: "no-such" })).rejects.toThrow(/not found/);

    const graph = createGraph({
      rootRequest: "x",
      ownerKey: "owner",
      sessionKey: "session",
      agentId: "agent",
    });
    const { result } = await run(tool, {
      action: "revise",
      graph_id: graph.graphId,
      evidence: { hello: "world" },
    });
    const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.status).toBe("not_implemented");
    expect(payload.graph_id).toBe(graph.graphId);
  });

  it("rejects unknown actions with a clear error", async () => {
    const tool = buildTool();
    await expect(run(tool, { action: "bogus" })).rejects.toThrow(/unknown action/);
  });

  it("rejects update without node_id", async () => {
    const tool = buildTool();
    await expect(run(tool, { action: "update", patch: { status: "resolved" } })).rejects.toThrow();
  });

  it("rejects update without a patch object", async () => {
    const tool = buildTool();
    await expect(run(tool, { action: "update", node_id: "x" })).rejects.toThrow(/patch.*object/);
  });

  it("close requires status: resolved | abandoned", async () => {
    const graph = createGraph({
      rootRequest: "x",
      ownerKey: "owner",
      sessionKey: "session",
      agentId: "agent",
    });
    const tool = buildTool();
    await expect(
      run(tool, { action: "close", graph_id: graph.graphId, status: "garbage" }),
    ).rejects.toThrow(/resolved.*abandoned/);
  });

  it("propagates the seed model parse error after one retry", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ result: { payloads: [{ text: "garbage" }] } })
      .mockResolvedValueOnce({ result: { payloads: [{ text: "also garbage" }] } });
    const tool = buildTool({ callGateway });
    await expect(run(tool, { action: "seed", request: "drive process forward" })).rejects.toThrow(
      /failed to parse/,
    );
  });

  it("forwards seed-model overrides from tool params", async () => {
    const callGateway = vi.fn().mockResolvedValue({ result: { payloads: [{ text: SEED_JSON }] } });
    const tool = buildTool({ callGateway });
    await run(tool, {
      action: "seed",
      request: "x",
      model: "gpt-5",
      provider: "openai",
    });
    const params = callGateway.mock.calls[0][0].params;
    expect(params.model).toBe("gpt-5");
    expect(params.provider).toBe("openai");
  });
});
