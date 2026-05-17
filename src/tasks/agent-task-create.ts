import { createTaskRecord, listTasksForOwnerKey } from "./runtime-internal.js";
import type { TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";

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
