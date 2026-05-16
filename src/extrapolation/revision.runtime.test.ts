import { describe, expect, it, vi } from "vitest";
import { runRevisionPass, type RevisionInvocation } from "./revision.runtime.js";
import type { ExtrapolationGraphRecord, ExtrapolationNodeRecord } from "./types.js";

function payloadResponse(text: string) {
  return { result: { payloads: [{ text }] } };
}

function makeGraph(overrides: Partial<ExtrapolationGraphRecord> = {}): ExtrapolationGraphRecord {
  return {
    graphId: "graph-1",
    rootRequest: "drive client X engagement",
    ownerKey: "owner-1",
    sessionKey: "session-1",
    agentId: "agent-1",
    status: "active",
    iteration: 0,
    budgetNodes: 50,
    revisionToken: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeNode(overrides: Partial<ExtrapolationNodeRecord> = {}): ExtrapolationNodeRecord {
  return {
    nodeId: "node-1",
    graphId: "graph-1",
    direction: "lateral",
    kind: "gap",
    content: "client X budget signal unknown",
    confidence: 0.5,
    relevance: 0.9,
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const VALID = JSON.stringify({
  summary: "evidence reveals budget approved",
  added: [
    {
      direction: "forward",
      kind: "forward_branch",
      content: "send renewal terms",
      confidence: 0.7,
      relevance: 0.8,
    },
  ],
  resolved: [{ node_id: "node-1", resolution: "budget approved per Q2 email" }],
  invalidated: [],
});

function baseInvocation(overrides: Partial<RevisionInvocation> = {}): RevisionInvocation {
  return {
    graph: makeGraph(),
    nodes: [makeNode()],
    evidence: { status: "succeeded", terminalSummary: "Found Q2 approval email" },
    callGateway: vi.fn().mockResolvedValue(payloadResponse(VALID)),
    ...overrides,
  };
}

describe("runRevisionPass", () => {
  it("parses well-formed gateway output and returns a delta", async () => {
    const callGateway = vi.fn().mockResolvedValue(payloadResponse(VALID));
    const delta = await runRevisionPass(baseInvocation({ callGateway }));
    expect(delta.summary).toMatch(/budget approved/);
    expect(delta.added).toHaveLength(1);
    expect(delta.resolved).toEqual([
      { nodeId: "node-1", resolution: "budget approved per Q2 email" },
    ]);
    expect(delta.invalidated).toEqual([]);
    expect(callGateway).toHaveBeenCalledTimes(1);
    const args = callGateway.mock.calls[0][0];
    expect(args.method).toBe("agent");
    expect(args.params.modelRun).toBe(true);
    expect(args.params.promptMode).toBe("none");
    expect(args.params.agentId).toBe("agent-1");
    // Gateway rejects systemPrompt / disableTools. Format instructions are
    // inlined into `message`; modelRun:true disables tools internally.
    expect(args.params.systemPrompt).toBeUndefined();
    expect(args.params.disableTools).toBeUndefined();
    expect(args.params.message).toContain("revision pass");
  });

  it("strips markdown code fences before parsing", async () => {
    const fenced = "```json\n" + VALID + "\n```";
    const callGateway = vi.fn().mockResolvedValue(payloadResponse(fenced));
    const delta = await runRevisionPass(baseInvocation({ callGateway }));
    expect(delta.added).toHaveLength(1);
  });

  it("retries once on JSON parse failure with the error fed back to the model", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce(payloadResponse("not json"))
      .mockResolvedValueOnce(payloadResponse(VALID));
    const delta = await runRevisionPass(baseInvocation({ callGateway }));
    expect(delta.summary).toMatch(/budget approved/);
    expect(callGateway).toHaveBeenCalledTimes(2);
    const retryParams = callGateway.mock.calls[1][0].params;
    expect(retryParams.message).toContain("did not parse");
  });

  it("rejects deltas that reference unknown node ids and retries", async () => {
    const bogus = JSON.stringify({
      summary: "x",
      added: [],
      resolved: [{ node_id: "node-does-not-exist", resolution: "x" }],
      invalidated: [],
    });
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce(payloadResponse(bogus))
      .mockResolvedValueOnce(payloadResponse(VALID));
    const delta = await runRevisionPass(baseInvocation({ callGateway }));
    expect(delta.resolved).toHaveLength(1);
    expect(callGateway).toHaveBeenCalledTimes(2);
    const retryMessage = callGateway.mock.calls[1][0].params.message;
    expect(retryMessage).toContain("not found in graph");
  });

  it("retries once on schema-validation failure (bad kind for direction)", async () => {
    const bad = JSON.stringify({
      summary: "x",
      added: [
        { direction: "forward", kind: "purpose", content: "x" }, // kind mismatch
      ],
      resolved: [],
      invalidated: [],
    });
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce(payloadResponse(bad))
      .mockResolvedValueOnce(payloadResponse(VALID));
    const delta = await runRevisionPass(baseInvocation({ callGateway }));
    expect(delta.added).toHaveLength(1);
    expect(callGateway).toHaveBeenCalledTimes(2);
  });

  it("accepts a fully-empty delta", async () => {
    const empty = JSON.stringify({
      summary: "no change",
      added: [],
      resolved: [],
      invalidated: [],
    });
    const callGateway = vi.fn().mockResolvedValue(payloadResponse(empty));
    const delta = await runRevisionPass(baseInvocation({ callGateway }));
    expect(delta.added).toHaveLength(0);
    expect(delta.resolved).toHaveLength(0);
    expect(delta.invalidated).toHaveLength(0);
  });

  it("throws after a second parse failure", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce(payloadResponse("garbage"))
      .mockResolvedValueOnce(payloadResponse("still garbage"));
    await expect(runRevisionPass(baseInvocation({ callGateway }))).rejects.toThrow(
      /failed to parse after one retry/,
    );
  });

  it("throws when gateway returns no text payload", async () => {
    const callGateway = vi.fn().mockResolvedValue({ result: { payloads: [] } });
    await expect(runRevisionPass(baseInvocation({ callGateway }))).rejects.toThrow(
      /no text payload/,
    );
  });

  it("requires callGateway to be provided", async () => {
    await expect(
      runRevisionPass({
        graph: makeGraph(),
        nodes: [makeNode()],
        evidence: {},
      }),
    ).rejects.toThrow(/callGateway must be provided/);
  });

  it("propagates abort signals", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const callGateway = vi.fn().mockResolvedValue(payloadResponse(VALID));
    await expect(
      runRevisionPass(baseInvocation({ callGateway, abortSignal: ctrl.signal })),
    ).rejects.toThrow();
  });

  it("forwards optional model/provider overrides into gateway params", async () => {
    const callGateway = vi.fn().mockResolvedValue(payloadResponse(VALID));
    await runRevisionPass(baseInvocation({ callGateway, model: "gpt-5", provider: "openai" }));
    const args = callGateway.mock.calls[0][0];
    expect(args.params.model).toBe("gpt-5");
    expect(args.params.provider).toBe("openai");
  });
});
