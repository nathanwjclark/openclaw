export type DiscordInboundTurnDeliveryEnd = () => void;

type ActiveTurn = {
  outboundTo: string;
  outboundAccountId?: string;
  markInboundTurnDelivered: () => void;
};

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
