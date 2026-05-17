import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  AgentTaskNotFoundError,
  AgentTaskOwnershipError,
  AgentTaskRateLimitError,
  AgentTaskTerminalError,
  AgentTaskWrongRuntimeError,
  completeAgentTask,
  createAgentTaskRecord,
  updateAgentTaskProgress,
} from "../../tasks/agent-task-create.js";
import { getTaskById, listTasksForOwnerKey } from "../../tasks/runtime-internal.js";
import type {
  TaskNotifyPolicy,
  TaskRecord,
  TaskStatus,
  TaskTerminalOutcome,
} from "../../tasks/task-registry.types.js";
import { type AnyAgentTool, jsonResult, readStringParam, ToolInputError } from "./common.js";

const log = createSubsystemLogger("tasks/agent-tool");

const TASKS_TOOL_DISPLAY_SUMMARY = "Create durable follow-up tasks";

const TASKS_TOOL_DESCRIPTION = `Create and manage durable tasks that outlive this session.

The active task list is auto-injected into your context at the start of every turn (see "Open tasks" block). Use this tool to mutate it.

USE THIS TOOL when you need to track work that should persist beyond the current turn — open follow-ups, things the user can review in 'openclaw tasks list', or items a future session should pick up. Do NOT use it for within-session step tracking — use 'update_plan' for that.

ACTIONS:
- create(task, [label], [kind], [parent_task_id], [parent_flow_id], [extrapolation_graph_id], [extrapolation_node_id]): create a new queued task. 'task' is the description (required). 'label' is a short title. 'kind' is a free-form category. Returns { task_id, task_status: "queued" }.
- update_progress(task_id, progress_summary): write a short progress note onto an existing agent task. Moves status from 'queued' to 'running' on the first call. Returns { task_id, task_status }.
- complete(task_id, outcome, [terminal_summary]): mark an agent task terminal. 'outcome' is "succeeded" if you finished the work, "blocked" if you're stopping early. 'terminal_summary' is a short closing note (optional but recommended). Returns { task_id, task_status, terminal_outcome }.
- list_mine([status], [include_terminal], [limit]): list all tasks visible to this install, across runtimes and sessions. By default returns active (queued, running) plus recent terminal. Pass status="queued" etc. to filter, include_terminal=false to drop terminal entirely, limit to cap the response. Use this to orient if the auto-injected block is missing context you need.
- get(task_id): fetch full detail on one task (progress/terminal summaries, linkage). Returns { task: { ... } } or { status: "not_found" }.

Notes:
- Tasks start as 'queued'. Call update_progress when you start work, complete when you're done.
- Tasks live indefinitely once terminal — they're a permanent audit log, not garbage-collected.
- Identical active (task, label) creates dedupe — repeating returns the existing task_id.
- There is a rate cap on active agent-created tasks. Complete tasks before creating more.
- Scope is global on this install: tasks are visible / mutable regardless of which Slack channel, thread, or subagent created them. Use 'session_key' on each record to judge whether a task originated in the session you're currently driving.
- Tasks from non-agent runtimes are read-only via this tool. To act on them, use the runtime-specific tool: 'subagents' (action="kill") to terminate a subagent task, 'cron' (action="remove") to remove a cron job. ACP and CLI runtime tasks are operator-managed — users cancel via 'openclaw tasks cancel'; do not try to manipulate them from here. Use complete(outcome="blocked") on your own agent task if you're stopping early.`;

const TasksToolSchema = Type.Object({
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("update_progress"),
    Type.Literal("complete"),
    Type.Literal("list_mine"),
    Type.Literal("get"),
  ]),
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
  task_id: Type.Optional(Type.String()),
  progress_summary: Type.Optional(Type.String()),
  outcome: Type.Optional(Type.Union([Type.Literal("succeeded"), Type.Literal("blocked")])),
  terminal_summary: Type.Optional(Type.String()),
  status: Type.Optional(
    Type.Union([
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("timed_out"),
      Type.Literal("cancelled"),
      Type.Literal("lost"),
    ]),
  ),
  include_terminal: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
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

function readOutcome(params: Record<string, unknown>): TaskTerminalOutcome {
  const raw = params.outcome;
  if (raw === "succeeded" || raw === "blocked") {
    return raw;
  }
  throw new ToolInputError(`tasks.complete: outcome must be one of "succeeded" | "blocked"`);
}

function mapAgentTaskErrorToToolResult(error: unknown): unknown {
  if (error instanceof AgentTaskNotFoundError) {
    return jsonResult({ status: "not_found", task_id: error.taskId, message: error.message });
  }
  if (error instanceof AgentTaskOwnershipError) {
    return jsonResult({
      status: "ownership_mismatch",
      task_id: error.taskId,
      message: error.message,
    });
  }
  if (error instanceof AgentTaskWrongRuntimeError) {
    return jsonResult({
      status: "wrong_runtime",
      task_id: error.taskId,
      runtime: error.runtime,
      message: error.message,
    });
  }
  if (error instanceof AgentTaskTerminalError) {
    return jsonResult({
      status: "already_terminal",
      task_id: error.taskId,
      task_status: error.status,
      message: error.message,
    });
  }
  return undefined;
}

function handleUpdateProgress(
  params: Record<string, unknown>,
  opts: CreateTasksToolOptions,
): unknown {
  const taskId = readStringParam(params, "task_id", { required: true });
  const progressSummary = readStringParam(params, "progress_summary", { required: true });
  try {
    const record = updateAgentTaskProgress({
      taskId,
      ownerKey: opts.ownerKey,
      progressSummary,
    });
    log.info("agent_task.progress_updated", {
      event: "agent_task.progress_updated",
      taskId: record.taskId,
      ownerKey: opts.ownerKey,
      sessionKey: opts.sessionKey,
    });
    return jsonResult({
      status: "ok",
      task_id: record.taskId,
      task_status: record.status,
    });
  } catch (error) {
    const mapped = mapAgentTaskErrorToToolResult(error);
    if (mapped) {
      return mapped;
    }
    throw error;
  }
}

function handleComplete(params: Record<string, unknown>, opts: CreateTasksToolOptions): unknown {
  const taskId = readStringParam(params, "task_id", { required: true });
  const outcome = readOutcome(params);
  const terminalSummary = readStringParam(params, "terminal_summary");
  try {
    const record = completeAgentTask({
      taskId,
      ownerKey: opts.ownerKey,
      outcome,
      ...(terminalSummary !== undefined ? { terminalSummary } : {}),
    });
    log.info("agent_task.completed", {
      event: "agent_task.completed",
      taskId: record.taskId,
      ownerKey: opts.ownerKey,
      sessionKey: opts.sessionKey,
      outcome,
      taskStatus: record.status,
    });
    return jsonResult({
      status: "ok",
      task_id: record.taskId,
      task_status: record.status,
      terminal_outcome: record.terminalOutcome,
    });
  } catch (error) {
    const mapped = mapAgentTaskErrorToToolResult(error);
    if (mapped) {
      return mapped;
    }
    throw error;
  }
}

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
]);

const DEFAULT_LIST_MINE_LIMIT = 50;
const SUMMARY_TRUNCATE_CHARS = 200;

function truncateForAgent(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length <= SUMMARY_TRUNCATE_CHARS
    ? trimmed
    : `${trimmed.slice(0, SUMMARY_TRUNCATE_CHARS - 1)}…`;
}

function projectTaskForAgent(task: TaskRecord): Record<string, unknown> {
  const progress = truncateForAgent(task.progressSummary);
  const terminalText = truncateForAgent(task.terminalSummary);
  return {
    task_id: task.taskId,
    runtime: task.runtime,
    status: task.status,
    task: task.task,
    ...(task.label ? { label: task.label } : {}),
    ...(task.taskKind ? { kind: task.taskKind } : {}),
    owner_key: task.ownerKey,
    session_key: task.requesterSessionKey,
    ...(task.agentId ? { agent_id: task.agentId } : {}),
    ...(task.childSessionKey ? { child_session_key: task.childSessionKey } : {}),
    ...(task.runId ? { run_id: task.runId } : {}),
    ...(task.parentTaskId ? { parent_task_id: task.parentTaskId } : {}),
    ...(task.parentFlowId ? { parent_flow_id: task.parentFlowId } : {}),
    ...(task.extrapolationGraphId ? { extrapolation_graph_id: task.extrapolationGraphId } : {}),
    ...(task.extrapolationNodeId ? { extrapolation_node_id: task.extrapolationNodeId } : {}),
    created_at: task.createdAt,
    ...(task.startedAt !== undefined ? { started_at: task.startedAt } : {}),
    ...(task.endedAt !== undefined ? { ended_at: task.endedAt } : {}),
    ...(task.lastEventAt !== undefined ? { last_event_at: task.lastEventAt } : {}),
    ...(progress ? { progress_summary: progress } : {}),
    ...(terminalText ? { terminal_summary: terminalText } : {}),
    ...(task.terminalOutcome ? { terminal_outcome: task.terminalOutcome } : {}),
  };
}

function readStatusFilter(params: Record<string, unknown>): TaskStatus | undefined {
  const raw = params.status;
  if (raw === undefined) {
    return undefined;
  }
  if (
    raw === "queued" ||
    raw === "running" ||
    raw === "succeeded" ||
    raw === "failed" ||
    raw === "timed_out" ||
    raw === "cancelled" ||
    raw === "lost"
  ) {
    return raw;
  }
  throw new ToolInputError(`tasks.list_mine: status must be a valid TaskStatus literal`);
}

function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const raw = params[key];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "boolean") {
    throw new ToolInputError(`tasks.list_mine: ${key} must be a boolean`);
  }
  return raw;
}

function readLimit(params: Record<string, unknown>): number {
  const raw = params.limit;
  if (raw === undefined) {
    return DEFAULT_LIST_MINE_LIMIT;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new ToolInputError(`tasks.list_mine: limit must be a positive integer`);
  }
  return Math.min(Math.floor(raw), 200);
}

function handleListMine(params: Record<string, unknown>, opts: CreateTasksToolOptions): unknown {
  const statusFilter = readStatusFilter(params);
  const includeTerminal = readBooleanParam(params, "include_terminal");
  const limit = readLimit(params);
  const owner = opts.ownerKey;

  const all = listTasksForOwnerKey(owner);
  const active: TaskRecord[] = [];
  const terminal: TaskRecord[] = [];
  for (const task of all) {
    if (statusFilter && task.status !== statusFilter) {
      continue;
    }
    if (TERMINAL_STATUSES.has(task.status)) {
      terminal.push(task);
    } else {
      active.push(task);
    }
  }
  active.sort((a, b) => a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId));
  terminal.sort((a, b) => {
    const aEnd = a.endedAt ?? a.lastEventAt ?? a.createdAt;
    const bEnd = b.endedAt ?? b.lastEventAt ?? b.createdAt;
    if (bEnd !== aEnd) {
      return bEnd - aEnd;
    }
    return a.taskId.localeCompare(b.taskId);
  });

  let combined: TaskRecord[];
  if (statusFilter) {
    combined = TERMINAL_STATUSES.has(statusFilter) ? terminal : active;
  } else if (includeTerminal === false) {
    combined = active;
  } else {
    const terminalBudget = Math.max(0, limit - active.length);
    combined = [...active, ...terminal.slice(0, terminalBudget)];
  }
  const sliced = combined.slice(0, limit);
  return jsonResult({
    status: "ok",
    owner_key: owner,
    active_count: active.length,
    terminal_count: terminal.length,
    returned_count: sliced.length,
    tasks: sliced.map((task) => projectTaskForAgent(task)),
  });
}

function handleGet(params: Record<string, unknown>, _opts: CreateTasksToolOptions): unknown {
  const taskId = readStringParam(params, "task_id", { required: true });
  const record = getTaskById(taskId);
  if (!record) {
    return jsonResult({ status: "not_found", task_id: taskId });
  }
  // Reads are ungated under the global-owner convention (see GLOBAL_OWNER_KEY).
  return jsonResult({ status: "ok", task: projectTaskForAgent(record) });
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
        case "update_progress":
          return handleUpdateProgress(params, opts) as Awaited<ReturnType<AnyAgentTool["execute"]>>;
        case "complete":
          return handleComplete(params, opts) as Awaited<ReturnType<AnyAgentTool["execute"]>>;
        case "list_mine":
          return handleListMine(params, opts) as Awaited<ReturnType<AnyAgentTool["execute"]>>;
        case "get":
          return handleGet(params, opts) as Awaited<ReturnType<AnyAgentTool["execute"]>>;
        default:
          throw new ToolInputError(
            `tasks: unknown action "${action}". Use create | update_progress | complete | list_mine | get.`,
          );
      }
    },
  };
}

export function isAgentTasksToolEnabled(config?: OpenClawConfig): boolean {
  // Default on: the durable task ledger is the central backlog the agent reads at wake time.
  // Operators can explicitly disable via `tools.experimental.agentTasks: false`.
  return config?.tools?.experimental?.agentTasks !== false;
}
