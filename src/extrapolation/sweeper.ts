/**
 * State reconciliation for extrapolation graphs.
 *
 * Phase 2c implements the two intrinsic checks:
 *  - iteration cap: graphs that exceed `maxIterations` get abandoned so a
 *    runaway revision loop cannot keep mutating substrate forever.
 *  - orphaned session: graphs whose `sessionKey` no longer exists are abandoned
 *    so the substrate is not pinned to dead conversations. A grace period
 *    avoids racing brand-new graphs whose session is still being registered.
 *
 * Memory promotion (`session_durable_facts`) is intentionally deferred to
 * Phase 3 — this sweeper does not yet read backward nodes.
 *
 * This module is a pure tick function. Wiring it to a scheduler (heartbeat,
 * cron, etc.) is a runtime concern handled elsewhere.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { listGraphsByStatus, transitionGraph } from "./registry.js";
import type { ExtrapolationGraphRecord } from "./types.js";

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
};

export type SweepExtrapolationOutcome = {
  inspectedCount: number;
  abandonedIterationCap: ReadonlyArray<string>;
  abandonedOrphaned: ReadonlyArray<string>;
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

export function sweepExtrapolation(input: SweepExtrapolationInput = {}): SweepExtrapolationOutcome {
  const at = nowMs(input.now);
  const maxIterations = input.maxIterations ?? DEFAULT_SWEEPER_MAX_ITERATIONS;
  const orphanGraceMs = input.orphanGraceMs ?? DEFAULT_SWEEPER_ORPHAN_GRACE_MS;
  const sessionExists = input.sessionExists;

  const active = listGraphsByStatus("active");
  const iterationCap: string[] = [];
  const orphaned: string[] = [];

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
      }
    }
  }

  log.info("sweeper.complete", {
    event: "sweeper.complete",
    inspectedCount: active.length,
    abandonedIterationCap: iterationCap.length,
    abandonedOrphaned: orphaned.length,
  });

  return {
    inspectedCount: active.length,
    abandonedIterationCap: iterationCap,
    abandonedOrphaned: orphaned,
  };
}
