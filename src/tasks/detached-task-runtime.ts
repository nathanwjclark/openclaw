import { getRuntimeConfig } from "../config/io.js";
import { resolveMemoryConfig } from "../extrapolation/durable-facts.js";
import { scheduleRevision } from "../extrapolation/revision.js";
import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  DetachedTaskRecoveryAttemptParams,
  DetachedTaskRecoveryAttemptResult,
  DetachedTaskFinalizeParams,
  DetachedTaskLifecycleRuntime,
  DetachedTaskLifecycleRuntimeRegistration,
} from "./detached-task-runtime-contract.js";
import {
  clearDetachedTaskLifecycleRuntimeRegistration,
  getDetachedTaskLifecycleRuntimeRegistration as getDetachedTaskLifecycleRuntimeRegistrationState,
  getRegisteredDetachedTaskLifecycleRuntime,
  registerDetachedTaskLifecycleRuntime,
} from "./detached-task-runtime-state.js";
import { cancelTaskById as cancelDetachedTaskRunByIdInCore } from "./runtime-internal.js";
import {
  completeTaskRunByRunId as completeTaskRunByRunIdFromExecutor,
  createQueuedTaskRun as createQueuedTaskRunFromExecutor,
  createRunningTaskRun as createRunningTaskRunFromExecutor,
  failTaskRunByRunId as failTaskRunByRunIdFromExecutor,
  finalizeTaskRunByRunId as finalizeTaskRunByRunIdFromExecutor,
  recordTaskRunProgressByRunId as recordTaskRunProgressByRunIdFromExecutor,
  setDetachedTaskDeliveryStatusByRunId as setDetachedTaskDeliveryStatusByRunIdFromExecutor,
  startTaskRunByRunId as startTaskRunByRunIdFromExecutor,
} from "./task-executor.js";
import type { TaskRecord } from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/detached-runtime");
const DETACHED_TASK_RECOVERY_WARN_MS = 5_000;

export type { DetachedTaskLifecycleRuntime, DetachedTaskLifecycleRuntimeRegistration };

const DEFAULT_DETACHED_TASK_LIFECYCLE_RUNTIME: DetachedTaskLifecycleRuntime = {
  createQueuedTaskRun: createQueuedTaskRunFromExecutor,
  createRunningTaskRun: createRunningTaskRunFromExecutor,
  startTaskRunByRunId: startTaskRunByRunIdFromExecutor,
  recordTaskRunProgressByRunId: recordTaskRunProgressByRunIdFromExecutor,
  finalizeTaskRunByRunId: finalizeTaskRunByRunIdFromExecutor,
  completeTaskRunByRunId: completeTaskRunByRunIdFromExecutor,
  failTaskRunByRunId: failTaskRunByRunIdFromExecutor,
  setDetachedTaskDeliveryStatusByRunId: setDetachedTaskDeliveryStatusByRunIdFromExecutor,
  cancelDetachedTaskRunById: cancelDetachedTaskRunByIdInCore,
};

export function getDetachedTaskLifecycleRuntime(): DetachedTaskLifecycleRuntime {
  return getRegisteredDetachedTaskLifecycleRuntime() ?? DEFAULT_DETACHED_TASK_LIFECYCLE_RUNTIME;
}

export function getDetachedTaskLifecycleRuntimeRegistration():
  | DetachedTaskLifecycleRuntimeRegistration
  | undefined {
  return getDetachedTaskLifecycleRuntimeRegistrationState();
}

export function registerDetachedTaskRuntime(
  pluginId: string,
  runtime: DetachedTaskLifecycleRuntime,
): void {
  registerDetachedTaskLifecycleRuntime(pluginId, runtime);
}

export function setDetachedTaskLifecycleRuntime(runtime: DetachedTaskLifecycleRuntime): void {
  registerDetachedTaskRuntime("__test__", runtime);
}

export function resetDetachedTaskLifecycleRuntimeForTests(): void {
  clearDetachedTaskLifecycleRuntimeRegistration();
}

export function createQueuedTaskRun(
  ...args: Parameters<DetachedTaskLifecycleRuntime["createQueuedTaskRun"]>
): ReturnType<DetachedTaskLifecycleRuntime["createQueuedTaskRun"]> {
  return getDetachedTaskLifecycleRuntime().createQueuedTaskRun(...args);
}

export function createRunningTaskRun(
  ...args: Parameters<DetachedTaskLifecycleRuntime["createRunningTaskRun"]>
): ReturnType<DetachedTaskLifecycleRuntime["createRunningTaskRun"]> {
  return getDetachedTaskLifecycleRuntime().createRunningTaskRun(...args);
}

export function startTaskRunByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["startTaskRunByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["startTaskRunByRunId"]> {
  return getDetachedTaskLifecycleRuntime().startTaskRunByRunId(...args);
}

export function recordTaskRunProgressByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["recordTaskRunProgressByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["recordTaskRunProgressByRunId"]> {
  return getDetachedTaskLifecycleRuntime().recordTaskRunProgressByRunId(...args);
}

export function finalizeTaskRunByRunId(params: DetachedTaskFinalizeParams): TaskRecord[] {
  const runtime = getDetachedTaskLifecycleRuntime();
  const finalized = runtime.finalizeTaskRunByRunId
    ? runtime.finalizeTaskRunByRunId(params)
    : params.status === "succeeded"
      ? runtime.completeTaskRunByRunId(params)
      : runtime.failTaskRunByRunId({ ...params, status: params.status });
  notifyExtrapolationOnFinalize(finalized, params);
  return finalized;
}

function notifyExtrapolationOnFinalize(
  finalized: TaskRecord[],
  params: DetachedTaskFinalizeParams,
): void {
  for (const task of finalized) {
    const graphId = task.extrapolationGraphId;
    if (!graphId) {
      continue;
    }
    const evidence = {
      status: params.status,
      terminalSummary: params.terminalSummary ?? task.terminalSummary ?? null,
      ...(params.error || task.error ? { error: params.error ?? task.error } : {}),
      ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
      ...(params.endedAt ? { endedAt: params.endedAt } : {}),
    };
    const memory = (() => {
      try {
        return resolveMemoryConfig(getRuntimeConfig());
      } catch {
        return undefined;
      }
    })();
    void scheduleRevision({
      graphId,
      ...(task.extrapolationNodeId ? { nodeId: task.extrapolationNodeId } : {}),
      evidence,
      callGateway,
      ...(memory ? { memory } : {}),
    }).catch((err) => {
      log.warn("finalize.extrapolation_hook_failed", {
        event: "finalize.extrapolation_hook_failed",
        runId: task.runId,
        graphId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

export function completeTaskRunByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["completeTaskRunByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["completeTaskRunByRunId"]> {
  return getDetachedTaskLifecycleRuntime().completeTaskRunByRunId(...args);
}

export function failTaskRunByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["failTaskRunByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["failTaskRunByRunId"]> {
  return getDetachedTaskLifecycleRuntime().failTaskRunByRunId(...args);
}

export function setDetachedTaskDeliveryStatusByRunId(
  ...args: Parameters<DetachedTaskLifecycleRuntime["setDetachedTaskDeliveryStatusByRunId"]>
): ReturnType<DetachedTaskLifecycleRuntime["setDetachedTaskDeliveryStatusByRunId"]> {
  return getDetachedTaskLifecycleRuntime().setDetachedTaskDeliveryStatusByRunId(...args);
}

export function cancelDetachedTaskRunById(
  ...args: Parameters<DetachedTaskLifecycleRuntime["cancelDetachedTaskRunById"]>
): ReturnType<DetachedTaskLifecycleRuntime["cancelDetachedTaskRunById"]> {
  return getDetachedTaskLifecycleRuntime().cancelDetachedTaskRunById(...args);
}

export async function tryRecoverTaskBeforeMarkLost(
  params: DetachedTaskRecoveryAttemptParams,
): Promise<DetachedTaskRecoveryAttemptResult> {
  const hook = getDetachedTaskLifecycleRuntime().tryRecoverTaskBeforeMarkLost;
  if (!hook) {
    return { recovered: false };
  }
  const startedAt = Date.now();
  try {
    const result = await hook(params);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= DETACHED_TASK_RECOVERY_WARN_MS) {
      log.warn("Detached task recovery hook was slow", {
        taskId: params.taskId,
        runtime: params.runtime,
        elapsedMs,
      });
    }
    if (result && typeof result.recovered === "boolean") {
      return result;
    }
    log.warn("Detached task recovery hook returned invalid result, proceeding with markTaskLost", {
      taskId: params.taskId,
      runtime: params.runtime,
      result,
    });
    return { recovered: false };
  } catch (err) {
    log.warn("Detached task recovery hook threw, proceeding with markTaskLost", {
      taskId: params.taskId,
      runtime: params.runtime,
      elapsedMs: Date.now() - startedAt,
      error: err,
    });
    return { recovered: false };
  }
}
