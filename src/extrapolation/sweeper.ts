/**
 * Phase 2 wiring point: periodic sweeper for extrapolation substrate.
 *  - Abandons graphs whose parent session is missing.
 *  - Caps iteration with `max_iterations`.
 *  - Promotes reinforced backward nodes into session_durable_facts.
 *
 * Not implemented in Phase 1.
 */
export function startExtrapolationSweeper(): void {
  throw new Error("extrapolation sweeper is not implemented in Phase 1");
}

export function stopExtrapolationSweeper(): void {
  // No-op: nothing to stop while the sweeper is dormant.
}
