import { z } from "zod";
import { randomIdempotencyKey } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { CallGatewayFn } from "./seed.runtime.js";
import {
  ExtrapolationNodeSeedSchema,
  type ExtrapolationGraphRecord,
  type ExtrapolationNodeRecord,
  type ExtrapolationNodeSeedInput,
} from "./types.js";

const log = createSubsystemLogger("extrapolation");

export type RevisionInvocation = {
  graph: ExtrapolationGraphRecord;
  nodes: ReadonlyArray<ExtrapolationNodeRecord>;
  evidence: unknown;
  /** Optional model override; defaults to the agent's configured primary. */
  model?: string;
  provider?: string;
  abortSignal?: AbortSignal;
  /** Injected for tests; defaults to the real gateway call. */
  callGateway?: CallGatewayFn;
  /** Per-call timeout for the model probe. Default 120s. */
  timeoutMs?: number;
};

export type RevisionDelta = {
  added: ReadonlyArray<ExtrapolationNodeSeedInput>;
  resolved: ReadonlyArray<{ nodeId: string; resolution: string }>;
  invalidated: ReadonlyArray<{ nodeId: string; reason: string }>;
  summary: string;
};

const REVISION_SYSTEM_PROMPT = `You are the revision pass for OpenClaw's extrapolation substrate.

You are given an existing reasoning graph and new evidence (typically a task terminal summary). Your job: decide which existing open nodes are now resolved or invalidated, and what new nodes (if any) the evidence implies. You return ONLY JSON.

Output shape (one JSON object, no surrounding prose, no markdown fences):
{
  "summary": "<one sentence describing what changed>",
  "added": [
    { "direction": "forward" | "backward" | "lateral",
      "kind": "<kind>",
      "content": "<short statement>",
      "confidence": <0..1>,
      "relevance": <0..1>
    },
    ...
  ],
  "resolved": [
    { "node_id": "<existing node id>", "resolution": "<short text>" }
  ],
  "invalidated": [
    { "node_id": "<existing node id>", "reason": "<short text>" }
  ]
}

Kind taxonomy (must match its direction):
- forward + forward_branch | contingency | dependency
- backward + purpose | role_context | business_context | stakeholder
- lateral + gap | assumption | invalidator

Guidance:
- Reference existing nodes only by their exact node_id from the supplied list. Do not invent ids.
- Be conservative: do not mark nodes resolved unless the evidence directly addresses them.
- Prefer marking a gap "resolved" with the discovered answer over adding a new node restating that answer.
- Only add a node if the evidence reveals a new branch, dependency, gap, assumption, or invalidator not already in the graph.
- Empty arrays are valid: { "added": [], "resolved": [], "invalidated": [] } is a fine answer.
- The "kind" must match its declared "direction" exactly.
- Return strictly valid JSON. No additional fields, no comments, no trailing commas.`;

function renderNodes(nodes: ReadonlyArray<ExtrapolationNodeRecord>): string {
  if (nodes.length === 0) {
    return "(no nodes)";
  }
  return nodes
    .map((n) => {
      const status = n.status === "open" ? "" : ` [${n.status}]`;
      return `- ${n.nodeId} (${n.direction}/${n.kind})${status}: ${n.content}`;
    })
    .join("\n");
}

function buildUserPrompt(invocation: RevisionInvocation, parseErrorHint?: string): string {
  const { graph, nodes, evidence } = invocation;
  // The gateway's agent method does not accept a systemPrompt param under the
  // raw-model-run path. Inline the revision format instructions into the user
  // message itself.
  const lines: string[] = [REVISION_SYSTEM_PROMPT, "", "---", ""];
  lines.push(`Root request:\n${graph.rootRequest}`);
  lines.push("");
  lines.push(`Graph state: iteration ${graph.iteration}, status ${graph.status}.`);
  lines.push("");
  lines.push("Existing nodes:");
  lines.push(renderNodes(nodes));
  lines.push("");
  lines.push("New evidence (JSON):");
  lines.push(JSON.stringify(evidence, null, 2));
  if (parseErrorHint) {
    lines.push("");
    lines.push("Your previous attempt did not parse. Error from JSON+schema validation:");
    lines.push(parseErrorHint);
    lines.push("Return ONLY the corrected JSON object. No prose, no markdown.");
  }
  return lines.join("\n");
}

const RevisionResolvedSchema = z.object({
  node_id: z.string().min(1),
  resolution: z.string().min(1),
});

const RevisionInvalidatedSchema = z.object({
  node_id: z.string().min(1),
  reason: z.string().min(1),
});

const RevisionOutputSchema = z.object({
  summary: z.string().min(1),
  added: z.array(ExtrapolationNodeSeedSchema).default([]),
  resolved: z.array(RevisionResolvedSchema).default([]),
  invalidated: z.array(RevisionInvalidatedSchema).default([]),
});

type GatewayAgentPayload = { text?: string };
type GatewayAgentResponse = { result?: { payloads?: ReadonlyArray<GatewayAgentPayload> } };

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

function parseRevisionOutput(
  raw: string,
  knownNodeIds: ReadonlySet<string>,
): { ok: true; value: RevisionDelta } | { ok: false; error: string } {
  const stripped = stripCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `JSON parse failed: ${message}` };
  }
  const result = RevisionOutputSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `schema validation failed: ${issues}` };
  }
  // Validate referenced node ids exist in the graph; reject the whole response if any are bogus.
  for (const entry of result.data.resolved) {
    if (!knownNodeIds.has(entry.node_id)) {
      return { ok: false, error: `resolved.node_id "${entry.node_id}" not found in graph` };
    }
  }
  for (const entry of result.data.invalidated) {
    if (!knownNodeIds.has(entry.node_id)) {
      return { ok: false, error: `invalidated.node_id "${entry.node_id}" not found in graph` };
    }
  }
  return {
    ok: true,
    value: {
      summary: result.data.summary,
      added: result.data.added,
      resolved: result.data.resolved.map((r) => ({ nodeId: r.node_id, resolution: r.resolution })),
      invalidated: result.data.invalidated.map((r) => ({ nodeId: r.node_id, reason: r.reason })),
    },
  };
}

async function invokeRevisionModel(
  invocation: RevisionInvocation,
  callGateway: CallGatewayFn,
  userPrompt: string,
): Promise<string> {
  const startedAt = Date.now();
  const params: Record<string, unknown> = {
    agentId: invocation.graph.agentId,
    message: userPrompt,
    modelRun: true,
    promptMode: "none",
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
    throw new Error("extrapolation revision: gateway returned no text payload");
  }
  log.info("revision.model_call", {
    event: "revision.model_call",
    graphId: invocation.graph.graphId,
    agentId: invocation.graph.agentId,
    durationMs: Date.now() - startedAt,
    outputChars: text.length,
  });
  return text;
}

export async function runRevisionPass(invocation: RevisionInvocation): Promise<RevisionDelta> {
  if (!invocation.callGateway) {
    throw new Error("extrapolation revision: callGateway must be provided");
  }
  const callGateway = invocation.callGateway;
  invocation.abortSignal?.throwIfAborted();

  const knownIds = new Set(invocation.nodes.map((n) => n.nodeId));
  const firstText = await invokeRevisionModel(invocation, callGateway, buildUserPrompt(invocation));
  invocation.abortSignal?.throwIfAborted();
  const first = parseRevisionOutput(firstText, knownIds);
  if (first.ok) {
    return first.value;
  }
  log.info("revision.parse_error", {
    event: "revision.parse_error",
    graphId: invocation.graph.graphId,
    attempt: 1,
    error: first.error,
  });

  const retryText = await invokeRevisionModel(
    invocation,
    callGateway,
    buildUserPrompt(invocation, first.error),
  );
  invocation.abortSignal?.throwIfAborted();
  const second = parseRevisionOutput(retryText, knownIds);
  if (second.ok) {
    return second.value;
  }
  log.info("revision.parse_error", {
    event: "revision.parse_error",
    graphId: invocation.graph.graphId,
    attempt: 2,
    error: second.error,
  });
  throw new Error(
    `extrapolation revision: model output failed to parse after one retry. Last error: ${second.error}`,
  );
}
