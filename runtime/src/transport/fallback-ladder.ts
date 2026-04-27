import { isEnvTruthy } from "../utils/envUtils.js";

export type TransportMode = "websocket" | "hybrid" | "sse";

const SSE_ENV_KEYS = ["AGENC_USE_CCR_V2", "USE_CCR_V2"] as const;
const HYBRID_ENV_KEYS = [
  "AGENC_POST_FOR_SESSION_INGRESS_V2",
  "AGENC_POST_FOR_SESSION_INGRESS",
  "POST_FOR_SESSION_INGRESS",
] as const;

function parseExplicitTransportMode(
  value: string | undefined,
): TransportMode | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case undefined:
    case "":
      return undefined;
    case "websocket":
    case "ws":
      return "websocket";
    case "hybrid":
    case "post":
      return "hybrid";
    case "sse":
    case "ccr":
      return "sse";
    default:
      throw new Error(`Unsupported AGENC_TRANSPORT value: ${value}`);
  }
}

export function resolveTransportMode(
  env: NodeJS.ProcessEnv = process.env,
): TransportMode | undefined {
  const explicit = parseExplicitTransportMode(env.AGENC_TRANSPORT);
  if (explicit) return explicit;
  if (SSE_ENV_KEYS.some((key) => isEnvTruthy(env[key]))) return "sse";
  if (HYBRID_ENV_KEYS.some((key) => isEnvTruthy(env[key]))) return "hybrid";
  return undefined;
}
