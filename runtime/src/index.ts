/**
 * @tetsuo-ai/runtime — lean coding CLI
 *
 * Post-gut: this barrel re-exports the minimum surface a host needs. Most
 * agent loop, tool, and TUI internals stay private; embedded daemon consumers
 * use the in-process app-server transport exported here.
 *
 * @packageDocumentation
 */

import "./bootstrap/node-env.js";
export { VERSION } from "./version.js";

export * from "./eval-contract/index.js";
export * from "./eval-pilot/index.js";
export * from "./eval-power/index.js";
export * from "./eval-suites/index.js";

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
  AGENC_REALTIME_CALL_MULTIPART_BOUNDARY,
  AGENC_REALTIME_CALL_MULTIPART_CONTENT_TYPE,
  AgenCRealtimeCallClient,
  type AgenCRealtimeCallClientOptions,
  type AgenCRealtimeCallResponse,
} from "./app-server/realtime-transport.js";
export {
  AgenCRealtimeRpcService,
  type AgenCRealtimeRpcHandlers,
  type AgenCRealtimeRpcServiceOptions,
  type AgenCRealtimeThreadBinding,
} from "./app-server/realtime.js";
export {
  REALTIME_WEBRTC_UNSUPPORTED_PLATFORM_MESSAGE,
  RealtimeWebrtcError,
  RealtimeWebrtcEventReceiver,
  RealtimeWebrtcLocalAudioPeak,
  RealtimeWebrtcSession,
  RealtimeWebrtcSessionHandle,
  isRealtimeWebrtcUnsupportedPlatform,
  type RealtimeWebrtcEvent,
  type RealtimeWebrtcErrorKind,
  type RealtimeWebrtcSessionStartOptions,
  type StartedRealtimeWebrtcSession,
} from "./conversation/realtime/webrtc/lib.js";
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
  AGENC_PORTAL_AUTH_METHODS,
  AGENC_PORTAL_CLIENT_CAPABILITY_FLAGS,
  AGENC_PORTAL_CLIENT_CAPABILITIES,
  AGENC_PORTAL_CONNECTION_STATUSES,
  AGENC_PORTAL_DAEMON_INITIALIZE_REQUEST,
  AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT,
  AGENC_PORTAL_DEFAULT_REMOTE_DAEMON_ENDPOINT,
  AGENC_PORTAL_DEFAULT_REQUEST_TIMEOUT_MS,
  AGENC_PORTAL_METHODS,
  AGENC_PORTAL_PROTOCOL_VERSION,
  createAgenCPortalMobileStatusSnapshot,
  isAgenCPortalAuthMethod,
  isAgenCPortalMethod,
  type AgenCPortalAgentSummary,
  type AgenCPortalAgentStatus,
  type AgenCPortalAuthMethod,
  type AgenCPortalAuthState,
  type AgenCPortalBackgroundAgentDashboardState,
  type AgenCPortalClientCapability,
  type AgenCPortalConnectionStatus,
  type AgenCPortalConnectionState,
  type AgenCPortalConnectionTarget,
  type AgenCPortalDashboardSnapshot,
  type AgenCPortalMethod,
  type AgenCPortalMobileAgentCheckIn,
  type AgenCPortalMobileAuthState,
  type AgenCPortalMobileConnectionState,
  type AgenCPortalMobileSessionCheckIn,
  type AgenCPortalMobileStatusCounts,
  type AgenCPortalMobileStatusOptions,
  type AgenCPortalMobileStatusSnapshot,
  type AgenCPortalMobileStatusTruncation,
  type AgenCPortalSessionSummary,
  type AgenCPortalSessionStatus,
} from "./app-server-protocol/index.js";
export {
  AGENC_IDE_EXTENSION_CAPABILITY_NAMESPACE,
  AGENC_IDE_EXTENSION_LSP_CAPABILITY,
  AGENC_IDE_EXTENSION_PACKAGE_NAME,
  AGENC_IDE_EXTENSION_REPOSITORY_NAME,
  AGENC_IDE_EXTENSION_SCAFFOLD,
  AGENC_IDE_EXTENSION_TARGET,
  AGENC_IDE_REQUIRED_METHODS,
  AGENC_IDE_REQUIRED_NOTIFICATIONS,
  checkAgenCIdeProtocolSurface,
  createAgenCIdeInitializeParams,
  isAgenCIdeRequiredMethod,
  isAgenCIdeRequiredNotification,
  type AgenCIdeExtensionScaffold,
  type AgenCIdeInitializeOptions,
  type AgenCIdeProtocolSurfaceCheck,
  type AgenCIdeRequiredMethod,
  type AgenCIdeRequiredNotification,
} from "./app-server-protocol/ide-extension.js";
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
