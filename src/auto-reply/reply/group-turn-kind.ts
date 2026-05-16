import { resolveAgentConfig } from "../../agents/agent-scope.js";
import type { InboundTurnKind } from "../../channels/turn/kind.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type AmbientGroupInboundTurnFacts = {
  isGroup: boolean;
  wasMentioned: boolean;
  hasControlCommand?: boolean;
  hasAbortRequest?: boolean;
  commandSource?: string;
};

function resolveConfiguredAmbientGroupTurnKind(
  cfg: OpenClawConfig,
  agentId: string,
): InboundTurnKind {
  const agentGroupChat = resolveAgentConfig(cfg, agentId)?.groupChat;
  if (agentGroupChat && Object.hasOwn(agentGroupChat, "ambientTurns")) {
    return agentGroupChat.ambientTurns ?? "user_request";
  }
  return cfg.messages?.groupChat?.ambientTurns ?? "user_request";
}

export function resolveAmbientGroupInboundTurnKind(params: {
  cfg: OpenClawConfig;
  agentId: string;
  facts: AmbientGroupInboundTurnFacts;
}): InboundTurnKind {
  const configuredKind = resolveConfiguredAmbientGroupTurnKind(params.cfg, params.agentId);
  return configuredKind === "room_event" &&
    params.facts.isGroup &&
    !params.facts.wasMentioned &&
    !params.facts.hasControlCommand &&
    !params.facts.hasAbortRequest &&
    params.facts.commandSource !== "native"
    ? "room_event"
    : "user_request";
}
