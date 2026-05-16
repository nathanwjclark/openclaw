export type ExtrapolationAgentOverride = {
  enabled?: boolean;
};

export type ExtrapolationDefaults = {
  /** Maximum nodes injected into per-turn context. */
  budgetNodes?: number;
  /** Gaps below this relevance score do not render into agent context. */
  gapRelevanceThreshold?: number;
  /** Floor for treating a gap as worth surfacing. */
  gapConfidenceThreshold?: number;
  /** Iteration cap before a graph is auto-abandoned. */
  maxIterations?: number;
  /** Promoted-node count that triggers auto-creation of a managed Task Flow. */
  autoFlowOnPromotions?: number;
  /** Prepend the backward purpose chain into spawned task descriptions. */
  includeBackwardChainInTasks?: boolean;
};

export type ExtrapolationModelsConfig = {
  /** Optional override for the seed pass; inherits agent primary when omitted. */
  seed?: string;
  /** Optional override for the revision pass; can be a cheaper model. */
  revision?: string;
};

export type ExtrapolationMemoryConfig = {
  /** Cross-graph reinforcement count needed to promote a backward node to a durable fact. */
  crossGraphReinforcement?: number;
  /** Confidence floor for promotion candidates. */
  confidenceFloor?: number;
  /** Inject established facts into seed prompts. */
  injectIntoSeed?: boolean;
};

export type ExtrapolationRetentionConfig = {
  /** Reserved for future override; `null`/omitted means permanent retention. */
  pruneAfter?: null;
};

export type ExtrapolationConfig = {
  /** Master switch; default false. Substrate is dormant until set true. */
  enabled?: boolean;
  perAgent?: Record<string, ExtrapolationAgentOverride>;
  defaults?: ExtrapolationDefaults;
  models?: ExtrapolationModelsConfig;
  memory?: ExtrapolationMemoryConfig;
  retention?: ExtrapolationRetentionConfig;
};

export const EXTRAPOLATION_DEFAULTS: Required<ExtrapolationDefaults> = {
  budgetNodes: 50,
  gapRelevanceThreshold: 0.6,
  gapConfidenceThreshold: 0.5,
  maxIterations: 20,
  autoFlowOnPromotions: 2,
  includeBackwardChainInTasks: true,
};

export const EXTRAPOLATION_MEMORY_DEFAULTS: Required<ExtrapolationMemoryConfig> = {
  crossGraphReinforcement: 3,
  confidenceFloor: 0.7,
  injectIntoSeed: true,
};

export function resolveExtrapolationEnabled(
  config: ExtrapolationConfig | undefined,
  agentId: string,
): boolean {
  if (!config) {
    return false;
  }
  const override = config.perAgent?.[agentId];
  if (override?.enabled !== undefined) {
    return override.enabled;
  }
  return config.enabled === true;
}
