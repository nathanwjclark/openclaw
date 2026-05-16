import type { ExtrapolationNodeSeedInput } from "./types.js";

export type SeedInvocation = {
  rootRequest: string;
  agentId: string;
  ownerKey: string;
  sessionKey: string;
  /** Established facts injected at seed time when memory promotion is enabled. */
  durableFacts?: ReadonlyArray<{ kind: string; content: string }>;
};

export type SeedOutput = {
  nodes: ReadonlyArray<ExtrapolationNodeSeedInput>;
  summary: string;
};

/**
 * Phase 2 wiring point: produces the initial graph via a model call.
 * Not implemented in Phase 1; substrate-only landing keeps this dormant.
 */
export function runSeedPass(_invocation: SeedInvocation): Promise<SeedOutput> {
  throw new Error("extrapolation seed runtime is not implemented in Phase 1");
}
