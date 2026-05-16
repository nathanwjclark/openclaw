export type ContextInjectionInput = {
  sessionKey: string;
  ownerKey: string;
};

export type ContextInjectionResult = {
  /** Rendered system-prompt block, empty string when no active graphs. */
  rendered: string;
  /** Number of active graphs included. */
  graphCount: number;
};

/**
 * Phase 2 wiring point: pre-turn renderer that loads the agent's active graphs
 * and durable facts and produces the system-prompt block.
 *
 * Not implemented in Phase 1.
 */
export function renderExtrapolationContext(_input: ContextInjectionInput): ContextInjectionResult {
  throw new Error("extrapolation context injection is not implemented in Phase 1");
}
