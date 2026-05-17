import {
  attachSubagentRunToTaskById,
  createTaskRecord,
  getTaskById,
  listTasksForOwnerKey,
  markTaskRunningById,
  markTaskTerminalById,
  setTaskProgressById,
} from "./runtime-internal.js";
import type { TaskNotifyPolicy, TaskRecord, TaskTerminalOutcome } from "./task-registry.types.js";

export const DEFAULT_MAX_ACTIVE_AGENT_TASKS = 25;

export type CreateAgentTaskParams = {
  ownerKey: string;
  sessionKey: string;
  task: string;
  agentId?: string;
  label?: string;
  taskKind?: string;
  parentTaskId?: string;
  parentFlowId?: string;
  notifyPolicy?: TaskNotifyPolicy;
  extrapolationGraphId?: string;
  extrapolationNodeId?: string;
};

export class AgentTaskRateLimitError extends Error {
  readonly code = "agent_task_rate_limit";
  constructor(
    public readonly activeCount: number,
    public readonly limit: number,
  ) {
    super(
      `agent has ${activeCount} active tasks; create blocked at limit ${limit}. Complete existing tasks before creating more.`,
    );
    this.name = "AgentTaskRateLimitError";
  }
}

export function isAgentTaskRateLimitError(error: unknown): error is AgentTaskRateLimitError {
  return error instanceof AgentTaskRateLimitError;
}

function countActiveAgentTasksForOwner(ownerKey: string): number {
  let active = 0;
  for (const task of listTasksForOwnerKey(ownerKey)) {
    if (task.runtime !== "agent") {
      continue;
    }
    if (task.status === "queued" || task.status === "running") {
      active += 1;
    }
  }
  return active;
}

function findActiveDuplicate(params: {
  ownerKey: string;
  task: string;
  label: string | undefined;
}): TaskRecord | undefined {
  for (const candidate of listTasksForOwnerKey(params.ownerKey)) {
    if (candidate.runtime !== "agent") {
      continue;
    }
    if (candidate.status !== "queued" && candidate.status !== "running") {
      continue;
    }
    if (candidate.task !== params.task) {
      continue;
    }
    if ((candidate.label ?? undefined) !== params.label) {
      continue;
    }
    return candidate;
  }
  return undefined;
}

export class AgentTaskNotFoundError extends Error {
  readonly code = "agent_task_not_found";
  constructor(public readonly taskId: string) {
    super(`agent task ${taskId} not found`);
    this.name = "AgentTaskNotFoundError";
  }
}

export class AgentTaskOwnershipError extends Error {
  readonly code = "agent_task_ownership_mismatch";
  constructor(public readonly taskId: string) {
    super(`agent task ${taskId} is owned by a different session and cannot be modified`);
    this.name = "AgentTaskOwnershipError";
  }
}

export class AgentTaskWrongRuntimeError extends Error {
  readonly code = "agent_task_wrong_runtime";
  constructor(
    public readonly taskId: string,
    public readonly runtime: string,
  ) {
    super(
      `task ${taskId} has runtime '${runtime}'; only 'agent' tasks may be updated via this surface`,
    );
    this.name = "AgentTaskWrongRuntimeError";
  }
}

export class AgentTaskTerminalError extends Error {
  readonly code = "agent_task_already_terminal";
  constructor(
    public readonly taskId: string,
    public readonly status: string,
  ) {
    super(`agent task ${taskId} is already terminal (status='${status}') and cannot be modified`);
    this.name = "AgentTaskTerminalError";
  }
}

export class AgentTaskAdoptedError extends Error {
  readonly code = "agent_task_adopted";
  constructor(
    public readonly taskId: string,
    public readonly childSessionKey: string,
  ) {
    super(
      `agent task ${taskId} is being executed by subagent ${childSessionKey}; its lifecycle is driven by the subagent. Cancel the subagent to terminate the task.`,
    );
    this.name = "AgentTaskAdoptedError";
  }
}

function assertAgentTaskMutable(taskId: string, ownerKey: string): TaskRecord {
  const record = getTaskById(taskId);
  if (!record) {
    throw new AgentTaskNotFoundError(taskId);
  }
  if (record.runtime !== "agent") {
    throw new AgentTaskWrongRuntimeError(taskId, record.runtime);
  }
  if (record.ownerKey !== ownerKey) {
    throw new AgentTaskOwnershipError(taskId);
  }
  if (record.status !== "queued" && record.status !== "running") {
    throw new AgentTaskTerminalError(taskId, record.status);
  }
  if (record.childSessionKey) {
    throw new AgentTaskAdoptedError(taskId, record.childSessionKey);
  }
  return record;
}

export type UpdateAgentTaskProgressParams = {
  taskId: string;
  ownerKey: string;
  progressSummary: string;
};

export function updateAgentTaskProgress(params: UpdateAgentTaskProgressParams): TaskRecord {
  const current = assertAgentTaskMutable(params.taskId, params.ownerKey);
  const now = Date.now();
  if (current.status === "queued") {
    markTaskRunningById({
      taskId: params.taskId,
      ...(current.startedAt === undefined ? { startedAt: now } : {}),
      lastEventAt: now,
    });
  }
  const next = setTaskProgressById({
    taskId: params.taskId,
    progressSummary: params.progressSummary,
    lastEventAt: now,
  });
  if (!next) {
    throw new AgentTaskNotFoundError(params.taskId);
  }
  return next;
}

export type CompleteAgentTaskParams = {
  taskId: string;
  ownerKey: string;
  outcome: TaskTerminalOutcome;
  terminalSummary?: string;
};

export type AdoptAgentTaskForSubagentRunParams = {
  taskId: string;
  ownerKey: string;
  runId: string;
  childSessionKey: string;
  label?: string;
  startedAt?: number;
};

/**
 * Attach a spawned subagent run to an existing agent-runtime task. The task transitions to
 * 'running' and gains childSessionKey + runId, which routes subagent termination back to it
 * via the standard finalizeTaskRunByRunId path. After adoption, the agent tool can no longer
 * mutate the task — the subagent owns the lifecycle until it completes (or is cancelled).
 */
export function adoptAgentTaskForSubagentRun(
  params: AdoptAgentTaskForSubagentRunParams,
): TaskRecord {
  const record = getTaskById(params.taskId);
  if (!record) {
    throw new AgentTaskNotFoundError(params.taskId);
  }
  if (record.runtime !== "agent") {
    throw new AgentTaskWrongRuntimeError(params.taskId, record.runtime);
  }
  if (record.ownerKey !== params.ownerKey) {
    throw new AgentTaskOwnershipError(params.taskId);
  }
  if (record.status !== "queued" && record.status !== "running") {
    throw new AgentTaskTerminalError(params.taskId, record.status);
  }
  if (record.childSessionKey) {
    throw new AgentTaskAdoptedError(params.taskId, record.childSessionKey);
  }
  const next = attachSubagentRunToTaskById({
    taskId: params.taskId,
    childSessionKey: params.childSessionKey,
    runId: params.runId,
    ...(params.label !== undefined ? { label: params.label } : {}),
    ...(params.startedAt !== undefined ? { startedAt: params.startedAt } : {}),
  });
  if (!next) {
    throw new AgentTaskNotFoundError(params.taskId);
  }
  return next;
}

export function completeAgentTask(params: CompleteAgentTaskParams): TaskRecord {
  assertAgentTaskMutable(params.taskId, params.ownerKey);
  const now = Date.now();
  const status = params.outcome === "succeeded" ? "succeeded" : "failed";
  const next = markTaskTerminalById({
    taskId: params.taskId,
    status,
    endedAt: now,
    lastEventAt: now,
    terminalOutcome: params.outcome,
    ...(params.terminalSummary !== undefined ? { terminalSummary: params.terminalSummary } : {}),
  });
  if (!next) {
    throw new AgentTaskNotFoundError(params.taskId);
  }
  return next;
}

export function createAgentTaskRecord(
  params: CreateAgentTaskParams,
  opts?: { maxActiveAgentTasks?: number },
): TaskRecord {
  const duplicate = findActiveDuplicate({
    ownerKey: params.ownerKey,
    task: params.task,
    label: params.label,
  });
  if (duplicate) {
    return duplicate;
  }
  const limit = opts?.maxActiveAgentTasks ?? DEFAULT_MAX_ACTIVE_AGENT_TASKS;
  const active = countActiveAgentTasksForOwner(params.ownerKey);
  if (active >= limit) {
    throw new AgentTaskRateLimitError(active, limit);
  }
  return createTaskRecord({
    runtime: "agent",
    scopeKind: "session",
    deliveryStatus: "not_applicable",
    status: "queued",
    notifyPolicy: params.notifyPolicy ?? "silent",
    requesterSessionKey: params.sessionKey,
    ownerKey: params.ownerKey,
    task: params.task,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.label !== undefined ? { label: params.label } : {}),
    ...(params.taskKind !== undefined ? { taskKind: params.taskKind } : {}),
    ...(params.parentTaskId !== undefined ? { parentTaskId: params.parentTaskId } : {}),
    ...(params.parentFlowId !== undefined ? { parentFlowId: params.parentFlowId } : {}),
    ...(params.extrapolationGraphId !== undefined
      ? { extrapolationGraphId: params.extrapolationGraphId }
      : {}),
    ...(params.extrapolationNodeId !== undefined
      ? { extrapolationNodeId: params.extrapolationNodeId }
      : {}),
  });
}
