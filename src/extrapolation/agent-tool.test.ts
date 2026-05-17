import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtrapolationTool } from "./agent-tool.js";
import { promoteBackwardNodeIfReinforced } from "./durable-facts.js";
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

  it("injects durable facts into the seed prompt when memory config is enabled", async () => {
    const ownerKey = "owner-mem";
    const sessionKey = `session-mem-${Math.random().toString(36).slice(2, 8)}`;
    // Pre-seed two graphs in the same session so the canonical content has cross-graph reinforcement.
    for (let i = 0; i < 2; i += 1) {
      const g = createGraph({ rootRequest: "prior", ownerKey, sessionKey, agentId: "agent-test" });
      addNode({
        graphId: g.graphId,
        direction: "backward",
        kind: "purpose",
        content: "Ship renewals dashboard",
        confidence: 0.9,
        relevance: 0.7,
      });
    }
    const fact = promoteBackwardNodeIfReinforced({
      ownerKey,
      sessionKey,
      kind: "purpose",
      content: "Ship renewals dashboard",
      sourceGraphId: "external-trigger",
      threshold: 2,
    });
    expect(fact).toBeDefined();

    const callGateway = vi.fn().mockResolvedValue({ result: { payloads: [{ text: SEED_JSON }] } });
    const tool = createExtrapolationTool({
      agentId: "agent-test",
      ownerKey,
      sessionKey,
      callGateway,
      config: { extrapolation: { enabled: true } },
    });
    await run(tool, { action: "seed", request: "advance the renewals push" });
    const userPrompt = callGateway.mock.calls[0][0].params.message as string;
    expect(userPrompt).toContain("Established context");
    expect(userPrompt).toContain("ship renewals dashboard");
  });

  it("revokes a previously-promoted fact via revoke_fact", async () => {
    const ownerKey = "owner-revoke";
    const sessionKey = `session-revoke-${Math.random().toString(36).slice(2, 8)}`;
    for (let i = 0; i < 2; i += 1) {
      const g = createGraph({ rootRequest: "prior", ownerKey, sessionKey, agentId: "agent-test" });
      addNode({
        graphId: g.graphId,
        direction: "backward",
        kind: "stakeholder",
        content: "Legal team approval",
        confidence: 0.9,
        relevance: 0.7,
      });
    }
    const fact = promoteBackwardNodeIfReinforced({
      ownerKey,
      sessionKey,
      kind: "stakeholder",
      content: "Legal team approval",
      sourceGraphId: "external",
      threshold: 2,
    });
    expect(fact).toBeDefined();

    const tool = buildTool({ ownerKey, sessionKey });
    const { result } = await run(tool, {
      action: "revoke_fact",
      kind: "stakeholder",
      content: "Legal team approval",
      reason: "Legal was not actually involved",
    });
    const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.status).toBe("ok");
    expect(payload.fact_id).toBe(fact?.factId);

    // After revoke, the fact no longer surfaces.
    const after = await run(buildTool({ ownerKey, sessionKey }), {
      action: "revoke_fact",
      kind: "stakeholder",
      content: "Legal team approval",
    });
    const afterPayload = JSON.parse(
      (after.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(afterPayload.status).toBe("not_found");
  });

  it("revoke_fact rejects unknown kinds and missing content", async () => {
    const tool = buildTool();
    await expect(
      run(tool, { action: "revoke_fact", kind: "forward_branch", content: "anything" }),
    ).rejects.toThrow(/kind must be one of/);
    await expect(run(tool, { action: "revoke_fact", kind: "purpose" })).rejects.toThrow(/content/);
  });

  it("revoke_fact returns not_found when no matching fact exists", async () => {
    const sessionKey = `session-empty-${Math.random().toString(36).slice(2, 8)}`;
    const tool = buildTool({ sessionKey });
    const { result } = await run(tool, {
      action: "revoke_fact",
      kind: "purpose",
      content: "no such fact",
    });
    const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.status).toBe("not_found");
  });

  it("skips durable-fact injection when the master switch is off", async () => {
    const ownerKey = "owner-mem-off";
    const sessionKey = `session-mem-off-${Math.random().toString(36).slice(2, 8)}`;
    for (let i = 0; i < 2; i += 1) {
      const g = createGraph({ rootRequest: "prior", ownerKey, sessionKey, agentId: "agent-test" });
      addNode({
        graphId: g.graphId,
        direction: "backward",
        kind: "purpose",
        content: "Ship renewals dashboard",
        confidence: 0.9,
        relevance: 0.7,
      });
    }
    promoteBackwardNodeIfReinforced({
      ownerKey,
      sessionKey,
      kind: "purpose",
      content: "Ship renewals dashboard",
      sourceGraphId: "external-trigger",
      threshold: 2,
    });

    const callGateway = vi.fn().mockResolvedValue({ result: { payloads: [{ text: SEED_JSON }] } });
    const tool = createExtrapolationTool({
      agentId: "agent-test",
      ownerKey,
      sessionKey,
      callGateway,
      // No config => master switch defaults off
    });
    await run(tool, { action: "seed", request: "advance the renewals push" });
    const userPrompt = callGateway.mock.calls[0][0].params.message as string;
    expect(userPrompt).not.toContain("Established context");
  });
});

describe("extrapolation.materialize_forward_node", () => {
  function parsePayload(result: unknown): Record<string, unknown> {
    return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
  }

  it("creates a queued agent task linked to a forward node and marks the node promoted", async () => {
    const sessionKey = `session-${Math.random().toString(36).slice(2, 8)}`;
    const ownerKey = sessionKey;
    const tool = buildTool({ sessionKey, ownerKey });
    const graph = createGraph({
      rootRequest: "ship the upgrade audit",
      ownerKey,
      sessionKey,
      agentId: "agent-test",
    });
    const node = addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "forward_branch",
      content: "audit configuration changes across modules",
      confidence: 0.8,
      relevance: 0.9,
    });
    const { result } = await run(tool, {
      action: "materialize_forward_node",
      node_id: node.nodeId,
      label: "audit-config",
    });
    const payload = parsePayload(result);
    expect(payload.status).toBe("ok");
    expect(payload.node_status).toBe("promoted");
    expect(payload.graph_id).toBe(graph.graphId);
    expect(typeof payload.task_id).toBe("string");
  });

  it("uses the node content as the task description when no override is provided", async () => {
    const sessionKey = `session-${Math.random().toString(36).slice(2, 8)}`;
    const ownerKey = sessionKey;
    const tool = buildTool({ sessionKey, ownerKey });
    const graph = createGraph({
      rootRequest: "release planning",
      ownerKey,
      sessionKey,
      agentId: "agent-test",
    });
    const node = addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "dependency",
      content: "verify release notes are updated",
      confidence: 0.7,
      relevance: 0.8,
    });
    const { result } = await run(tool, {
      action: "materialize_forward_node",
      node_id: node.nodeId,
    });
    const payload = parsePayload(result);
    expect(payload.status).toBe("ok");
    const taskId = payload.task_id as string;
    const { getTaskById } = await import("../tasks/runtime-internal.js");
    const task = getTaskById(taskId);
    expect(task?.task).toBe("verify release notes are updated");
    expect(task?.extrapolationGraphId).toBe(graph.graphId);
    expect(task?.extrapolationNodeId).toBe(node.nodeId);
  });

  it("rejects materialization of backward nodes", async () => {
    const sessionKey = `session-${Math.random().toString(36).slice(2, 8)}`;
    const ownerKey = sessionKey;
    const tool = buildTool({ sessionKey, ownerKey });
    const graph = createGraph({
      rootRequest: "x",
      ownerKey,
      sessionKey,
      agentId: "agent-test",
    });
    const backwardNode = addNode({
      graphId: graph.graphId,
      direction: "backward",
      kind: "purpose",
      content: "the user wants X",
      confidence: 0.8,
      relevance: 0.9,
    });
    await expect(
      tool.execute("call-bad", {
        action: "materialize_forward_node",
        node_id: backwardNode.nodeId,
      }),
    ).rejects.toThrow(/not a forward node/);
  });

  it("returns already_promoted on a second call against the same node", async () => {
    const sessionKey = `session-${Math.random().toString(36).slice(2, 8)}`;
    const ownerKey = sessionKey;
    const tool = buildTool({ sessionKey, ownerKey });
    const graph = createGraph({
      rootRequest: "y",
      ownerKey,
      sessionKey,
      agentId: "agent-test",
    });
    const node = addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "contingency",
      content: "what if upstream is down",
      confidence: 0.6,
      relevance: 0.7,
    });
    const first = parsePayload(
      (await run(tool, { action: "materialize_forward_node", node_id: node.nodeId })).result,
    );
    const second = parsePayload(
      (await run(tool, { action: "materialize_forward_node", node_id: node.nodeId })).result,
    );
    expect(first.status).toBe("ok");
    expect(second.status).toBe("already_promoted");
    expect(second.task_id).toBe(first.task_id);
  });

  it("rejects when the node belongs to a graph owned by a different session", async () => {
    const owningSession = `session-${Math.random().toString(36).slice(2, 8)}`;
    const graph = createGraph({
      rootRequest: "z",
      ownerKey: owningSession,
      sessionKey: owningSession,
      agentId: "agent-test",
    });
    const node = addNode({
      graphId: graph.graphId,
      direction: "forward",
      kind: "forward_branch",
      content: "their work",
      confidence: 0.6,
      relevance: 0.7,
    });
    const foreignTool = buildTool({
      sessionKey: "other-session",
      ownerKey: "other-owner",
    });
    await expect(
      foreignTool.execute("call-foreign", {
        action: "materialize_forward_node",
        node_id: node.nodeId,
      }),
    ).rejects.toThrow(/different session/);
  });
});
