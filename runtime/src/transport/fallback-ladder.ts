import { isEnvTruthy } from "../utils/envUtils.js";
import type { HeaderMap, RefreshHeaders, Transport } from "./index.js";
import { SSETransport } from "./sse-post.js";
import { HybridTransport } from "./ws-post.js";
import { WebSocketTransport } from "./ws-duplex.js";

export type TransportMode = "websocket" | "hybrid" | "sse";

const SSE_ENV_KEYS = ["CLAUDE_CODE_USE_CCR_V2", "USE_CCR_V2"] as const;
const HYBRID_ENV_KEYS = [
  "CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2",
  "CLAUDE_CODE_POST_FOR_SESSION_INGRESS",
  "POST_FOR_SESSION_INGRESS",
] as const;

// Minimal AgenC seam: preserve upstream transport flag behavior, but allow
// an explicit local override while the codex runtime port is still being wired.
function parseExplicitTransportMode(value: string | undefined): TransportMode | undefined {
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
  if (explicit) {
    return explicit;
  }
  if (SSE_ENV_KEYS.some((key) => isEnvTruthy(env[key]))) {
    return "sse";
  }
  if (HYBRID_ENV_KEYS.some((key) => isEnvTruthy(env[key]))) {
    return "hybrid";
  }
  return undefined;
}

export function getTransportForUrl(
  url: URL,
  headers: HeaderMap = {},
  sessionId?: string,
  refreshHeaders?: RefreshHeaders,
  env: NodeJS.ProcessEnv = process.env,
): Transport {
  const mode = resolveTransportMode(env);

  if (mode === "sse") {
    const sseUrl = new URL(url.href);
    if (sseUrl.protocol === "wss:") {
      sseUrl.protocol = "https:";
    } else if (sseUrl.protocol === "ws:") {
      sseUrl.protocol = "http:";
    }
    sseUrl.pathname = sseUrl.pathname.replace(/\/$/, "") + "/worker/events/stream";
    return new SSETransport(sseUrl, headers, sessionId, refreshHeaders);
  }

  if (url.protocol === "ws:" || url.protocol === "wss:") {
    if (mode === "hybrid") {
      return new HybridTransport(url, headers, sessionId, refreshHeaders);
    }
    return new WebSocketTransport(url, headers, sessionId, refreshHeaders);
  }

  throw new Error(`Unsupported protocol: ${url.protocol}`);
}
