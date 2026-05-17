import type { DeliveryContext } from "../utils/delivery-context.types.js";

/**
 * Single-agent install convention: all task / graph / durable-fact ownership collapses to this
 * one key. Lets the agent see everything regardless of which Slack session, thread, or subagent
 * created it; the agent uses requesterSessionKey / agentId on each record to decide relevance.
 *
 * The ownerKey field is preserved so per-agent or per-tenant scoping can be re-introduced later
 * without a schema change — see openclaw-tools.ts, context-injection.ts, and the extrapolation
 * agent tool for the callers that would need to flip back to a narrower key.
 */
export const GLOBAL_OWNER_KEY = "global";

export type TaskRuntime = "subagent" | "acp" | "cli" | "cron" | "agent";

export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost";

export type TaskDeliveryStatus =
  | "pending"
  | "delivered"
  | "session_queued"
  | "failed"
  | "parent_missing"
  | "not_applicable";

export type TaskNotifyPolicy = "done_only" | "state_changes" | "silent";

export type TaskTerminalOutcome = "succeeded" | "blocked";
export type TaskScopeKind = "session" | "system";

export type TaskStatusCounts = Record<TaskStatus, number>;
export type TaskRuntimeCounts = Record<TaskRuntime, number>;

export type TaskRegistrySummary = {
  total: number;
  active: number;
  terminal: number;
  failures: number;
  byStatus: TaskStatusCounts;
  byRuntime: TaskRuntimeCounts;
};

export type TaskEventKind = TaskStatus | "progress";

export type TaskEventRecord = {
  at: number;
  kind: TaskEventKind;
  summary?: string;
};

export type TaskDeliveryState = {
  taskId: string;
  requesterOrigin?: DeliveryContext;
  lastNotifiedEventAt?: number;
};

export type TaskRecord = {
  taskId: string;
  runtime: TaskRuntime;
  taskKind?: string;
  sourceId?: string;
  requesterSessionKey: string;
  ownerKey: string;
  scopeKind: TaskScopeKind;
  childSessionKey?: string;
  parentFlowId?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  status: TaskStatus;
  deliveryStatus: TaskDeliveryStatus;
  notifyPolicy: TaskNotifyPolicy;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: TaskTerminalOutcome;
  extrapolationGraphId?: string;
  extrapolationNodeId?: string;
};

export type TaskRegistrySnapshot = {
  tasks: TaskRecord[];
  deliveryStates: TaskDeliveryState[];
};
