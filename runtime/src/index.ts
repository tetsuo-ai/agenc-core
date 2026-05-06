/**
 * @tetsuo-ai/runtime — lean coding CLI
 *
 * Post-gut: this barrel re-exports the minimum surface a host needs. Most
 * agent loop, tool, and TUI internals stay private; embedded daemon consumers
 * use the in-process app-server transport exported here.
 *
 * @packageDocumentation
 */

export const VERSION = "0.2.0";

export {
  AgenCDaemonAgentManager,
  type AgenCDaemonAgentManagerOptions,
} from "./app-server/agent-lifecycle.js";
export {
  AgenCDaemonClientMultiplexer,
  type AgenCClientMultiplexerOptions,
} from "./app-server/client-multiplexer.js";
export {
  AgenCDaemonJsonRpcDispatcher,
  type AgenCDaemonDispatcherOptions,
} from "./app-server/daemon-dispatcher.js";
export {
  AGENC_DAEMON_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
  type AgenCDaemonRequest,
  type AgenCDaemonResponse,
  type InitializeParams,
  type JsonObject,
  type RequestId,
} from "./app-server/protocol/index.js";
export {
  AGENC_PORTAL_CLIENT_CAPABILITY_FLAGS,
  AGENC_PORTAL_CLIENT_CAPABILITIES,
  AGENC_PORTAL_CONNECTION_STATUSES,
  AGENC_PORTAL_DAEMON_INITIALIZE_REQUEST,
  AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT,
  AGENC_PORTAL_DEFAULT_REMOTE_DAEMON_ENDPOINT,
  AGENC_PORTAL_DEFAULT_REQUEST_TIMEOUT_MS,
  AGENC_PORTAL_METHODS,
  AGENC_PORTAL_PROTOCOL_VERSION,
  isAgenCPortalMethod,
  type AgenCPortalAgentSummary,
  type AgenCPortalClientCapability,
  type AgenCPortalConnectionStatus,
  type AgenCPortalConnectionState,
  type AgenCPortalConnectionTarget,
  type AgenCPortalDashboardSnapshot,
  type AgenCPortalMethod,
  type AgenCPortalSessionSummary,
} from "./app-server-protocol/index.js";
export {
  AgenCDaemonSessionManager,
  type AgenCSessionLifecycleOptions,
} from "./app-server/session-lifecycle.js";
export {
  AgenCInProcessDaemonTransport,
  defaultInProcessInitializeParams,
  startAgenCInProcessDaemonTransport,
  type AgenCInProcessDaemonTransportOptions,
  type StartAgenCInProcessDaemonTransportOptions,
} from "./app-server/transport/in-process.js";
export {
  AGENC_WEBSOCKET_DEFAULT_HOST,
  AGENC_WEBSOCKET_DEFAULT_MAX_PAYLOAD_BYTES,
  AGENC_WEBSOCKET_DEFAULT_PATH,
  AGENC_WEBSOCKET_HEALTH_PATH,
  AGENC_WEBSOCKET_READY_PATH,
  AgenCWebSocketServer,
  encodeJsonPayload,
  parseJsonObjectPayload,
  rejectBrowserOriginHeaders,
  type AgenCWebSocketListenAddress,
  type AgenCWebSocketMessageContext,
  type AgenCWebSocketServerOptions,
} from "./app-server/transport/websocket.js";
