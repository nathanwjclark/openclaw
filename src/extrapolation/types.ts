import { z } from "zod";

export const EXTRAPOLATION_DIRECTIONS = ["forward", "backward", "lateral"] as const;
export type ExtrapolationDirection = (typeof EXTRAPOLATION_DIRECTIONS)[number];

export const EXTRAPOLATION_FORWARD_KINDS = ["forward_branch", "contingency", "dependency"] as const;
export const EXTRAPOLATION_BACKWARD_KINDS = [
  "purpose",
  "role_context",
  "business_context",
  "stakeholder",
] as const;
export const EXTRAPOLATION_LATERAL_KINDS = ["gap", "assumption", "invalidator"] as const;

export const EXTRAPOLATION_NODE_KINDS = [
  ...EXTRAPOLATION_FORWARD_KINDS,
  ...EXTRAPOLATION_BACKWARD_KINDS,
  ...EXTRAPOLATION_LATERAL_KINDS,
] as const;
export type ExtrapolationNodeKind = (typeof EXTRAPOLATION_NODE_KINDS)[number];

export const EXTRAPOLATION_GRAPH_STATUSES = ["active", "resolved", "abandoned"] as const;
export type ExtrapolationGraphStatus = (typeof EXTRAPOLATION_GRAPH_STATUSES)[number];

export const EXTRAPOLATION_NODE_STATUSES = [
  "open",
  "resolved",
  "pruned",
  "promoted",
  "invalidated",
] as const;
export type ExtrapolationNodeStatus = (typeof EXTRAPOLATION_NODE_STATUSES)[number];

export const EXTRAPOLATION_AUDIT_KINDS = [
  "seed",
  "revision",
  "update",
  "promotion",
  "resolution",
  "state_transition",
] as const;
export type ExtrapolationAuditKind = (typeof EXTRAPOLATION_AUDIT_KINDS)[number];

export const DIRECTION_TO_KINDS: Readonly<
  Record<ExtrapolationDirection, ReadonlyArray<ExtrapolationNodeKind>>
> = {
  forward: EXTRAPOLATION_FORWARD_KINDS,
  backward: EXTRAPOLATION_BACKWARD_KINDS,
  lateral: EXTRAPOLATION_LATERAL_KINDS,
};

export function directionForKind(kind: ExtrapolationNodeKind): ExtrapolationDirection {
  if ((EXTRAPOLATION_FORWARD_KINDS as ReadonlyArray<string>).includes(kind)) {
    return "forward";
  }
  if ((EXTRAPOLATION_BACKWARD_KINDS as ReadonlyArray<string>).includes(kind)) {
    return "backward";
  }
  return "lateral";
}

export type ExtrapolationGraphRecord = {
  graphId: string;
  rootRequest: string;
  ownerKey: string;
  sessionKey: string;
  agentId: string;
  flowId?: string;
  status: ExtrapolationGraphStatus;
  iteration: number;
  budgetNodes: number;
  revisionToken: number;
  resolvedAt?: number;
  abandonedReason?: string;
  createdAt: number;
  updatedAt: number;
};

export type ExtrapolationNodeRecord = {
  nodeId: string;
  graphId: string;
  parentNodeId?: string;
  direction: ExtrapolationDirection;
  kind: ExtrapolationNodeKind;
  content: string;
  confidence: number;
  relevance: number;
  status: ExtrapolationNodeStatus;
  resolution?: string;
  promotedTaskId?: string;
  promotedChildSessionKey?: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
};

export type ExtrapolationAuditRecord = {
  auditId?: number;
  graphId: string;
  iteration: number;
  at: number;
  kind: ExtrapolationAuditKind;
  contentJson: string;
};

export type SessionDurableFactRecord = {
  factId: string;
  ownerKey: string;
  sessionKey: string;
  kind: ExtrapolationNodeKind;
  content: string;
  contentHash: string;
  confidence: number;
  reinforcement: number;
  sourceGraphIds: ReadonlyArray<string>;
  createdAt: number;
  updatedAt: number;
  revokedAt?: number;
};

const directionSchema = z.enum(EXTRAPOLATION_DIRECTIONS);
const kindSchema = z.enum(EXTRAPOLATION_NODE_KINDS);

const unitInterval = z.number().min(0).max(1);

export const ExtrapolationNodeKindSchema = kindSchema;
export const ExtrapolationDirectionSchema = directionSchema;
export const ExtrapolationGraphStatusSchema = z.enum(EXTRAPOLATION_GRAPH_STATUSES);
export const ExtrapolationNodeStatusSchema = z.enum(EXTRAPOLATION_NODE_STATUSES);

export const ExtrapolationNodeSeedSchema = z
  .object({
    direction: directionSchema,
    kind: kindSchema,
    content: z.string().min(1),
    confidence: unitInterval.default(0.5),
    relevance: unitInterval.default(0.5),
    parentNodeId: z.string().optional(),
  })
  .refine((node) => directionForKind(node.kind) === node.direction, {
    message: "node kind does not match the declared direction",
  });

export type ExtrapolationNodeSeedInput = z.input<typeof ExtrapolationNodeSeedSchema>;

export const ExtrapolationNodePatchSchema = z
  .object({
    status: ExtrapolationNodeStatusSchema.optional(),
    resolution: z.string().optional(),
    confidence: unitInterval.optional(),
    relevance: unitInterval.optional(),
    promotedTaskId: z.string().optional(),
    promotedChildSessionKey: z.string().optional(),
  })
  .refine(
    (patch) =>
      patch.status !== undefined ||
      patch.resolution !== undefined ||
      patch.confidence !== undefined ||
      patch.relevance !== undefined ||
      patch.promotedTaskId !== undefined ||
      patch.promotedChildSessionKey !== undefined,
    { message: "node patch must change at least one field" },
  );

export type ExtrapolationNodePatch = z.infer<typeof ExtrapolationNodePatchSchema>;
