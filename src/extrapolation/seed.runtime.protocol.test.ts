import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { AgentParamsSchema } from "../gateway/protocol/schema/agent.js";
import { runRevisionPass } from "./revision.runtime.js";
import { runSeedPass } from "./seed.runtime.js";
import type { ExtrapolationGraphRecord, ExtrapolationNodeRecord } from "./types.js";

/**
 * These tests guard the gateway-protocol contract for the seed and revision
 * model passes. The substrate's unit tests mock `callGateway`, so they never
 * caught Phase 2a's bug where seed.runtime.ts passed `systemPrompt` and
 * `disableTools` to a gateway `agent` method that rejects unknown properties
 * (`additionalProperties: false`). This file validates the call's params
 * against `AgentParamsSchema` directly.
 */

const VALID_SEED_JSON = JSON.stringify({
  summary: "x",
  nodes: [
    {
      direction: "backward",
      kind: "purpose",
      content: "y",
      confidence: 0.7,
      relevance: 0.7,
    },
  ],
});

const VALID_REVISION_JSON = JSON.stringify({
  summary: "x",
  added: [],
  resolved: [],
  invalidated: [],
});

function payloadResponse(text: string) {
  return { result: { payloads: [{ text }] } };
}

describe("seed.runtime + revision.runtime gateway protocol contract", () => {
  it("seed params validate against AgentParamsSchema", async () => {
    const callGateway = vi.fn().mockResolvedValue(payloadResponse(VALID_SEED_JSON));
    await runSeedPass({
      rootRequest: "anything",
      agentId: "agent-test",
      callGateway,
    });
    const params = callGateway.mock.calls[0][0].params;
    const errors = [...Value.Errors(AgentParamsSchema, params)];
    expect(errors).toEqual([]);
  });

  it("revision params validate against AgentParamsSchema", async () => {
    const callGateway = vi.fn().mockResolvedValue(payloadResponse(VALID_REVISION_JSON));
    const graph: ExtrapolationGraphRecord = {
      graphId: "g1",
      rootRequest: "root",
      ownerKey: "owner",
      sessionKey: "session",
      agentId: "agent-test",
      status: "active",
      iteration: 0,
      budgetNodes: 50,
      revisionToken: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const nodes: ExtrapolationNodeRecord[] = [];
    await runRevisionPass({
      graph,
      nodes,
      evidence: { status: "succeeded", terminalSummary: "ok" },
      callGateway,
    });
    const params = callGateway.mock.calls[0][0].params;
    const errors = [...Value.Errors(AgentParamsSchema, params)];
    expect(errors).toEqual([]);
  });
});
