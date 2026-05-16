export function logMemoryVectorDegradedWrite(params: {
  vectorEnabled: boolean;
  vectorReady: boolean;
  chunkCount: number;
  warningShown: boolean;
  loadError?: string;
  /** Reason the embedding provider is unavailable, if known. When set, the
   *  warning attributes the degradation to the provider rather than to
   *  sqlite-vec — sqlite-vec only fails when there's a captured `loadError`. */
  providerUnavailableReason?: string;
  warn: (message: string) => void;
}): boolean {
  if (
    !params.vectorEnabled ||
    params.vectorReady ||
    params.chunkCount <= 0 ||
    params.warningShown
  ) {
    return params.warningShown;
  }
  // Two distinct failure modes; the legacy message conflated them.
  if (params.loadError) {
    params.warn(
      `chunks_vec not updated — sqlite-vec extension failed to load: ${params.loadError}. FTS recall still works. Further duplicate warnings suppressed.`,
    );
  } else {
    const reason = params.providerUnavailableReason
      ? `: ${params.providerUnavailableReason}`
      : " — no embedding provider is configured for memorySearch";
    params.warn(
      `chunks_vec not updated${reason}. FTS recall still works; sqlite-vec is available but unused. Further duplicate warnings suppressed.`,
    );
  }
  return true;
}
