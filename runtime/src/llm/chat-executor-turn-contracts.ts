import type { GatewayMessage } from "../gateway/message.js";

const CONCORDIA_SIMULATION_TURN_CONTRACT =
  "concordia_simulation_turn";
const CONCORDIA_GENERATE_AGENTS_MESSAGE_TYPE =
  "concordia_generate_agents";
const CONCORDIA_GENERATOR_SESSION_PREFIX = "concordia:generator:";
const CONCORDIA_GENERATOR_SENDER_ID = "concordia-agent-generator";

function hasConcordiaSimulationTurnContract(
  metadata?: Readonly<Record<string, unknown>>,
): boolean {
  if (!metadata) return false;
  return (
    metadata.turn_contract === CONCORDIA_SIMULATION_TURN_CONTRACT ||
    metadata.turnContract === CONCORDIA_SIMULATION_TURN_CONTRACT ||
    metadata.concordia_turn_contract === CONCORDIA_SIMULATION_TURN_CONTRACT
  );
}

function hasConcordiaGenerateAgentsContract(
  metadata?: Readonly<Record<string, unknown>>,
): boolean {
  if (!metadata) return false;
  return (
    metadata.type === CONCORDIA_GENERATE_AGENTS_MESSAGE_TYPE ||
    metadata.message_type === CONCORDIA_GENERATE_AGENTS_MESSAGE_TYPE ||
    metadata.turn_type === CONCORDIA_GENERATE_AGENTS_MESSAGE_TYPE
  );
}

function looksLikeConcordiaGenerateAgentsPrompt(
  messageText: string,
): boolean {
  return (
    /\bGenerate exactly\s+\d+\s+diverse characters\b/i.test(messageText) &&
    /\bJSON array\b/i.test(messageText)
  );
}

export function isConcordiaSimulationTurnMessage(
  message: Pick<GatewayMessage, "channel" | "metadata">,
): boolean {
  return (
    message.channel === "concordia" &&
    hasConcordiaSimulationTurnContract(message.metadata)
  );
}

export function isConcordiaGenerateAgentsMessage(
  message: Pick<
    GatewayMessage,
    "channel" | "content" | "metadata" | "senderId" | "sessionId"
  >,
): boolean {
  if (message.channel !== "concordia") {
    return false;
  }
  if (hasConcordiaGenerateAgentsContract(message.metadata)) {
    return true;
  }
  if (message.senderId === CONCORDIA_GENERATOR_SENDER_ID) {
    return true;
  }
  if (message.sessionId.startsWith(CONCORDIA_GENERATOR_SESSION_PREFIX)) {
    return true;
  }
  return looksLikeConcordiaGenerateAgentsPrompt(message.content);
}
