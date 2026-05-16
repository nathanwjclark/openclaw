import { resolveExtrapolationEnabled } from "../config/types.extrapolation.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getNodesForGraph, listGraphsForSession } from "./registry.js";
import type { ExtrapolationGraphRecord, ExtrapolationNodeRecord } from "./types.js";

export type ContextInjectionInput = {
  sessionKey: string;
  ownerKey?: string;
};

export type ContextInjectionResult = {
  /** Rendered system-prompt block, empty string when no active graphs. */
  rendered: string;
  /** Number of active graphs included. */
  graphCount: number;
};

const DEFAULT_GAP_RELEVANCE_THRESHOLD = 0.6;

function relevanceFloor(config: OpenClawConfig | undefined): number {
  return config?.extrapolation?.defaults?.gapRelevanceThreshold ?? DEFAULT_GAP_RELEVANCE_THRESHOLD;
}

function statusLabel(node: ExtrapolationNodeRecord): string {
  if (node.status === "promoted" && node.resolution) {
    return `promoted${node.promotedTaskId ? ` → task ${node.promotedTaskId}` : ""}, resolved`;
  }
  if (node.status === "promoted") {
    return `promoted${node.promotedTaskId ? ` → task ${node.promotedTaskId}` : ""}`;
  }
  return node.status;
}

function renderNodeLine(node: ExtrapolationNodeRecord): string {
  const rel = node.relevance.toFixed(2);
  const tail = node.resolution ? `: ${node.resolution}` : "";
  return `- [${statusLabel(node)}] ${node.content} (rel ${rel})${tail}`;
}

function partitionByKindGroup(nodes: ExtrapolationNodeRecord[]) {
  const backward: ExtrapolationNodeRecord[] = [];
  const forward: ExtrapolationNodeRecord[] = [];
  const gaps: ExtrapolationNodeRecord[] = [];
  const assumptions: ExtrapolationNodeRecord[] = [];
  const invalidators: ExtrapolationNodeRecord[] = [];
  for (const node of nodes) {
    if (node.status === "pruned") {
      continue;
    }
    if (node.direction === "backward") {
      backward.push(node);
    } else if (node.direction === "forward") {
      forward.push(node);
    } else if (node.kind === "gap") {
      gaps.push(node);
    } else if (node.kind === "assumption") {
      assumptions.push(node);
    } else if (node.kind === "invalidator") {
      invalidators.push(node);
    }
  }
  return { backward, forward, gaps, assumptions, invalidators };
}

function renderGraph(
  graph: ExtrapolationGraphRecord,
  allNodes: ExtrapolationNodeRecord[],
  relevanceMin: number,
): string {
  const lines: string[] = [];
  lines.push(`### Graph: ${graph.rootRequest} [${graph.status}, iteration ${graph.iteration}]`);

  const groups = partitionByKindGroup(allNodes);

  if (groups.backward.length > 0) {
    lines.push("", "**Purpose chain (backward):**");
    for (const node of groups.backward) {
      lines.push(`- ${node.kind.replace(/_/g, " ")}: ${node.content}`);
    }
  }

  if (groups.forward.length > 0) {
    lines.push("", "**Forward branches:**");
    for (const node of groups.forward) {
      lines.push(renderNodeLine(node));
    }
  }

  const visibleGaps = groups.gaps.filter(
    (node) => node.status === "open" && node.relevance >= relevanceMin,
  );
  if (visibleGaps.length > 0) {
    lines.push("", `**Open gaps (relevance ≥ ${relevanceMin.toFixed(2)}):**`);
    for (const node of visibleGaps) {
      lines.push(`- ${node.content} (rel ${node.relevance.toFixed(2)})`);
    }
  }

  if (groups.assumptions.length > 0) {
    lines.push("", "**Assumptions:**");
    for (const node of groups.assumptions) {
      lines.push(`- ${node.content}`);
    }
  }

  if (groups.invalidators.length > 0) {
    lines.push("", "**Invalidators to watch:**");
    for (const node of groups.invalidators) {
      lines.push(`- ${node.content}`);
    }
  }

  return lines.join("\n");
}

export function renderExtrapolationContext(
  input: ContextInjectionInput,
  options: { config?: OpenClawConfig } = {},
): ContextInjectionResult {
  const graphs = listGraphsForSession(input.sessionKey).filter((g) => g.status === "active");
  if (graphs.length === 0) {
    return { rendered: "", graphCount: 0 };
  }
  const relevanceMin = relevanceFloor(options.config);
  const blocks: string[] = ["## Active extrapolation graphs"];
  for (const graph of graphs) {
    const nodes = getNodesForGraph(graph.graphId).slice(0, graph.budgetNodes);
    blocks.push("", renderGraph(graph, nodes, relevanceMin));
  }
  return { rendered: blocks.join("\n"), graphCount: graphs.length };
}

export type RunExtrapolationContextInput = {
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
};

export function renderExtrapolationContextForRun(
  input: RunExtrapolationContextInput,
): ContextInjectionResult {
  const sessionKey = input.sessionKey?.trim();
  const agentId = input.agentId?.trim();
  if (!sessionKey || !agentId) {
    return { rendered: "", graphCount: 0 };
  }
  if (!resolveExtrapolationEnabled(input.config?.extrapolation, agentId)) {
    return { rendered: "", graphCount: 0 };
  }
  return renderExtrapolationContext({ sessionKey }, { config: input.config });
}

export function mergeExtraSystemPrompts(...parts: Array<string | undefined>): string | undefined {
  const filtered = parts.map((p) => p?.trim()).filter((p): p is string => !!p);
  if (filtered.length === 0) {
    return undefined;
  }
  return filtered.join("\n\n");
}
