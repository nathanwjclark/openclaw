/**
 * Phase 2 wiring point: the umbrella `extrapolation` agent tool.
 *
 * Actions:
 *  - seed(request, budget_nodes?)
 *  - update(node_id, patch)
 *  - revise(graph_id, evidence)
 *
 * Not implemented in Phase 1.
 */
export type ExtrapolationToolAction = "seed" | "update" | "revise";

export function buildExtrapolationAgentTool(): never {
  throw new Error("extrapolation agent tool is not implemented in Phase 1");
}
