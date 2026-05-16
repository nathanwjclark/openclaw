/**
 * State reconciliation for extrapolation graphs.
 *
 * The sweep tick runs three checks:
 *  - iteration cap: graphs that exceed `maxIterations` get abandoned so a
 *    runaway revision loop cannot keep mutating substrate forever.
 *  - orphaned session: graphs whose `sessionKey` no longer exists are abandoned
 *    so the substrate is not pinned to dead conversations. A grace period
 *    avoids racing brand-new graphs whose session is still being registered.
 *  - durable-fact backfill (Phase 3): when memory config is enabled, walk
 *    each active graph's backward nodes and call the promotion path so any
 *    cross-graph reinforcement missed at write-time (e.g. the master switch
 *    was off when the nodes were added) gets promoted to
 *    `session_durable_facts` on this tick.
 *
 * This module is a pure tick function. Wiring it to a scheduler (heartbeat,
 * cron, etc.) is a runtime concern handled elsewhere.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { promoteBackwardNodeIfReinforced, type ResolvedMemoryConfig } from "./durable-facts.js";
import { getNodesForGraph, listGraphsByStatus, transitionGraph } from "./registry.js";
import { directionForKind, type ExtrapolationGraphRecord } from "./types.js";

const log = createSubsystemLogger("extrapolation");

export const DEFAULT_SWEEPER_MAX_ITERATIONS = 12;
export const DEFAULT_SWEEPER_ORPHAN_GRACE_MS = 10 * 60 * 1000;

export type SessionExistsFn = (sessionKey: string) => boolean;

export type SweepExtrapolationInput = {
  now?: number;
  maxIterations?: number;
  /** Grace period before a graph whose session is missing can be considered orphaned. */
  orphanGraceMs?: number;
  /** Returns true when the session backing the graph still exists. Omit to skip orphan check. */
  sessionExists?: SessionExistsFn;
  /** When provided and `memory.enabled`, backward nodes on active graphs are run through the durable-fact promotion path. */
  memory?: ResolvedMemoryConfig;
};

export type SweepExtrapolationOutcome = {
  inspectedCount: number;
  abandonedIterationCap: ReadonlyArray<string>;
  abandonedOrphaned: ReadonlyArray<string>;
  /** Backward-node promotion attempts during the sweep that returned a fact record (newly promoted or reinforced). */
  factsBackfilledCount: number;
};

function nowMs(now?: number): number {
  return typeof now === "number" ? now : Date.now();
}

function abandon(graph: ExtrapolationGraphRecord, reason: string, at: number): boolean {
  try {
    transitionGraph({ graphId: graph.graphId, to: "abandoned", reason, now: at });
    log.info("sweeper.abandoned", {
      event: "sweeper.abandoned",
      graphId: graph.graphId,
      sessionKey: graph.sessionKey,
      reason,
      iteration: graph.iteration,
    });
    return true;
  } catch (err) {
    log.warn("sweeper.abandon_failed", {
      event: "sweeper.abandon_failed",
      graphId: graph.graphId,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function backfillFactsForGraph(
  graph: ExtrapolationGraphRecord,
  memory: ResolvedMemoryConfig,
): number {
  let touched = 0;
  for (const node of getNodesForGraph(graph.graphId)) {
    if (directionForKind(node.kind) !== "backward") {
      continue;
    }
    if (node.status === "pruned" || node.status === "invalidated") {
      continue;
    }
    try {
      const result = promoteBackwardNodeIfReinforced({
        ownerKey: graph.ownerKey,
        sessionKey: graph.sessionKey,
        kind: node.kind,
        content: node.content,
        sourceGraphId: graph.graphId,
        threshold: memory.threshold,
        confidenceFloor: memory.confidenceFloor,
      });
      if (result) {
        touched += 1;
      }
    } catch (err) {
      log.warn("sweeper.backfill_failed", {
        event: "sweeper.backfill_failed",
        graphId: graph.graphId,
        nodeId: node.nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return touched;
}

export function sweepExtrapolation(input: SweepExtrapolationInput = {}): SweepExtrapolationOutcome {
  const at = nowMs(input.now);
  const maxIterations = input.maxIterations ?? DEFAULT_SWEEPER_MAX_ITERATIONS;
  const orphanGraceMs = input.orphanGraceMs ?? DEFAULT_SWEEPER_ORPHAN_GRACE_MS;
  const sessionExists = input.sessionExists;
  const memory = input.memory;

  const active = listGraphsByStatus("active");
  const iterationCap: string[] = [];
  const orphaned: string[] = [];
  let factsBackfilledCount = 0;

  for (const graph of active) {
    if (graph.iteration > maxIterations) {
      if (abandon(graph, `iteration_cap_exceeded:${graph.iteration}>${maxIterations}`, at)) {
        iterationCap.push(graph.graphId);
      }
      continue;
    }
    if (sessionExists && !sessionExists(graph.sessionKey)) {
      const age = at - graph.updatedAt;
      if (age < orphanGraceMs) {
        log.debug("sweeper.orphan_grace", {
          event: "sweeper.orphan_grace",
          graphId: graph.graphId,
          ageMs: age,
          orphanGraceMs,
        });
        continue;
      }
      if (abandon(graph, "session_missing", at)) {
        orphaned.push(graph.graphId);
        continue;
      }
    }
    if (memory && memory.enabled) {
      factsBackfilledCount += backfillFactsForGraph(graph, memory);
    }
  }

  log.info("sweeper.complete", {
    event: "sweeper.complete",
    inspectedCount: active.length,
    abandonedIterationCap: iterationCap.length,
    abandonedOrphaned: orphaned.length,
    factsBackfilledCount,
  });

  return {
    inspectedCount: active.length,
    abandonedIterationCap: iterationCap,
    abandonedOrphaned: orphaned,
    factsBackfilledCount,
  };
}
