import type {
  ExtrapolationGraphRecord,
  ExtrapolationNodeRecord,
  ExtrapolationNodeSeedInput,
} from "./types.js";

export type RevisionInvocation = {
  graph: ExtrapolationGraphRecord;
  nodes: ReadonlyArray<ExtrapolationNodeRecord>;
  evidence: unknown;
};

export type RevisionDelta = {
  added: ReadonlyArray<ExtrapolationNodeSeedInput>;
  resolved: ReadonlyArray<{ nodeId: string; resolution: string }>;
  invalidated: ReadonlyArray<{ nodeId: string; reason: string }>;
};

/**
 * Phase 2 wiring point: model-driven revision pass.
 * Not implemented in Phase 1.
 */
export function runRevisionPass(_invocation: RevisionInvocation): Promise<RevisionDelta> {
  throw new Error("extrapolation revision runtime is not implemented in Phase 1");
}
