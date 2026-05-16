import { Type } from "typebox";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { jsonResult, readStringParam, ToolInputError } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  addNode,
  bumpGraphIteration,
  createGraph,
  getGraph,
  getNodesForGraph,
  transitionGraph,
  updateNode,
} from "./registry.js";
import { type CallGatewayFn, runSeedPass } from "./seed.runtime.js";
import type { ExtrapolationGraphStatus, ExtrapolationNodeStatus } from "./types.js";

const log = createSubsystemLogger("extrapolation");

const EXTRAPOLATION_TOOL_DISPLAY_SUMMARY = "Structured thinking before acting";

const EXTRAPOLATION_TOOL_DESCRIPTION = `Structured-reasoning substrate for complex requests.

ACTIONS:
- seed(request, budget_nodes?): build an initial graph of forward/backward/lateral reasoning nodes from a complex user request. Returns { graph_id, summary, node_count }. The graph is auto-injected into your context on every subsequent turn while it is active.
- update(node_id, patch): mark a node resolved/pruned/invalidated, set a resolution text, or adjust confidence/relevance. patch fields: status, resolution, confidence, relevance, promoted_task_id, promoted_child_session_key.
- revise(graph_id, evidence): produce a new revision pass given new evidence. (Deferred to Phase 2b; calling this now returns a 'not implemented' error.)
- close(graph_id, [reason]): mark a graph resolved or abandoned when the root request is satisfied or the plan is invalidated. status: resolved | abandoned.

USE THIS TOOL when the request is complex/strategic (multiple angles, requires understanding intent, depends on context you may not have). Skip for factoid lookups, direct commands, or requests with unambiguous purpose.`;

type CloseStatus = Extract<ExtrapolationGraphStatus, "resolved" | "abandoned">;

const ExtrapolationToolSchema = Type.Object({
  action: Type.Union([
    Type.Literal("seed"),
    Type.Literal("update"),
    Type.Literal("revise"),
    Type.Literal("close"),
  ]),
  request: Type.Optional(Type.String()),
  budget_nodes: Type.Optional(Type.Number()),
  model: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  node_id: Type.Optional(Type.String()),
  patch: Type.Optional(
    Type.Object({
      status: Type.Optional(
        Type.Union([
          Type.Literal("open"),
          Type.Literal("resolved"),
          Type.Literal("pruned"),
          Type.Literal("promoted"),
          Type.Literal("invalidated"),
        ]),
      ),
      resolution: Type.Optional(Type.String()),
      confidence: Type.Optional(Type.Number()),
      relevance: Type.Optional(Type.Number()),
      promoted_task_id: Type.Optional(Type.String()),
      promoted_child_session_key: Type.Optional(Type.String()),
    }),
  ),
  graph_id: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.Unknown()),
  status: Type.Optional(Type.Union([Type.Literal("resolved"), Type.Literal("abandoned")])),
  reason: Type.Optional(Type.String()),
});

export type CreateExtrapolationToolOptions = {
  agentId: string;
  ownerKey: string;
  sessionKey: string;
  config?: OpenClawConfig;
  /** Injected for tests; defaults to the live gateway call. */
  callGateway?: CallGatewayFn;
};

type NodePatchInput = {
  status?: ExtrapolationNodeStatus;
  resolution?: string;
  confidence?: number;
  relevance?: number;
  promoted_task_id?: string;
  promoted_child_session_key?: string;
};

function readPatch(params: Record<string, unknown>): NodePatchInput {
  const raw = params.patch;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ToolInputError(`extrapolation.update requires a "patch" object`);
  }
  return raw as NodePatchInput;
}

function readNumber(params: Record<string, unknown>, key: string): number | undefined {
  const raw = params[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function readBudget(params: Record<string, unknown>, config?: OpenClawConfig): number {
  const fromParam = readNumber(params, "budget_nodes");
  if (fromParam && fromParam > 0) {
    return Math.floor(fromParam);
  }
  return config?.extrapolation?.defaults?.budgetNodes ?? 50;
}

function readCloseStatus(params: Record<string, unknown>): CloseStatus {
  const raw = params.status;
  if (raw === "resolved" || raw === "abandoned") {
    return raw;
  }
  throw new ToolInputError(`extrapolation.close requires status: "resolved" | "abandoned"`);
}

async function handleSeed(
  params: Record<string, unknown>,
  opts: CreateExtrapolationToolOptions,
): Promise<unknown> {
  const request = readStringParam(params, "request", { required: true });
  const budgetNodes = readBudget(params, opts.config);
  const seedModel = readStringParam(params, "model") ?? opts.config?.extrapolation?.models?.seed;
  const seedProvider = readStringParam(params, "provider");

  if (!opts.callGateway) {
    throw new Error("extrapolation tool: callGateway is not wired");
  }

  const graph = createGraph({
    rootRequest: request,
    ownerKey: opts.ownerKey,
    sessionKey: opts.sessionKey,
    agentId: opts.agentId,
    budgetNodes,
  });
  log.info("graph.created", {
    event: "graph.created",
    graphId: graph.graphId,
    agentId: opts.agentId,
    ownerKey: opts.ownerKey,
    sessionKey: opts.sessionKey,
    budgetNodes,
    requestChars: request.length,
  });

  const seedOutput = await runSeedPass({
    rootRequest: request,
    agentId: opts.agentId,
    ownerKey: opts.ownerKey,
    sessionKey: opts.sessionKey,
    budgetNodes,
    callGateway: opts.callGateway,
    ...(seedModel ? { model: seedModel } : {}),
    ...(seedProvider ? { provider: seedProvider } : {}),
  });

  let added = 0;
  for (const node of seedOutput.nodes.slice(0, budgetNodes)) {
    addNode({
      graphId: graph.graphId,
      direction: node.direction,
      kind: node.kind,
      content: node.content,
      confidence: node.confidence,
      relevance: node.relevance,
      ...(node.parentNodeId ? { parentNodeId: node.parentNodeId } : {}),
    });
    added += 1;
    log.info("node.added", {
      event: "node.added",
      graphId: graph.graphId,
      direction: node.direction,
      kind: node.kind,
      byPass: "seed",
    });
  }

  // Record the seed audit pass for the graph iteration.
  bumpGraphIteration(graph.graphId, "revision", {
    source: "seed",
    added,
    summary: seedOutput.summary,
  });

  return jsonResult({
    status: "ok",
    graph_id: graph.graphId,
    summary: seedOutput.summary,
    node_count: added,
    budget_nodes: budgetNodes,
  });
}

function handleUpdate(params: Record<string, unknown>): unknown {
  const nodeId = readStringParam(params, "node_id", { required: true });
  const patch = readPatch(params);
  const next = updateNode(nodeId, {
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.resolution !== undefined ? { resolution: patch.resolution } : {}),
    ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
    ...(patch.relevance !== undefined ? { relevance: patch.relevance } : {}),
    ...(patch.promoted_task_id !== undefined ? { promotedTaskId: patch.promoted_task_id } : {}),
    ...(patch.promoted_child_session_key !== undefined
      ? { promotedChildSessionKey: patch.promoted_child_session_key }
      : {}),
  });
  log.info("node.updated", {
    event: "node.updated",
    nodeId: next.nodeId,
    graphId: next.graphId,
    status: next.status,
  });
  return jsonResult({ status: "ok", node: next });
}

function handleClose(params: Record<string, unknown>): unknown {
  const graphId = readStringParam(params, "graph_id", { required: true });
  const status = readCloseStatus(params);
  const reason = readStringParam(params, "reason");
  const next = transitionGraph({
    graphId,
    to: status,
    ...(reason ? { reason } : {}),
  });
  log.info("graph.state_transition", {
    event: "graph.state_transition",
    graphId: next.graphId,
    to: status,
    reason,
  });
  return jsonResult({ status: "ok", graph: next });
}

function handleRevise(params: Record<string, unknown>): unknown {
  const graphId = readStringParam(params, "graph_id", { required: true });
  // Smoke-validate the graph exists so the agent gets a clear error early.
  const graph = getGraph(graphId);
  if (!graph) {
    throw new ToolInputError(`extrapolation.revise: graph ${graphId} not found`);
  }
  // Surface current nodes so the agent can decide whether to retry manual update calls
  // in the meantime.
  const nodes = getNodesForGraph(graphId);
  return jsonResult({
    status: "not_implemented",
    detail:
      "extrapolation.revise is deferred to Phase 2b. Use extrapolation.update to mark gaps resolved or invalidated with the new evidence; the auto-revision pass will land in the next sub-phase.",
    graph_id: graphId,
    node_count: nodes.length,
  });
}

export function createExtrapolationTool(opts: CreateExtrapolationToolOptions): AnyAgentTool {
  return {
    label: "Extrapolation",
    name: "extrapolation",
    displaySummary: EXTRAPOLATION_TOOL_DISPLAY_SUMMARY,
    description: EXTRAPOLATION_TOOL_DESCRIPTION,
    parameters: ExtrapolationToolSchema,
    execute: async (_toolCallId, args) => {
      const params =
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {};
      const action = readStringParam(params, "action", { required: true });
      switch (action) {
        case "seed":
          return (await handleSeed(params, opts)) as Awaited<ReturnType<AnyAgentTool["execute"]>>;
        case "update":
          return handleUpdate(params) as Awaited<ReturnType<AnyAgentTool["execute"]>>;
        case "close":
          return handleClose(params) as Awaited<ReturnType<AnyAgentTool["execute"]>>;
        case "revise":
          return handleRevise(params) as Awaited<ReturnType<AnyAgentTool["execute"]>>;
        default:
          throw new ToolInputError(
            `extrapolation: unknown action "${action}". Use seed | update | close | revise.`,
          );
      }
    },
  };
}

/** @deprecated Phase 1 stub retained for backwards-compatible imports. */
export function buildExtrapolationAgentTool(): never {
  throw new Error(
    "buildExtrapolationAgentTool is deprecated. Use createExtrapolationTool(opts) instead.",
  );
}

export type ExtrapolationToolAction = "seed" | "update" | "revise" | "close";
