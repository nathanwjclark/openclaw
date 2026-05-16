import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";

export type DiscordInboundTurnDeliveryEnd = () => void;

type ActiveTurn = {
  outboundTo: string;
  outboundAccountId?: string;
  markInboundTurnDelivered: () => void;
};

const DISCORD_INBOUND_TURN_DELIVERY_KEY = "__openclawInboundTurnDelivery";
const registry = new Map<string, ActiveTurn>();

function normalizeDiscordDeliveryTarget(value: string): string {
  return value
    .trim()
    .replace(/^discord:/iu, "")
    .replace(/^channel:/iu, "")
    .toLowerCase();
}

function resolveDiscordInboundTurnDeliveryCorrelationKey(
  sessionKey: string | undefined,
  inboundTurnKind?: string,
): string | undefined {
  const key = sessionKey?.trim();
  if (!key) {
    return undefined;
  }
  return inboundTurnKind === "room_event" ? `${key}:room_event` : key;
}

export function beginDiscordInboundTurnDeliveryCorrelation(
  sessionKey: string | undefined,
  turn: ActiveTurn,
  options?: { inboundTurnKind?: string },
): DiscordInboundTurnDeliveryEnd {
  const key = resolveDiscordInboundTurnDeliveryCorrelationKey(sessionKey, options?.inboundTurnKind);
  if (!key) {
    return () => {};
  }
  registry.set(key, turn);
  return () => {
    if (registry.get(key) === turn) {
      registry.delete(key);
    }
  };
}

export function notifyDiscordInboundTurnOutboundSuccess(params: {
  sessionKey: string | undefined;
  to: string;
  accountId?: string | null;
  inboundTurnKind?: string;
}): void {
  const key = resolveDiscordInboundTurnDeliveryCorrelationKey(
    params.sessionKey,
    params.inboundTurnKind,
  );
  if (!key) {
    return;
  }
  const turn = registry.get(key);
  if (
    !turn ||
    normalizeDiscordDeliveryTarget(turn.outboundTo) !== normalizeDiscordDeliveryTarget(params.to)
  ) {
    return;
  }
  if (turn.outboundAccountId && params.accountId && params.accountId !== turn.outboundAccountId) {
    return;
  }
  turn.markInboundTurnDelivered();
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function withDiscordInboundTurnDeliveryMetadata(
  payload: ReplyPayload,
  params: {
    sessionKey?: string | null;
    inboundTurnKind?: string;
  },
): ReplyPayload {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey || params.inboundTurnKind !== "room_event") {
    return payload;
  }
  const channelData = readRecord(payload.channelData) ?? {};
  const discordData = readRecord(channelData.discord) ?? {};
  return {
    ...payload,
    channelData: {
      ...channelData,
      discord: {
        ...discordData,
        [DISCORD_INBOUND_TURN_DELIVERY_KEY]: {
          sessionKey,
          inboundTurnKind: params.inboundTurnKind,
        },
      },
    },
  };
}

export function notifyDiscordInboundTurnOutboundPayloadSuccess(params: {
  payload: ReplyPayload;
  to: string;
  accountId?: string | null;
}): void {
  const channelData = readRecord(params.payload.channelData);
  const discordData = readRecord(channelData?.discord);
  const metadata = readRecord(discordData?.[DISCORD_INBOUND_TURN_DELIVERY_KEY]);
  if (!metadata) {
    return;
  }
  notifyDiscordInboundTurnOutboundSuccess({
    sessionKey: readString(metadata.sessionKey),
    inboundTurnKind: readString(metadata.inboundTurnKind),
    to: params.to,
    accountId: params.accountId,
  });
}
