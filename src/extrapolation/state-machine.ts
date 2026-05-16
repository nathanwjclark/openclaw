import type { ExtrapolationGraphStatus, ExtrapolationNodeStatus } from "./types.js";

const GRAPH_TRANSITIONS: Readonly<
  Record<ExtrapolationGraphStatus, ReadonlySet<ExtrapolationGraphStatus>>
> = {
  active: new Set<ExtrapolationGraphStatus>(["resolved", "abandoned"]),
  resolved: new Set<ExtrapolationGraphStatus>(),
  abandoned: new Set<ExtrapolationGraphStatus>(),
};

const NODE_TRANSITIONS: Readonly<
  Record<ExtrapolationNodeStatus, ReadonlySet<ExtrapolationNodeStatus>>
> = {
  open: new Set<ExtrapolationNodeStatus>(["resolved", "pruned", "promoted", "invalidated"]),
  // Promoted nodes can resolve (subtask finished) or invalidate (subtask failed irrecoverably).
  promoted: new Set<ExtrapolationNodeStatus>(["resolved", "invalidated", "pruned"]),
  resolved: new Set<ExtrapolationNodeStatus>(),
  pruned: new Set<ExtrapolationNodeStatus>(),
  invalidated: new Set<ExtrapolationNodeStatus>(),
};

export function canTransitionGraph(
  from: ExtrapolationGraphStatus,
  to: ExtrapolationGraphStatus,
): boolean {
  return from === to || GRAPH_TRANSITIONS[from].has(to);
}

export function canTransitionNode(
  from: ExtrapolationNodeStatus,
  to: ExtrapolationNodeStatus,
): boolean {
  return from === to || NODE_TRANSITIONS[from].has(to);
}

export class ExtrapolationTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtrapolationTransitionError";
  }
}

export function assertGraphTransition(
  from: ExtrapolationGraphStatus,
  to: ExtrapolationGraphStatus,
): void {
  if (!canTransitionGraph(from, to)) {
    throw new ExtrapolationTransitionError(`invalid graph transition: ${from} -> ${to}`);
  }
}

export function assertNodeTransition(
  from: ExtrapolationNodeStatus,
  to: ExtrapolationNodeStatus,
): void {
  if (!canTransitionNode(from, to)) {
    throw new ExtrapolationTransitionError(`invalid node transition: ${from} -> ${to}`);
  }
}

export function isTerminalGraphStatus(status: ExtrapolationGraphStatus): boolean {
  return status === "resolved" || status === "abandoned";
}

export function isTerminalNodeStatus(status: ExtrapolationNodeStatus): boolean {
  return status === "resolved" || status === "pruned" || status === "invalidated";
}
