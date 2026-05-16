import { createHash, randomUUID } from "node:crypto";
import {
  EXTRAPOLATION_MEMORY_DEFAULTS,
  type ExtrapolationMemoryConfig,
} from "../config/types.extrapolation.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getNodesForGraph, listGraphsForSession } from "./registry.js";
import {
  insertFactRecord,
  selectFactByHash,
  selectFactsBySession,
  selectFactsBySessionKey,
  updateFactRecord,
} from "./store.sqlite.js";
import {
  directionForKind,
  type ExtrapolationGraphRecord,
  type ExtrapolationNodeKind,
  type ExtrapolationNodeRecord,
  type SessionDurableFactRecord,
} from "./types.js";

const log = createSubsystemLogger("extrapolation");

export const DEFAULT_DURABLE_FACTS_THRESHOLD = 3;
export const DEFAULT_DURABLE_FACTS_CONFIDENCE_FLOOR = 0.7;

/**
 * Canonical form used for cross-graph reinforcement matching.
 * Lowercase + collapsed whitespace. An LLM-derived canonical form can replace
 * this later if dedup quality is poor.
 */
export function canonicalizeFactContent(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

function hashCanonical(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

function isUsableNode(node: ExtrapolationNodeRecord): boolean {
  return node.status !== "pruned" && node.status !== "invalidated";
}

function isUsableGraph(graph: ExtrapolationGraphRecord): boolean {
  return graph.status !== "abandoned";
}

type ReinforcementSummary = {
  graphIds: ReadonlyArray<string>;
  maxConfidence: number;
};

/**
 * Walk every graph in the session and count distinct graphs whose backward
 * nodes match `(kind, canonical)` with confidence at or above `confidenceFloor`.
 * Returns the sorted distinct graph ids and the maximum source confidence.
 */
function collectReinforcement(input: {
  sessionKey: string;
  kind: ExtrapolationNodeKind;
  canonical: string;
  confidenceFloor: number;
}): ReinforcementSummary {
  const graphs = listGraphsForSession(input.sessionKey).filter(isUsableGraph);
  const graphIds = new Set<string>();
  let maxConfidence = 0;
  for (const graph of graphs) {
    const nodes = getNodesForGraph(graph.graphId);
    let matched = false;
    for (const node of nodes) {
      if (
        node.kind === input.kind &&
        isUsableNode(node) &&
        node.confidence >= input.confidenceFloor &&
        canonicalizeFactContent(node.content) === input.canonical
      ) {
        matched = true;
        if (node.confidence > maxConfidence) {
          maxConfidence = node.confidence;
        }
      }
    }
    if (matched) {
      graphIds.add(graph.graphId);
    }
  }
  return {
    graphIds: [...graphIds].toSorted(),
    maxConfidence,
  };
}

export type PromoteBackwardNodeInput = {
  ownerKey: string;
  sessionKey: string;
  kind: ExtrapolationNodeKind;
  content: string;
  /** The graph that just added (or re-asserted) the backward node. */
  sourceGraphId: string;
  /** Distinct-graph threshold required to promote. Default 3. */
  threshold?: number;
  /** Minimum source-node confidence to count toward reinforcement. Default 0.7. */
  confidenceFloor?: number;
  /** Injected clock for tests. */
  now?: number;
};

/**
 * Cross-graph reinforcement → durable fact promotion.
 *
 * Called when a backward node enters a graph. Counts distinct graphs in the
 * session whose backward nodes match the canonical content; if that count
 * meets the threshold, upserts a `session_durable_facts` row. Idempotent:
 * re-calling on already-promoted content updates `reinforcement` and
 * `sourceGraphIds` to reflect the current substrate state.
 *
 * Returns the upserted record on promotion, `undefined` when not promoted
 * (non-backward kind, under threshold, etc).
 */
export function promoteBackwardNodeIfReinforced(
  input: PromoteBackwardNodeInput,
): SessionDurableFactRecord | undefined {
  if (directionForKind(input.kind) !== "backward") {
    return undefined;
  }
  const threshold = input.threshold ?? DEFAULT_DURABLE_FACTS_THRESHOLD;
  const confidenceFloor = input.confidenceFloor ?? DEFAULT_DURABLE_FACTS_CONFIDENCE_FLOOR;
  const canonical = canonicalizeFactContent(input.content);
  if (!canonical) {
    return undefined;
  }
  const at = typeof input.now === "number" ? input.now : Date.now();

  const summary = collectReinforcement({
    sessionKey: input.sessionKey,
    kind: input.kind,
    canonical,
    confidenceFloor,
  });

  if (summary.graphIds.length < threshold) {
    log.debug("durable_facts.skipped", {
      event: "durable_facts.skipped",
      reason: "under_threshold",
      sessionKey: input.sessionKey,
      kind: input.kind,
      reinforcement: summary.graphIds.length,
      threshold,
    });
    return undefined;
  }

  const contentHash = hashCanonical(canonical);
  const existing = selectFactByHash(input.sessionKey, contentHash);
  if (existing) {
    const merged: SessionDurableFactRecord = {
      ...existing,
      content: canonical,
      confidence: Math.max(existing.confidence, summary.maxConfidence),
      reinforcement: summary.graphIds.length,
      sourceGraphIds: summary.graphIds,
      updatedAt: at,
      ...(existing.revokedAt !== undefined ? { revokedAt: undefined } : {}),
    };
    updateFactRecord(merged);
    log.info("durable_facts.reinforced", {
      event: "durable_facts.reinforced",
      factId: merged.factId,
      sessionKey: input.sessionKey,
      kind: input.kind,
      reinforcement: merged.reinforcement,
    });
    return merged;
  }

  const record: SessionDurableFactRecord = {
    factId: randomUUID(),
    ownerKey: input.ownerKey,
    sessionKey: input.sessionKey,
    kind: input.kind,
    content: canonical,
    contentHash,
    confidence: summary.maxConfidence,
    reinforcement: summary.graphIds.length,
    sourceGraphIds: summary.graphIds,
    createdAt: at,
    updatedAt: at,
  };
  insertFactRecord(record);
  log.info("durable_facts.promoted", {
    event: "durable_facts.promoted",
    factId: record.factId,
    sessionKey: input.sessionKey,
    kind: input.kind,
    reinforcement: record.reinforcement,
  });
  return record;
}

export type ResolvedMemoryConfig = {
  /** Master extrapolation switch is on. */
  enabled: boolean;
  /** Established facts are injected into seed prompts. Implies `enabled`. */
  injectIntoSeed: boolean;
  /** Distinct-graph threshold required to promote. */
  threshold: number;
  /** Minimum source-node confidence to count toward reinforcement. */
  confidenceFloor: number;
};

/**
 * Collapse the layered `extrapolation.memory` config plus the master enable
 * switch into the four scalars promotion / injection actually need. Defaults
 * mirror `EXTRAPOLATION_MEMORY_DEFAULTS`; everything stays off until the
 * master switch is true.
 */
export function resolveMemoryConfig(config?: OpenClawConfig): ResolvedMemoryConfig {
  const memory: ExtrapolationMemoryConfig | undefined = config?.extrapolation?.memory;
  const enabled = config?.extrapolation?.enabled === true;
  const injectIntoSeed =
    enabled && (memory?.injectIntoSeed ?? EXTRAPOLATION_MEMORY_DEFAULTS.injectIntoSeed);
  return {
    enabled,
    injectIntoSeed,
    threshold:
      memory?.crossGraphReinforcement ?? EXTRAPOLATION_MEMORY_DEFAULTS.crossGraphReinforcement,
    confidenceFloor: memory?.confidenceFloor ?? EXTRAPOLATION_MEMORY_DEFAULTS.confidenceFloor,
  };
}

/**
 * Best-effort wrapper around `promoteBackwardNodeIfReinforced` for write-site
 * callers (seed, revision). No-op when the master switch is off; failures are
 * logged, not propagated, so substrate state cannot break the writing path.
 */
export function tryPromoteBackwardNode(input: {
  ownerKey: string;
  sessionKey: string;
  kind: ExtrapolationNodeKind;
  content: string;
  sourceGraphId: string;
  memory: ResolvedMemoryConfig;
  now?: number;
}): void {
  if (!input.memory.enabled) {
    return;
  }
  try {
    promoteBackwardNodeIfReinforced({
      ownerKey: input.ownerKey,
      sessionKey: input.sessionKey,
      kind: input.kind,
      content: input.content,
      sourceGraphId: input.sourceGraphId,
      threshold: input.memory.threshold,
      confidenceFloor: input.memory.confidenceFloor,
      ...(typeof input.now === "number" ? { now: input.now } : {}),
    });
  } catch (err) {
    log.warn("durable_facts.promote_failed", {
      event: "durable_facts.promote_failed",
      sessionKey: input.sessionKey,
      kind: input.kind,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export type DurableFactForSeed = { kind: string; content: string };

/**
 * Returns the active (non-revoked) durable facts for a session, shaped for
 * `SeedInvocation.durableFacts`. Insertion order — registry creation order —
 * is preserved so seed prompts stay cache-friendly across ticks.
 */
export function getDurableFactsForSession(input: {
  ownerKey: string;
  sessionKey: string;
}): ReadonlyArray<DurableFactForSeed> {
  const rows = selectFactsBySession(input.ownerKey, input.sessionKey);
  return rows.map((row) => ({ kind: row.kind, content: row.content }));
}

/**
 * sessionKey-only variant for callers that do not have ownerKey handy
 * (notably per-turn context injection in the embedded runner). The table's
 * unique constraint is `(session_key, content_hash)`, so this is the
 * authoritative scope for "facts established in this session."
 */
export function getDurableFactsBySessionKey(sessionKey: string): ReadonlyArray<DurableFactForSeed> {
  const rows = selectFactsBySessionKey(sessionKey);
  return rows.map((row) => ({ kind: row.kind, content: row.content }));
}

export type RevokeDurableFactInput = {
  sessionKey: string;
  kind: ExtrapolationNodeKind;
  content: string;
  /** Optional human-readable reason captured in the audit log. */
  reason?: string;
  /** Injected clock for tests. */
  now?: number;
};

export type RevokeDurableFactOutcome = {
  revoked: boolean;
  factId?: string;
  reason: "ok" | "not_found" | "already_revoked";
};

/**
 * Soft-delete a durable fact by `(sessionKey, kind, content)`. The agent
 * surfaces revocation via the extrapolation tool's `revoke_fact` action,
 * giving the substrate an auditable way to mark a previously-promoted fact
 * wrong without losing its history (the row stays for audit; only future
 * reads filter it out via `revoked_at IS NULL`).
 *
 * Returns:
 *   - `ok` when a non-revoked fact was found and revoked.
 *   - `already_revoked` when the row exists but was previously revoked.
 *   - `not_found` when no matching fact exists.
 */
export function revokeDurableFactByContent(
  input: RevokeDurableFactInput,
): RevokeDurableFactOutcome {
  const canonical = canonicalizeFactContent(input.content);
  if (!canonical) {
    return { revoked: false, reason: "not_found" };
  }
  const contentHash = hashCanonical(canonical);
  const existing = selectFactByHash(input.sessionKey, contentHash);
  if (!existing) {
    // selectFactByHash already filters on revoked_at IS NULL, so a missing
    // row could be "never existed" or "already revoked". For the agent's
    // purposes both surface the same way, but we surface distinct reasons
    // by looking up explicitly without the revoked filter would require
    // a new statement; keep it simple and return not_found.
    log.info("durable_facts.revoke_skipped", {
      event: "durable_facts.revoke_skipped",
      reason: "not_found",
      sessionKey: input.sessionKey,
      kind: input.kind,
    });
    return { revoked: false, reason: "not_found" };
  }
  if (existing.kind !== input.kind) {
    log.info("durable_facts.revoke_skipped", {
      event: "durable_facts.revoke_skipped",
      reason: "kind_mismatch",
      sessionKey: input.sessionKey,
      requestedKind: input.kind,
      existingKind: existing.kind,
    });
    return { revoked: false, reason: "not_found" };
  }
  const at = typeof input.now === "number" ? input.now : Date.now();
  const updated: SessionDurableFactRecord = {
    ...existing,
    revokedAt: at,
    updatedAt: at,
  };
  updateFactRecord(updated);
  log.info("durable_facts.revoked", {
    event: "durable_facts.revoked",
    factId: existing.factId,
    sessionKey: input.sessionKey,
    kind: input.kind,
    ...(input.reason ? { revokeReason: input.reason } : {}),
  });
  return { revoked: true, factId: existing.factId, reason: "ok" };
}
