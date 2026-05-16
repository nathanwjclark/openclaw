/**
 * Build a small motivation prefix from a graph's backward-chain nodes.
 *
 * When a subagent is spawned because an extrapolation node was promoted,
 * the child should see the *why* the parent already reasoned about
 * (purpose, role context, business context, stakeholders) so it does not
 * re-derive that context from scratch.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGraph, getNodesForGraph } from "./registry.js";
import type { ExtrapolationNodeKind, ExtrapolationNodeRecord } from "./types.js";

const log = createSubsystemLogger("extrapolation");

const KIND_LABELS: Readonly<Record<ExtrapolationNodeKind, string>> = {
  forward_branch: "Forward branch",
  contingency: "Contingency",
  dependency: "Dependency",
  purpose: "Purpose",
  role_context: "Role context",
  business_context: "Business context",
  stakeholder: "Stakeholder",
  gap: "Gap",
  assumption: "Assumption",
  invalidator: "Invalidator",
};

export const BACKWARD_CHAIN_PREFIX_MAX_NODES = 6;
export const BACKWARD_CHAIN_PREFIX_MAX_LINE_CHARS = 240;

export type BuildBackwardChainPrefixInput = {
  graphId: string;
  /** Forward node being promoted; its ancestor chain is included when present. */
  nodeId?: string;
};

function isUsable(node: ExtrapolationNodeRecord): boolean {
  return node.status !== "pruned" && node.status !== "invalidated";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function collectAncestorChain(
  startId: string,
  byId: ReadonlyMap<string, ExtrapolationNodeRecord>,
): ExtrapolationNodeRecord[] {
  const chain: ExtrapolationNodeRecord[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = startId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) {
      break;
    }
    chain.push(node);
    cursor = node.parentNodeId;
  }
  return chain;
}

/**
 * Build a short, deterministic context prefix using the graph's backward nodes
 * and the source node's ancestor chain. Returns `undefined` when there is
 * nothing meaningful to inject so the caller can keep the original task text.
 */
export function buildBackwardChainPrefix(input: BuildBackwardChainPrefixInput): string | undefined {
  const graph = getGraph(input.graphId);
  if (!graph) {
    return undefined;
  }

  const nodes = getNodesForGraph(input.graphId);
  const byId = new Map(nodes.map((n) => [n.nodeId, n] as const));

  const backwardNodes = nodes
    .filter((n) => n.direction === "backward" && isUsable(n))
    // Deterministic order so cache-friendly prefixes are stable across ticks.
    .toSorted((a, b) => a.createdAt - b.createdAt || a.nodeId.localeCompare(b.nodeId));

  const ancestorChain = input.nodeId
    ? collectAncestorChain(input.nodeId, byId).filter(
        (n) => n.nodeId !== input.nodeId && isUsable(n),
      )
    : [];

  if (backwardNodes.length === 0 && ancestorChain.length === 0) {
    // Nothing meaningful to add beyond the root request — skip the prefix so we
    // do not bloat the spawned task with empty framing.
    return undefined;
  }

  const lines: string[] = [];
  lines.push(`Root request: ${truncate(graph.rootRequest, BACKWARD_CHAIN_PREFIX_MAX_LINE_CHARS)}`);
  for (const n of backwardNodes.slice(0, BACKWARD_CHAIN_PREFIX_MAX_NODES)) {
    lines.push(
      `- ${KIND_LABELS[n.kind]}: ${truncate(n.content, BACKWARD_CHAIN_PREFIX_MAX_LINE_CHARS)}`,
    );
  }
  for (const n of ancestorChain.slice(0, BACKWARD_CHAIN_PREFIX_MAX_NODES)) {
    lines.push(
      `- Ancestor (${KIND_LABELS[n.kind]}): ${truncate(n.content, BACKWARD_CHAIN_PREFIX_MAX_LINE_CHARS)}`,
    );
  }
  if (input.nodeId) {
    const source = byId.get(input.nodeId);
    if (source) {
      lines.push(
        `- ${KIND_LABELS[source.kind]}: ${truncate(source.content, BACKWARD_CHAIN_PREFIX_MAX_LINE_CHARS)}`,
      );
    }
  }

  log.debug("backward_chain.prefix_built", {
    event: "backward_chain.prefix_built",
    graphId: graph.graphId,
    nodeId: input.nodeId,
    backwardCount: backwardNodes.length,
    ancestorCount: ancestorChain.length,
  });

  return [
    "Context from extrapolation graph (why this task exists):",
    ...lines,
    "",
    "Original task:",
  ].join("\n");
}

/**
 * Prepend the backward-chain prefix to a task description. Returns the
 * original task string when no prefix is available (graph missing, no
 * backward context, etc.) so callers can wire this in unconditionally.
 */
export function applyBackwardChainPrefix(
  task: string,
  input: BuildBackwardChainPrefixInput,
): string {
  const prefix = buildBackwardChainPrefix(input);
  if (!prefix) {
    return task;
  }
  return `${prefix}\n${task}`;
}
