import { z } from "zod";
import { randomIdempotencyKey } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ExtrapolationNodeSeedSchema, type ExtrapolationNodeSeedInput } from "./types.js";

const log = createSubsystemLogger("extrapolation");

export type CallGatewayFn = (opts: {
  method: string;
  params?: unknown;
  expectFinal?: boolean;
  timeoutMs?: number;
}) => Promise<unknown>;

export type SeedInvocation = {
  rootRequest: string;
  agentId: string;
  ownerKey?: string;
  sessionKey?: string;
  /** Established facts injected at seed time when memory promotion is enabled. */
  durableFacts?: ReadonlyArray<{ kind: string; content: string }>;
  /** Optional model override; defaults to the agent's configured primary. */
  model?: string;
  provider?: string;
  abortSignal?: AbortSignal;
  /** Injected for tests; defaults to the real gateway call. */
  callGateway?: CallGatewayFn;
  /** Maximum nodes the seed pass is allowed to produce. */
  budgetNodes?: number;
  /** Per-call timeout for the model probe. Default 120s. */
  timeoutMs?: number;
};

export type SeedOutput = {
  nodes: ReadonlyArray<ExtrapolationNodeSeedInput>;
  summary: string;
};

const SEED_SYSTEM_PROMPT = `You are the structured-thinking pass for OpenClaw's extrapolation substrate.

Your job: given a complex user request, produce a graph of structured reasoning nodes that help the agent think before acting. You return ONLY JSON.

Output shape (one JSON object, no surrounding prose, no markdown fences):
{
  "summary": "<one sentence summarising the user's intent and what this graph captures>",
  "nodes": [
    { "direction": "forward" | "backward" | "lateral",
      "kind": "<kind>",
      "content": "<short statement>",
      "confidence": <0..1>,
      "relevance": <0..1>
    },
    ...
  ]
}

Kind taxonomy:
- forward + forward_branch | contingency | dependency
- backward + purpose | role_context | business_context | stakeholder
- lateral + gap | assumption | invalidator

Guidance:
- Backward nodes capture WHY the user is asking — purpose, role context, business context, stakeholders.
- Forward nodes capture POSSIBLE steps, contingencies, and dependencies.
- Lateral nodes capture missing context (gaps), load-bearing assumptions, and invalidators (conditions that would void the plan).
- Prefer fewer high-signal nodes over many low-signal ones.
- Set "confidence" to your belief the node is correct as stated; "relevance" to how much the node would change the agent's plan if true.
- Open gaps with relevance >= 0.6 will be surfaced to the agent; pick relevance deliberately.
- The "kind" must match its declared "direction" exactly.

Return strictly valid JSON. No additional fields, no comments, no trailing commas.`;

function buildUserPrompt(invocation: SeedInvocation, parseErrorHint?: string): string {
  const lines: string[] = [];
  lines.push(`Root request:\n${invocation.rootRequest.trim()}`);
  if (invocation.durableFacts && invocation.durableFacts.length > 0) {
    lines.push("");
    lines.push("Established context (from prior sessions):");
    for (const fact of invocation.durableFacts) {
      lines.push(`- (${fact.kind}) ${fact.content}`);
    }
  }
  const budget = invocation.budgetNodes ?? 50;
  lines.push("");
  lines.push(`Budget: produce up to ${budget} nodes total.`);
  if (parseErrorHint) {
    lines.push("");
    lines.push("Your previous attempt did not parse. Error from JSON+schema validation:");
    lines.push(parseErrorHint);
    lines.push("Return ONLY the corrected JSON object. No prose, no markdown.");
  }
  return lines.join("\n");
}

const SeedOutputSchema = z.object({
  summary: z.string().min(1),
  nodes: z.array(ExtrapolationNodeSeedSchema).min(1),
});

type GatewayAgentPayload = {
  text?: string;
};

type GatewayAgentResponse = {
  result?: {
    payloads?: ReadonlyArray<GatewayAgentPayload>;
  };
};

function extractText(response: unknown): string | undefined {
  const typed = response as GatewayAgentResponse | undefined;
  const payloads = typed?.result?.payloads;
  if (!payloads || payloads.length === 0) {
    return undefined;
  }
  for (const payload of payloads) {
    if (typeof payload.text === "string" && payload.text.trim()) {
      return payload.text.trim();
    }
  }
  return undefined;
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseSeedOutput(
  raw: string,
): { ok: true; value: SeedOutput } | { ok: false; error: string } {
  const stripped = stripCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `JSON parse failed: ${message}` };
  }
  const result = SeedOutputSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `schema validation failed: ${issues}` };
  }
  return { ok: true, value: result.data };
}

async function invokeSeedModel(
  invocation: SeedInvocation,
  callGateway: CallGatewayFn,
  userPrompt: string,
): Promise<string> {
  const startedAt = Date.now();
  const params: Record<string, unknown> = {
    agentId: invocation.agentId,
    message: userPrompt,
    systemPrompt: SEED_SYSTEM_PROMPT,
    modelRun: true,
    promptMode: "none",
    disableTools: true,
    idempotencyKey: randomIdempotencyKey(),
  };
  if (invocation.model) {
    params.model = invocation.model;
  }
  if (invocation.provider) {
    params.provider = invocation.provider;
  }
  const response = await callGateway({
    method: "agent",
    params,
    expectFinal: true,
    timeoutMs: invocation.timeoutMs ?? 120_000,
  });
  const text = extractText(response);
  if (!text) {
    throw new Error("extrapolation seed: gateway returned no text payload");
  }
  log.info("seed.model_call", {
    event: "seed.model_call",
    agentId: invocation.agentId,
    durationMs: Date.now() - startedAt,
    outputChars: text.length,
  });
  return text;
}

export async function runSeedPass(invocation: SeedInvocation): Promise<SeedOutput> {
  if (!invocation.callGateway) {
    throw new Error("extrapolation seed: callGateway must be provided");
  }
  const callGateway = invocation.callGateway;
  if (!invocation.rootRequest.trim()) {
    throw new Error("extrapolation seed: rootRequest is required");
  }
  if (!invocation.agentId.trim()) {
    throw new Error("extrapolation seed: agentId is required");
  }
  invocation.abortSignal?.throwIfAborted();

  const firstText = await invokeSeedModel(invocation, callGateway, buildUserPrompt(invocation));
  invocation.abortSignal?.throwIfAborted();
  const first = parseSeedOutput(firstText);
  if (first.ok) {
    return first.value;
  }
  log.info("seed.parse_error", {
    event: "seed.parse_error",
    agentId: invocation.agentId,
    attempt: 1,
    error: first.error,
  });

  // One automatic retry with the parse error as feedback.
  const retryText = await invokeSeedModel(
    invocation,
    callGateway,
    buildUserPrompt(invocation, first.error),
  );
  invocation.abortSignal?.throwIfAborted();
  const second = parseSeedOutput(retryText);
  if (second.ok) {
    return second.value;
  }
  log.info("seed.parse_error", {
    event: "seed.parse_error",
    agentId: invocation.agentId,
    attempt: 2,
    error: second.error,
  });
  throw new Error(
    `extrapolation seed: model output failed to parse after one retry. Last error: ${second.error}`,
  );
}
