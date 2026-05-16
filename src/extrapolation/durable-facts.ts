import type { ExtrapolationNodeKind, SessionDurableFactRecord } from "./types.js";

/**
 * Canonical form used for cross-graph reinforcement matching.
 * Phase 1 starts with lowercase + collapsed whitespace; an LLM-derived
 * canonical form can replace this later if dedup quality is poor.
 */
export function canonicalizeFactContent(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Phase 2 wiring point: cross-graph reinforcement → durable fact promotion.
 * Not implemented in Phase 1.
 */
export function promoteBackwardNodeIfReinforced(_params: {
  ownerKey: string;
  sessionKey: string;
  kind: ExtrapolationNodeKind;
  content: string;
}): SessionDurableFactRecord | undefined {
  throw new Error("durable-facts promotion is not implemented in Phase 1");
}
