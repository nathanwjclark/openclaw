import { randomUUID } from "node:crypto";
import { assertGraphTransition, assertNodeTransition } from "./state-machine.js";
import {
  insertAuditRecord,
  insertGraphRecord,
  insertNodeRecord,
  selectAuditByGraph,
  selectGraphById,
  selectGraphsByOwner,
  selectGraphsBySession,
  selectGraphsByStatus,
  selectNodeById,
  selectNodesByGraph,
  updateGraphRecord,
  updateNodeRecord,
} from "./store.sqlite.js";
import {
  directionForKind,
  type ExtrapolationAuditRecord,
  type ExtrapolationGraphRecord,
  type ExtrapolationGraphStatus,
  type ExtrapolationNodePatch,
  ExtrapolationNodePatchSchema,
  type ExtrapolationNodeRecord,
  type ExtrapolationNodeSeedInput,
  ExtrapolationNodeSeedSchema,
} from "./types.js";

export type CreateGraphInput = {
  rootRequest: string;
  ownerKey: string;
  sessionKey: string;
  agentId: string;
  budgetNodes?: number;
  now?: number;
};

export type AddNodeInput = ExtrapolationNodeSeedInput & {
  graphId: string;
  nodeId?: string;
  now?: number;
};

export type TransitionGraphInput = {
  graphId: string;
  to: ExtrapolationGraphStatus;
  reason?: string;
  now?: number;
};

export class ExtrapolationConcurrencyError extends Error {
  constructor(graphId: string) {
    super(`extrapolation: stale revision token for graph ${graphId}`);
    this.name = "ExtrapolationConcurrencyError";
  }
}

export class ExtrapolationNotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`extrapolation: ${kind} ${id} not found`);
    this.name = "ExtrapolationNotFoundError";
  }
}

function nowMs(now?: number): number {
  return typeof now === "number" ? now : Date.now();
}

function requireGraph(graphId: string): ExtrapolationGraphRecord {
  const graph = selectGraphById(graphId);
  if (!graph) {
    throw new ExtrapolationNotFoundError("graph", graphId);
  }
  return graph;
}

function requireNode(nodeId: string): ExtrapolationNodeRecord {
  const node = selectNodeById(nodeId);
  if (!node) {
    throw new ExtrapolationNotFoundError("node", nodeId);
  }
  return node;
}

function writeAudit(
  graphId: string,
  iteration: number,
  kind: ExtrapolationAuditRecord["kind"],
  content: unknown,
  at: number,
): void {
  insertAuditRecord({
    graphId,
    iteration,
    at,
    kind,
    contentJson: JSON.stringify(content ?? {}),
  });
}

function bumpGraph(
  graph: ExtrapolationGraphRecord,
  patch: Partial<ExtrapolationGraphRecord>,
  at: number,
): ExtrapolationGraphRecord {
  const expectedToken = graph.revisionToken;
  const next: ExtrapolationGraphRecord = {
    ...graph,
    ...patch,
    revisionToken: graph.revisionToken + 1,
    updatedAt: at,
  };
  const applied = updateGraphRecord(next, expectedToken);
  if (!applied) {
    throw new ExtrapolationConcurrencyError(graph.graphId);
  }
  return next;
}

export function createGraph(input: CreateGraphInput): ExtrapolationGraphRecord {
  const at = nowMs(input.now);
  const record: ExtrapolationGraphRecord = {
    graphId: randomUUID(),
    rootRequest: input.rootRequest,
    ownerKey: input.ownerKey,
    sessionKey: input.sessionKey,
    agentId: input.agentId,
    status: "active",
    iteration: 0,
    budgetNodes: input.budgetNodes ?? 50,
    revisionToken: 0,
    createdAt: at,
    updatedAt: at,
  };
  insertGraphRecord(record);
  writeAudit(
    record.graphId,
    0,
    "seed",
    { rootRequest: record.rootRequest, ownerKey: record.ownerKey, agentId: record.agentId },
    at,
  );
  return record;
}

export function addNode(input: AddNodeInput): ExtrapolationNodeRecord {
  const parsed = ExtrapolationNodeSeedSchema.parse({
    direction: input.direction,
    kind: input.kind,
    content: input.content,
    confidence: input.confidence,
    relevance: input.relevance,
    parentNodeId: input.parentNodeId,
  });
  const graph = requireGraph(input.graphId);
  if (graph.status !== "active") {
    throw new Error(`cannot add node to ${graph.status} graph ${graph.graphId}`);
  }
  const at = nowMs(input.now);
  const direction = directionForKind(parsed.kind);
  const record: ExtrapolationNodeRecord = {
    nodeId: input.nodeId ?? randomUUID(),
    graphId: input.graphId,
    ...(parsed.parentNodeId ? { parentNodeId: parsed.parentNodeId } : {}),
    direction,
    kind: parsed.kind,
    content: parsed.content,
    confidence: parsed.confidence,
    relevance: parsed.relevance,
    status: "open",
    createdAt: at,
    updatedAt: at,
  };
  insertNodeRecord(record);
  writeAudit(
    graph.graphId,
    graph.iteration,
    "update",
    { added: { nodeId: record.nodeId, direction, kind: parsed.kind } },
    at,
  );
  return record;
}

export function updateNode(
  nodeId: string,
  patch: ExtrapolationNodePatch,
  options: { now?: number } = {},
): ExtrapolationNodeRecord {
  const parsed = ExtrapolationNodePatchSchema.parse(patch);
  const existing = requireNode(nodeId);
  const at = nowMs(options.now);
  const nextStatus = parsed.status ?? existing.status;
  if (parsed.status && parsed.status !== existing.status) {
    assertNodeTransition(existing.status, parsed.status);
  }
  const resolvedAt = nextStatus === "resolved" && !existing.resolvedAt ? at : existing.resolvedAt;
  const next: ExtrapolationNodeRecord = {
    ...existing,
    status: nextStatus,
    confidence: parsed.confidence ?? existing.confidence,
    relevance: parsed.relevance ?? existing.relevance,
    ...(parsed.resolution !== undefined ? { resolution: parsed.resolution } : {}),
    ...(parsed.promotedTaskId !== undefined ? { promotedTaskId: parsed.promotedTaskId } : {}),
    ...(parsed.promotedChildSessionKey !== undefined
      ? { promotedChildSessionKey: parsed.promotedChildSessionKey }
      : {}),
    updatedAt: at,
    ...(resolvedAt != null ? { resolvedAt } : {}),
  };
  updateNodeRecord(next);
  writeAudit(
    existing.graphId,
    selectGraphById(existing.graphId)?.iteration ?? 0,
    parsed.status === "promoted"
      ? "promotion"
      : parsed.status === "resolved"
        ? "resolution"
        : "update",
    { nodeId, patch: parsed },
    at,
  );
  return next;
}

export function transitionGraph(input: TransitionGraphInput): ExtrapolationGraphRecord {
  const graph = requireGraph(input.graphId);
  assertGraphTransition(graph.status, input.to);
  const at = nowMs(input.now);
  if (graph.status === input.to) {
    return graph;
  }
  const patch: Partial<ExtrapolationGraphRecord> = {
    status: input.to,
    ...(input.to === "resolved" ? { resolvedAt: at } : {}),
    ...(input.to === "abandoned" && input.reason ? { abandonedReason: input.reason } : {}),
  };
  const next = bumpGraph(graph, patch, at);
  writeAudit(
    next.graphId,
    next.iteration,
    "state_transition",
    { from: graph.status, to: input.to, ...(input.reason ? { reason: input.reason } : {}) },
    at,
  );
  return next;
}

export function bumpGraphIteration(
  graphId: string,
  kind: Extract<ExtrapolationAuditRecord["kind"], "revision">,
  payload: unknown,
  options: { now?: number; flowId?: string } = {},
): ExtrapolationGraphRecord {
  const graph = requireGraph(graphId);
  const at = nowMs(options.now);
  const next = bumpGraph(
    graph,
    {
      iteration: graph.iteration + 1,
      ...(options.flowId ? { flowId: options.flowId } : {}),
    },
    at,
  );
  writeAudit(next.graphId, next.iteration, kind, payload, at);
  return next;
}

export function listGraphsForSession(sessionKey: string): ExtrapolationGraphRecord[] {
  return selectGraphsBySession(sessionKey);
}

export function listGraphsForOwner(ownerKey: string): ExtrapolationGraphRecord[] {
  return selectGraphsByOwner(ownerKey);
}

export function listGraphsByStatus(status: ExtrapolationGraphStatus): ExtrapolationGraphRecord[] {
  return selectGraphsByStatus(status);
}

export function getGraph(graphId: string): ExtrapolationGraphRecord | undefined {
  return selectGraphById(graphId);
}

export function getNode(nodeId: string): ExtrapolationNodeRecord | undefined {
  return selectNodeById(nodeId);
}

export function getNodesForGraph(graphId: string): ExtrapolationNodeRecord[] {
  return selectNodesByGraph(graphId);
}

export function getAuditForGraph(graphId: string): ExtrapolationAuditRecord[] {
  return selectAuditByGraph(graphId);
}
