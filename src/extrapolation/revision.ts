export type ScheduleRevisionInput = {
  graphId: string;
  nodeId?: string;
  evidence: {
    status: string;
    terminalSummary?: string;
    error?: string;
    childSessionKey?: string;
    endedAt?: number;
  };
};

/**
 * Phase 2 wiring point: called from finalizeTaskRunByRunId when a task carries
 * extrapolation_graph_id. Copies evidence into the source node, runs a revision
 * pass via runRevisionPass, applies the delta with optimistic concurrency, and
 * fires a heartbeat-wake if material change lands while the session is idle.
 *
 * Not implemented in Phase 1 — task lifecycle never reaches this code path
 * because no tasks carry extrapolation ids yet.
 */
export function scheduleRevision(_input: ScheduleRevisionInput): Promise<void> {
  throw new Error("extrapolation revision scheduler is not implemented in Phase 1");
}
