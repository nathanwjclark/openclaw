import { describe, expect, it, vi } from "vitest";
import { runSeedPass, type CallGatewayFn } from "./seed.runtime.js";

function payloadResponse(text: string) {
  return { result: { payloads: [{ text }] } };
}

const VALID_JSON = JSON.stringify({
  summary: "renewal-process exploration for client X",
  nodes: [
    {
      direction: "backward",
      kind: "purpose",
      content: "drive client X renewal",
      confidence: 0.8,
      relevance: 0.9,
    },
    {
      direction: "lateral",
      kind: "gap",
      content: "client X budget signal unknown",
      confidence: 0.5,
      relevance: 0.8,
    },
  ],
});

describe("runSeedPass", () => {
  it("parses well-formed gateway output and returns nodes", async () => {
    const callGateway = vi.fn().mockResolvedValue(payloadResponse(VALID_JSON));
    const output = await runSeedPass({
      rootRequest: "what do I need to do to drive client X forward?",
      agentId: "agent-alpha",
      callGateway,
    });
    expect(output.summary).toMatch(/renewal/);
    expect(output.nodes).toHaveLength(2);
    expect(callGateway).toHaveBeenCalledTimes(1);
    const args = callGateway.mock.calls[0][0];
    expect(args.method).toBe("agent");
    expect(args.params.modelRun).toBe(true);
    expect(args.params.promptMode).toBe("none");
    expect(args.params.disableTools).toBe(true);
    expect(args.params.agentId).toBe("agent-alpha");
  });

  it("strips markdown code fences before parsing", async () => {
    const fenced = "```json\n" + VALID_JSON + "\n```";
    const callGateway = vi.fn().mockResolvedValue(payloadResponse(fenced));
    const output = await runSeedPass({
      rootRequest: "x",
      agentId: "a",
      callGateway,
    });
    expect(output.nodes).toHaveLength(2);
  });

  it("retries once on JSON parse failure with the error fed back to the model", async () => {
    const callGateway: CallGatewayFn = vi
      .fn()
      .mockResolvedValueOnce(payloadResponse("not json at all"))
      .mockResolvedValueOnce(payloadResponse(VALID_JSON));
    const output = await runSeedPass({
      rootRequest: "x",
      agentId: "a",
      callGateway,
    });
    expect(output.nodes).toHaveLength(2);
    const mocked = callGateway as unknown as {
      mock: { calls: Array<[{ params: { message: string } }]> };
    };
    expect(mocked.mock.calls).toHaveLength(2);
    const retryParams = mocked.mock.calls[1][0].params;
    expect(retryParams.message).toContain("did not parse");
  });

  it("retries once on schema-validation failure", async () => {
    const bad = JSON.stringify({
      summary: "ok",
      nodes: [
        {
          direction: "forward",
          kind: "purpose", // mismatched kind/direction
          content: "x",
        },
      ],
    });
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce(payloadResponse(bad))
      .mockResolvedValueOnce(payloadResponse(VALID_JSON));
    const output = await runSeedPass({
      rootRequest: "x",
      agentId: "a",
      callGateway,
    });
    expect(output.nodes).toHaveLength(2);
    expect(callGateway).toHaveBeenCalledTimes(2);
  });

  it("throws after a second parse failure", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce(payloadResponse("garbage"))
      .mockResolvedValueOnce(payloadResponse("still garbage"));
    await expect(runSeedPass({ rootRequest: "x", agentId: "a", callGateway })).rejects.toThrow(
      /failed to parse after one retry/,
    );
  });

  it("throws when gateway returns no text payload", async () => {
    const callGateway = vi.fn().mockResolvedValue({ result: { payloads: [] } });
    await expect(runSeedPass({ rootRequest: "x", agentId: "a", callGateway })).rejects.toThrow(
      /no text payload/,
    );
  });

  it("requires callGateway to be provided", async () => {
    await expect(runSeedPass({ rootRequest: "x", agentId: "a" })).rejects.toThrow(
      /callGateway must be provided/,
    );
  });

  it("propagates abort signals", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const callGateway = vi.fn().mockResolvedValue(payloadResponse(VALID_JSON));
    await expect(
      runSeedPass({
        rootRequest: "x",
        agentId: "a",
        callGateway,
        abortSignal: ctrl.signal,
      }),
    ).rejects.toThrow();
  });

  it("forwards optional model/provider overrides into gateway params", async () => {
    const callGateway = vi.fn().mockResolvedValue(payloadResponse(VALID_JSON));
    await runSeedPass({
      rootRequest: "x",
      agentId: "a",
      model: "gpt-5",
      provider: "openai",
      callGateway,
    });
    const args = callGateway.mock.calls[0][0];
    expect(args.params.model).toBe("gpt-5");
    expect(args.params.provider).toBe("openai");
  });

  it("includes durable facts in the user prompt when supplied", async () => {
    const callGateway = vi.fn().mockResolvedValue(payloadResponse(VALID_JSON));
    await runSeedPass({
      rootRequest: "x",
      agentId: "a",
      callGateway,
      durableFacts: [{ kind: "role_context", content: "user owns the renewals pipeline" }],
    });
    const args = callGateway.mock.calls[0][0];
    expect(args.params.message).toContain("Established context");
    expect(args.params.message).toContain("user owns the renewals pipeline");
  });
});
