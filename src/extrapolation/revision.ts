import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  ExtrapolationConcurrencyError,
  addNode,
  bumpGraphIteration,
  getGraph,
  getNodesForGraph,
  updateNode,
} from "./registry.js";
import type { RevisionDelta, RevisionInvocation } from "./revision.runtime.js";
import type { CallGatewayFn } from "./seed.runtime.js";
import type { ExtrapolationGraphRecord, ExtrapolationNodeRecord } from "./types.js";

const log = createSubsystemLogger("extrapolation");

export type ScheduleRevisionEvidence = {
  status: string;
  terminalSummary?: string | null;
  error?: string;
  childSessionKey?: string;
  endedAt?: number;
};

export type HeartbeatWakeFireFn = (opts: {
  graphId: string;
  sessionKey: string;
  agentId: string;
  reason: string;
}) => void;

export type RunRevisionFn = (invocation: RevisionInvocation) => Promise<RevisionDelta>;

export type ScheduleRevisionInput = {
  graphId: string;
  nodeId?: string;
  evidence: ScheduleRevisionEvidence;
  now?: number;
  /** Wired through to the revision model pass. When omitted, the model pass is skipped. */
  callGateway?: CallGatewayFn;
  /** Test injection: override the model pass entirely. */
  runRevision?: RunRevisionFn;
  /** Test injection: override the heartbeat-wake fire. */
  fireHeartbeatWake?: HeartbeatWakeFireFn;
  /** Per-call model timeout (forwarded to runRevision). */
  modelTimeoutMs?: number;
};

export type ScheduleRevisionOutcome = {
  graphId: string;
  applied: boolean;
  skippedReason?: string;
  evidenceCopiedToNodeId?: string;
  addedCount: number;
  resolvedCount: number;
  invalidatedCount: number;
  iteration: number;
  heartbeatRequested: boolean;
};

function nowMs(now?: number): number {
  return typeof now === "number" ? now : Date.now();
}

function isSuccessStatus(status: string): boolean {
  return status === "succeeded";
}

function evidenceResolutionText(evidence: ScheduleRevisionEvidence): string {
  if (isSuccessStatus(evidence.status)) {
    return evidence.terminalSummary?.trim() || `task ${evidence.status}`;
  }
  const parts: string[] = [`task ${evidence.status}`];
  if (evidence.terminalSummary?.trim()) {
    parts.push(evidence.terminalSummary.trim());
  }
  if (evidence.error?.trim()) {
    parts.push(`error: ${evidence.error.trim()}`);
  }
  return parts.join(" — ");
}

function stampSourceNode(
  sourceNode: ExtrapolationNodeRecord,
  evidence: ScheduleRevisionEvidence,
  now: number,
): ExtrapolationNodeRecord {
  const resolutionText = evidenceResolutionText(evidence);
  const childKey = evidence.childSessionKey?.trim();
  // On success, transition promoted → resolved with the terminal summary captured durably.
  // On failure, leave the node as promoted but stamp the failure context so the agent sees it.
  if (isSuccessStatus(evidence.status)) {
    return updateNode(
      sourceNode.nodeId,
      {
        status: "resolved",
        resolution: resolutionText,
        ...(childKey ? { promotedChildSessionKey: childKey } : {}),
      },
      { now },
    );
  }
  return updateNode(
    sourceNode.nodeId,
    {
      resolution: resolutionText,
      ...(childKey ? { promotedChildSessionKey: childKey } : {}),
    },
    { now },
  );
}

async function runRevisionDefault(invocation: RevisionInvocation): Promise<RevisionDelta> {
  const mod = await import("./revision.runtime.js");
  return mod.runRevisionPass(invocation);
}

async function fireHeartbeatWakeDefault(opts: {
  graphId: string;
  sessionKey: string;
  agentId: string;
  reason: string;
}): Promise<void> {
  try {
    const mod = await import("../infra/heartbeat-wake.js");
    mod.requestHeartbeat({
      source: "background-task",
      intent: "event",
      reason: opts.reason,
      agentId: opts.agentId,
      sessionKey: opts.sessionKey,
    });
  } catch (err) {
    log.warn("revision.heartbeat_wake_failed", {
      event: "revision.heartbeat_wake_failed",
      graphId: opts.graphId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function applyDelta(
  graph: ExtrapolationGraphRecord,
  delta: RevisionDelta,
  now: number,
): { added: number; resolved: number; invalidated: number } {
  let added = 0;
  let resolved = 0;
  let invalidated = 0;
  for (const entry of delta.resolved) {
    try {
      updateNode(entry.nodeId, { status: "resolved", resolution: entry.resolution }, { now });
      resolved += 1;
    } catch (err) {
      log.warn("revision.apply_resolved_failed", {
        event: "revision.apply_resolved_failed",
        graphId: graph.graphId,
        nodeId: entry.nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  for (const entry of delta.invalidated) {
    try {
      updateNode(entry.nodeId, { status: "invalidated", resolution: entry.reason }, { now });
      invalidated += 1;
    } catch (err) {
      log.warn("revision.apply_invalidated_failed", {
        event: "revision.apply_invalidated_failed",
        graphId: graph.graphId,
        nodeId: entry.nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const remainingBudget = Math.max(0, graph.budgetNodes - getNodesForGraph(graph.graphId).length);
  for (const seed of delta.added.slice(0, remainingBudget)) {
    try {
      addNode({
        graphId: graph.graphId,
        direction: seed.direction,
        kind: seed.kind,
        content: seed.content,
        confidence: seed.confidence,
        relevance: seed.relevance,
        ...(seed.parentNodeId ? { parentNodeId: seed.parentNodeId } : {}),
        now,
      });
      added += 1;
    } catch (err) {
      log.warn("revision.apply_added_failed", {
        event: "revision.apply_added_failed",
        graphId: graph.graphId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { added, resolved, invalidated };
}

export async function scheduleRevision(
  input: ScheduleRevisionInput,
): Promise<ScheduleRevisionOutcome> {
  const at = nowMs(input.now);
  const graph = getGraph(input.graphId);
  if (!graph) {
    log.info("revision.graph_missing", {
      event: "revision.graph_missing",
      graphId: input.graphId,
    });
    return {
      graphId: input.graphId,
      applied: false,
      skippedReason: "graph_not_found",
      addedCount: 0,
      resolvedCount: 0,
      invalidatedCount: 0,
      iteration: 0,
      heartbeatRequested: false,
    };
  }
  if (graph.status !== "active") {
    log.info("revision.graph_inactive", {
      event: "revision.graph_inactive",
      graphId: graph.graphId,
      status: graph.status,
    });
    return {
      graphId: graph.graphId,
      applied: false,
      skippedReason: `graph_status_${graph.status}`,
      addedCount: 0,
      resolvedCount: 0,
      invalidatedCount: 0,
      iteration: graph.iteration,
      heartbeatRequested: false,
    };
  }

  let evidenceCopiedToNodeId: string | undefined;
  if (input.nodeId) {
    const nodes = getNodesForGraph(graph.graphId);
    const source = nodes.find((n) => n.nodeId === input.nodeId);
    if (source) {
      try {
        stampSourceNode(source, input.evidence, at);
        evidenceCopiedToNodeId = source.nodeId;
      } catch (err) {
        log.warn("revision.source_stamp_failed", {
          event: "revision.source_stamp_failed",
          graphId: graph.graphId,
          nodeId: input.nodeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      log.info("revision.source_node_missing", {
        event: "revision.source_node_missing",
        graphId: graph.graphId,
        nodeId: input.nodeId,
      });
    }
  }

  const runRevision = input.runRevision ?? runRevisionDefault;
  const fireHeartbeatWake =
    input.fireHeartbeatWake ?? ((opts) => void fireHeartbeatWakeDefault(opts));

  // Re-read after source-node stamp so the revision pass sees fresh state.
  const refreshedNodes = getNodesForGraph(graph.graphId);
  let delta: RevisionDelta | undefined;
  if (input.callGateway || input.runRevision) {
    try {
      delta = await runRevision({
        graph,
        nodes: refreshedNodes,
        evidence: input.evidence,
        ...(input.callGateway ? { callGateway: input.callGateway } : {}),
        ...(input.modelTimeoutMs ? { timeoutMs: input.modelTimeoutMs } : {}),
      });
    } catch (err) {
      log.warn("revision.model_failed", {
        event: "revision.model_failed",
        graphId: graph.graphId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let counts = { added: 0, resolved: 0, invalidated: 0 };
  let bumped: ExtrapolationGraphRecord | undefined;
  if (delta) {
    counts = applyDelta(graph, delta, at);
    const material = counts.added + counts.resolved + counts.invalidated > 0;
    if (material) {
      try {
        bumped = bumpGraphIteration(
          graph.graphId,
          "revision",
          {
            source: "revision",
            summary: delta.summary,
            added: counts.added,
            resolved: counts.resolved,
            invalidated: counts.invalidated,
            ...(input.nodeId ? { triggeringNodeId: input.nodeId } : {}),
          },
          { now: at },
        );
      } catch (err) {
        if (err instanceof ExtrapolationConcurrencyError) {
          log.info("revision.iteration_bump_stale", {
            event: "revision.iteration_bump_stale",
            graphId: graph.graphId,
          });
        } else {
          throw err;
        }
      }
    }
  }

  const heartbeatRequested = counts.added + counts.resolved + counts.invalidated > 0;
  if (heartbeatRequested) {
    fireHeartbeatWake({
      graphId: graph.graphId,
      sessionKey: graph.sessionKey,
      agentId: graph.agentId,
      reason: `extrapolation revision applied: +${counts.added} resolved=${counts.resolved} invalid=${counts.invalidated}`,
    });
  }

  log.info("revision.complete", {
    event: "revision.complete",
    graphId: graph.graphId,
    nodeId: input.nodeId,
    addedCount: counts.added,
    resolvedCount: counts.resolved,
    invalidatedCount: counts.invalidated,
    iteration: bumped?.iteration ?? graph.iteration,
    modelRan: delta !== undefined,
  });

  return {
    graphId: graph.graphId,
    applied: true,
    addedCount: counts.added,
    resolvedCount: counts.resolved,
    invalidatedCount: counts.invalidated,
    iteration: bumped?.iteration ?? graph.iteration,
    heartbeatRequested,
    ...(evidenceCopiedToNodeId ? { evidenceCopiedToNodeId } : {}),
  };
}
