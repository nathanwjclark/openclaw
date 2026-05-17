import { parseAgentSessionKey } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
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
import { cancelDetachedTaskRunById } from "../../tasks/detached-task-runtime.js";
import { getTaskById, listTaskRecords } from "../../tasks/runtime-internal.js";
import type { TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import {
  TASK_STATUS_DETAIL_MAX_CHARS,
  formatTaskStatusTitle,
  sanitizeTaskStatusText,
} from "../../tasks/task-status.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type TaskSummary,
  type TasksListParams,
  validateTasksCancelParams,
  validateTasksCompleteParams,
  validateTasksCreateParams,
  validateTasksGetParams,
  validateTasksListParams,
  validateTasksUpdateProgressParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_TASKS_LIST_LIMIT = 100;
const MAX_TASKS_LIST_LIMIT = 500;

type TaskLedgerStatus = TaskSummary["status"];

const TASK_STATUS_TO_LEDGER_STATUS: Record<TaskStatus, TaskLedgerStatus> = {
  queued: "queued",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  timed_out: "timed_out",
  cancelled: "cancelled",
  lost: "failed",
};

const TASK_CREATE_MAX_TASK_CHARS = 4_000;
const TASK_CREATE_MAX_LABEL_CHARS = 200;
const TASK_CREATE_MAX_KIND_CHARS = 80;

function mapAgentTaskErrorToRespond(
  error: unknown,
  respond: (ok: boolean, payload?: unknown, err?: ReturnType<typeof errorShape>) => void,
): boolean {
  if (
    error instanceof AgentTaskNotFoundError ||
    error instanceof AgentTaskOwnershipError ||
    error instanceof AgentTaskWrongRuntimeError ||
    error instanceof AgentTaskTerminalError
  ) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    return true;
  }
  return false;
}

const LEDGER_STATUS_TO_TASK_STATUSES: Record<TaskLedgerStatus, TaskStatus[]> = {
  queued: ["queued"],
  running: ["running"],
  completed: ["succeeded"],
  failed: ["failed", "lost"],
  timed_out: ["timed_out"],
  cancelled: ["cancelled"],
};

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

function sanitizeOptionalTaskText(
  value: unknown,
  opts?: { errorContext?: boolean },
): string | undefined {
  const sanitized = sanitizeTaskStatusText(value, {
    errorContext: opts?.errorContext,
    maxChars: TASK_STATUS_DETAIL_MAX_CHARS,
  });
  return sanitized || undefined;
}

function mapTaskSummary(task: TaskRecord): TaskSummary {
  const progressSummary = sanitizeOptionalTaskText(task.progressSummary);
  const terminalSummary = sanitizeOptionalTaskText(task.terminalSummary, { errorContext: true });
  const error = sanitizeOptionalTaskText(task.error, { errorContext: true });
  return {
    id: task.taskId,
    taskId: task.taskId,
    kind: task.taskKind ?? task.runtime,
    runtime: task.runtime,
    status: TASK_STATUS_TO_LEDGER_STATUS[task.status],
    title: formatTaskStatusTitle(task),
    ...(task.agentId ? { agentId: task.agentId } : {}),
    sessionKey: task.requesterSessionKey,
    ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
    ownerKey: task.ownerKey,
    ...(task.runId ? { runId: task.runId } : {}),
    ...(task.parentFlowId ? { flowId: task.parentFlowId } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.sourceId ? { sourceId: task.sourceId } : {}),
    createdAt: task.createdAt,
    updatedAt: taskUpdatedAt(task),
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(progressSummary ? { progressSummary } : {}),
    ...(terminalSummary ? { terminalSummary } : {}),
    ...(error ? { error } : {}),
  };
}

function normalizeTaskStatusFilter(status: TasksListParams["status"]): Set<TaskStatus> | null {
  if (!status) {
    return null;
  }
  const statuses = Array.isArray(status) ? status : [status];
  return new Set(statuses.flatMap((value) => LEDGER_STATUS_TO_TASK_STATUSES[value] ?? []));
}

function taskMatchesSession(task: TaskRecord, sessionKey: string | undefined): boolean {
  const normalized = normalizeOptionalString(sessionKey);
  if (!normalized) {
    return true;
  }
  return [task.requesterSessionKey, task.childSessionKey, task.ownerKey].some(
    (candidate) => normalizeOptionalString(candidate) === normalized,
  );
}

function taskMatchesAgent(task: TaskRecord, agentId: string | undefined): boolean {
  const normalized = normalizeOptionalString(agentId);
  if (!normalized) {
    return true;
  }
  if (normalizeOptionalString(task.agentId) === normalized) {
    return true;
  }
  return [task.requesterSessionKey, task.childSessionKey, task.ownerKey].some(
    (candidate) => parseAgentSessionKey(candidate)?.agentId === normalized,
  );
}

function parseCursor(cursor: string | undefined): number | null {
  if (!cursor) {
    return 0;
  }
  if (!/^\d+$/.test(cursor.trim())) {
    return null;
  }
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export const tasksHandlers: GatewayRequestHandlers = {
  "tasks.list": ({ params, respond }) => {
    if (!validateTasksListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tasks.list params: ${formatValidationErrors(validateTasksListParams.errors)}`,
        ),
      );
      return;
    }
    const cursor = parseCursor(params.cursor);
    if (cursor === null) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid tasks.list cursor"),
      );
      return;
    }
    const statusFilter = normalizeTaskStatusFilter(params.status);
    const limit = Math.min(params.limit ?? DEFAULT_TASKS_LIST_LIMIT, MAX_TASKS_LIST_LIMIT);
    const filtered = listTaskRecords().filter((task) => {
      if (statusFilter && !statusFilter.has(task.status)) {
        return false;
      }
      return taskMatchesAgent(task, params.agentId) && taskMatchesSession(task, params.sessionKey);
    });
    const page = filtered.slice(cursor, cursor + limit);
    const nextOffset = cursor + page.length;
    respond(true, {
      tasks: page.map((task) => mapTaskSummary(task)),
      ...(nextOffset < filtered.length ? { nextCursor: String(nextOffset) } : {}),
    });
  },
  "tasks.get": ({ params, respond }) => {
    if (!validateTasksGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tasks.get params: ${formatValidationErrors(validateTasksGetParams.errors)}`,
        ),
      );
      return;
    }
    const taskId = params.taskId;
    const task = getTaskById(taskId);
    if (!task) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${taskId}`),
      );
      return;
    }
    respond(true, { task: mapTaskSummary(task) });
  },
  "tasks.create": ({ params, respond }) => {
    if (!validateTasksCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tasks.create params: ${formatValidationErrors(validateTasksCreateParams.errors)}`,
        ),
      );
      return;
    }
    const taskText = params.task.trim();
    if (!taskText) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid tasks.create params: task must not be blank",
        ),
      );
      return;
    }
    if (taskText.length > TASK_CREATE_MAX_TASK_CHARS) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tasks.create params: task exceeds ${TASK_CREATE_MAX_TASK_CHARS} characters`,
        ),
      );
      return;
    }
    const label = normalizeOptionalString(params.label);
    if (label !== undefined && label.length > TASK_CREATE_MAX_LABEL_CHARS) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tasks.create params: label exceeds ${TASK_CREATE_MAX_LABEL_CHARS} characters`,
        ),
      );
      return;
    }
    const taskKind = normalizeOptionalString(params.taskKind);
    if (taskKind !== undefined && taskKind.length > TASK_CREATE_MAX_KIND_CHARS) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tasks.create params: taskKind exceeds ${TASK_CREATE_MAX_KIND_CHARS} characters`,
        ),
      );
      return;
    }
    try {
      const record = createAgentTaskRecord({
        ownerKey: params.ownerKey,
        sessionKey: params.sessionKey,
        task: taskText,
        ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(taskKind !== undefined ? { taskKind } : {}),
        ...(params.parentTaskId !== undefined ? { parentTaskId: params.parentTaskId } : {}),
        ...(params.parentFlowId !== undefined ? { parentFlowId: params.parentFlowId } : {}),
        ...(params.notifyPolicy !== undefined ? { notifyPolicy: params.notifyPolicy } : {}),
        ...(params.extrapolationGraphId !== undefined
          ? { extrapolationGraphId: params.extrapolationGraphId }
          : {}),
        ...(params.extrapolationNodeId !== undefined
          ? { extrapolationNodeId: params.extrapolationNodeId }
          : {}),
      });
      respond(true, { task: mapTaskSummary(record) });
    } catch (error) {
      if (error instanceof AgentTaskRateLimitError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      throw error;
    }
  },
  "tasks.updateProgress": ({ params, respond }) => {
    if (!validateTasksUpdateProgressParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tasks.updateProgress params: ${formatValidationErrors(validateTasksUpdateProgressParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const record = updateAgentTaskProgress({
        taskId: params.taskId,
        ownerKey: params.ownerKey,
        progressSummary: params.progressSummary,
      });
      respond(true, { task: mapTaskSummary(record) });
    } catch (error) {
      if (mapAgentTaskErrorToRespond(error, respond)) {
        return;
      }
      throw error;
    }
  },
  "tasks.complete": ({ params, respond }) => {
    if (!validateTasksCompleteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tasks.complete params: ${formatValidationErrors(validateTasksCompleteParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const record = completeAgentTask({
        taskId: params.taskId,
        ownerKey: params.ownerKey,
        outcome: params.outcome,
        ...(params.terminalSummary !== undefined
          ? { terminalSummary: params.terminalSummary }
          : {}),
      });
      respond(true, { task: mapTaskSummary(record) });
    } catch (error) {
      if (mapAgentTaskErrorToRespond(error, respond)) {
        return;
      }
      throw error;
    }
  },
  "tasks.cancel": async ({ params, respond, context }) => {
    if (!validateTasksCancelParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tasks.cancel params: ${formatValidationErrors(validateTasksCancelParams.errors)}`,
        ),
      );
      return;
    }
    const taskId = params.taskId;
    const reason = normalizeOptionalString(params.reason);
    const result = await cancelDetachedTaskRunById({
      cfg: context.getRuntimeConfig(),
      taskId,
      ...(reason ? { reason } : {}),
    });
    respond(true, {
      found: result.found,
      cancelled: result.cancelled,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.task ? { task: mapTaskSummary(result.task) } : {}),
    });
  },
};

export const __test = {
  mapTaskSummary,
};
