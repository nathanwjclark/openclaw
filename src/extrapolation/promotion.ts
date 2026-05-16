import { createSubsystemLogger } from "../logging/subsystem.js";
import { bumpGraphIteration, getGraph, getNode, getNodesForGraph, updateNode } from "./registry.js";
import type { ExtrapolationNodeRecord } from "./types.js";

const log = createSubsystemLogger("extrapolation");
const EXTRAPOLATION_FLOW_CONTROLLER_ID = "core/extrapolation";

export type PromoteFromSpawnInput = {
  graphId: string;
  nodeId: string;
  /** Subagent runId stamped onto the task_runs row. */
  runId: string;
  childSessionKey: string;
  now?: number;
  /** Test injection: links a task (by runId) to a flow. */
  linkTaskByRunIdToFlow?: (args: { runId: string; flowId: string }) => void;
  /** Test injection: builds a managed flow and returns its id. */
  createManagedFlow?: (args: {
    ownerKey: string;
    goal: string;
    stateJson: Record<string, unknown>;
    controllerId: string;
  }) => string | undefined;
};

export type PromoteFromSpawnOutcome = {
  promoted: boolean;
  flowId?: string;
  promotionCount: number;
  skippedReason?: string;
};

function defaultLinkTaskByRunIdToFlow(args: { runId: string; flowId: string }): void {
  // Lazy-import the task registry so this module stays usable outside the runtime
  // (and so tests can swap it out without faking the whole registry).
  void import("../tasks/task-registry.js").then((mod) => {
    const task = mod.findTaskByRunId(args.runId);
    if (!task) {
      return;
    }
    try {
      mod.linkTaskToFlowById({ taskId: task.taskId, flowId: args.flowId });
    } catch (err) {
      log.warn("promotion.link_task_to_flow_failed", {
        event: "promotion.link_task_to_flow_failed",
        runId: args.runId,
        flowId: args.flowId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

async function createManagedFlowLazy(args: {
  ownerKey: string;
  goal: string;
  stateJson: Record<string, string>;
  controllerId: string;
}): Promise<string | undefined> {
  try {
    const mod = await import("../tasks/task-flow-registry.js");
    const flow = mod.createManagedTaskFlow({
      ownerKey: args.ownerKey,
      goal: args.goal,
      stateJson: args.stateJson,
      controllerId: args.controllerId,
    });
    return flow.flowId;
  } catch (err) {
    log.warn("promotion.create_flow_failed", {
      event: "promotion.create_flow_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function countPromotedNodes(nodes: ReadonlyArray<ExtrapolationNodeRecord>): number {
  let count = 0;
  for (const n of nodes) {
    if (n.status === "promoted" || n.status === "resolved" || n.status === "invalidated") {
      // Only count nodes that were actually promoted to a subagent task — heuristic:
      // promotedTaskId set indicates "we spawned a task from this node".
      if (n.promotedTaskId) {
        count += 1;
      }
    }
  }
  return count;
}

export async function promoteExtrapolationNodeAfterSpawn(
  input: PromoteFromSpawnInput,
): Promise<PromoteFromSpawnOutcome> {
  const graph = getGraph(input.graphId);
  if (!graph) {
    return { promoted: false, promotionCount: 0, skippedReason: "graph_not_found" };
  }
  if (graph.status !== "active") {
    return {
      promoted: false,
      promotionCount: 0,
      skippedReason: `graph_status_${graph.status}`,
    };
  }
  const sourceNode = getNode(input.nodeId);
  if (!sourceNode || sourceNode.graphId !== input.graphId) {
    return { promoted: false, promotionCount: 0, skippedReason: "node_not_found" };
  }
  if (sourceNode.status !== "open") {
    return {
      promoted: false,
      promotionCount: 0,
      skippedReason: `node_status_${sourceNode.status}`,
    };
  }

  try {
    updateNode(
      input.nodeId,
      {
        status: "promoted",
        promotedTaskId: input.runId,
        promotedChildSessionKey: input.childSessionKey,
      },
      input.now != null ? { now: input.now } : {},
    );
  } catch (err) {
    log.warn("promotion.update_node_failed", {
      event: "promotion.update_node_failed",
      graphId: input.graphId,
      nodeId: input.nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { promoted: false, promotionCount: 0, skippedReason: "update_node_failed" };
  }

  const refreshed = getNodesForGraph(input.graphId);
  const promotionCount = countPromotedNodes(refreshed);

  let flowId: string | undefined = graph.flowId;
  if (promotionCount === 2 && !flowId) {
    const create = input.createManagedFlow ?? null;
    const created = create
      ? create({
          ownerKey: graph.ownerKey,
          goal: graph.rootRequest,
          stateJson: { extrapolation_graph_id: graph.graphId },
          controllerId: EXTRAPOLATION_FLOW_CONTROLLER_ID,
        })
      : await createManagedFlowLazy({
          ownerKey: graph.ownerKey,
          goal: graph.rootRequest,
          stateJson: { extrapolation_graph_id: graph.graphId },
          controllerId: EXTRAPOLATION_FLOW_CONTROLLER_ID,
        });
    if (created) {
      flowId = created;
      try {
        bumpGraphIteration(
          graph.graphId,
          "revision",
          {
            source: "promotion",
            flowId: created,
            promotionCount,
          },
          {
            flowId: created,
            ...(input.now != null ? { now: input.now } : {}),
          },
        );
      } catch (err) {
        log.warn("promotion.stamp_flow_failed", {
          event: "promotion.stamp_flow_failed",
          graphId: graph.graphId,
          flowId: created,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Link the two existing promoted tasks to the new flow.
      const linkFn = input.linkTaskByRunIdToFlow ?? defaultLinkTaskByRunIdToFlow;
      for (const node of refreshed) {
        if (node.status === "promoted" && node.promotedTaskId) {
          linkFn({ runId: node.promotedTaskId, flowId: created });
        }
      }
    }
  } else if (flowId && promotionCount >= 3) {
    // 3rd+ promotion: just link this task to the existing flow.
    const linkFn = input.linkTaskByRunIdToFlow ?? defaultLinkTaskByRunIdToFlow;
    linkFn({ runId: input.runId, flowId });
  }

  log.info("promotion.complete", {
    event: "promotion.complete",
    graphId: graph.graphId,
    nodeId: input.nodeId,
    promotionCount,
    flowId,
  });

  return {
    promoted: true,
    promotionCount,
    ...(flowId ? { flowId } : {}),
  };
}
