import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { AgentTaskRateLimitError, createAgentTaskRecord } from "../../tasks/agent-task-create.js";
import type { TaskNotifyPolicy } from "../../tasks/task-registry.types.js";
import { type AnyAgentTool, jsonResult, readStringParam, ToolInputError } from "./common.js";

const log = createSubsystemLogger("tasks/agent-tool");

const TASKS_TOOL_DISPLAY_SUMMARY = "Create durable follow-up tasks";

const TASKS_TOOL_DESCRIPTION = `Create durable tasks that outlive this session.

USE THIS TOOL when you need to track work that should persist beyond the current turn — open follow-ups, things the user can review in 'openclaw tasks list', or items a future session should pick up. Do NOT use it for within-session step tracking — use 'update_plan' for that.

ACTIONS:
- create(task, [label], [kind], [parent_task_id], [parent_flow_id], [extrapolation_graph_id], [extrapolation_node_id]): create a new queued task scoped to this session's owner. 'task' is the description (required). 'label' is a short title. 'kind' is a free-form category. Returns { task_id, status: "queued" }.

Notes:
- Tasks start as 'queued'. Status lifecycle (update_progress / complete) lands in a follow-up phase.
- Identical active (owner, task, label) calls are deduplicated — repeating a create returns the existing task_id.
- There is a rate cap on active agent-created tasks per owner; if reached, complete or wait for existing tasks before creating more.`;

const TasksToolSchema = Type.Object({
  action: Type.Union([Type.Literal("create")]),
  task: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  kind: Type.Optional(Type.String()),
  parent_task_id: Type.Optional(Type.String()),
  parent_flow_id: Type.Optional(Type.String()),
  notify_policy: Type.Optional(
    Type.Union([Type.Literal("done_only"), Type.Literal("state_changes"), Type.Literal("silent")]),
  ),
  extrapolation_graph_id: Type.Optional(Type.String()),
  extrapolation_node_id: Type.Optional(Type.String()),
});

export type CreateTasksToolOptions = {
  agentId?: string;
  ownerKey: string;
  sessionKey: string;
  config?: OpenClawConfig;
};

function readNotifyPolicy(params: Record<string, unknown>): TaskNotifyPolicy | undefined {
  const raw = params.notify_policy;
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "done_only" || raw === "state_changes" || raw === "silent") {
    return raw;
  }
  throw new ToolInputError(
    `tasks.create: notify_policy must be one of "done_only" | "state_changes" | "silent"`,
  );
}

function handleCreate(params: Record<string, unknown>, opts: CreateTasksToolOptions): unknown {
  const task = readStringParam(params, "task", { required: true });
  const label = readStringParam(params, "label");
  const kind = readStringParam(params, "kind");
  const parentTaskId = readStringParam(params, "parent_task_id");
  const parentFlowId = readStringParam(params, "parent_flow_id");
  const extrapolationGraphId = readStringParam(params, "extrapolation_graph_id");
  const extrapolationNodeId = readStringParam(params, "extrapolation_node_id");
  const notifyPolicy = readNotifyPolicy(params);

  try {
    const record = createAgentTaskRecord({
      ownerKey: opts.ownerKey,
      sessionKey: opts.sessionKey,
      task,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(kind !== undefined ? { taskKind: kind } : {}),
      ...(parentTaskId !== undefined ? { parentTaskId } : {}),
      ...(parentFlowId !== undefined ? { parentFlowId } : {}),
      ...(notifyPolicy !== undefined ? { notifyPolicy } : {}),
      ...(extrapolationGraphId !== undefined ? { extrapolationGraphId } : {}),
      ...(extrapolationNodeId !== undefined ? { extrapolationNodeId } : {}),
    });
    log.info("agent_task.created", {
      event: "agent_task.created",
      taskId: record.taskId,
      ownerKey: opts.ownerKey,
      sessionKey: opts.sessionKey,
      agentId: opts.agentId,
      ...(label ? { label } : {}),
    });
    return jsonResult({
      status: "ok",
      task_id: record.taskId,
      task_status: record.status,
      ...(record.label ? { label: record.label } : {}),
    });
  } catch (error) {
    if (error instanceof AgentTaskRateLimitError) {
      return jsonResult({
        status: "rate_limited",
        message: error.message,
        active_count: error.activeCount,
        limit: error.limit,
      });
    }
    throw error;
  }
}

export function createTasksTool(opts: CreateTasksToolOptions): AnyAgentTool {
  return {
    label: "Tasks",
    name: "tasks",
    displaySummary: TASKS_TOOL_DISPLAY_SUMMARY,
    description: TASKS_TOOL_DESCRIPTION,
    parameters: TasksToolSchema,
    execute: async (_toolCallId, args) => {
      const params =
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {};
      const action = readStringParam(params, "action", { required: true });
      switch (action) {
        case "create":
          return handleCreate(params, opts) as Awaited<ReturnType<AnyAgentTool["execute"]>>;
        default:
          throw new ToolInputError(`tasks: unknown action "${action}". Use create.`);
      }
    },
  };
}

export function isAgentTasksToolEnabled(config?: OpenClawConfig): boolean {
  return config?.tools?.experimental?.agentTasks === true;
}
