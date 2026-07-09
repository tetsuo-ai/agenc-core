/**
 * Channel gateway (TODO task 6, Phase 1).
 *
 * Turns messaging surfaces into daemon-owned agent conversations. Public
 * entry points; the production daemon client lives in sdk-daemon-client.ts
 * and is imported directly where a real daemon connection is wired.
 */

export * from "./types.js";
export { ChannelGateway, type GatewayOptions } from "./gateway.js";
export {
  PairingStore,
  evaluateDmAccess,
  PAIRING_CODE_TTL_MS,
  type DmAccessDecision,
} from "./pairing.js";
export { resolveBinding, type ResolvedBinding } from "./bindings.js";
export {
  ApprovalRegistry,
  formatApprovalPrompt,
  APPROVAL_TIMEOUT_MS,
} from "./approvals.js";
export {
  SessionRouter,
  STREAM_FLUSH_INTERVAL_MS,
  type SessionRouterOptions,
} from "./session-router.js";
export {
  InMemoryChannelAdapter,
  type RecordedOutbound,
} from "./test-channel.js";
export {
  loadGatewayConfig,
  resolveGatewayConfigPath,
  type LoadGatewayConfigOptions,
} from "./config.js";
export {
  StdioChannelAdapter,
  STDIO_CHANNEL_ID,
  STDIO_PEER_ID,
  STDIO_CONVERSATION_ID,
  type StdioChannelOptions,
} from "./stdio-channel.js";
export {
  TelegramChannelAdapter,
  FetchTelegramTransport,
  TelegramBotApiError,
  TELEGRAM_CHANNEL_ID,
  type TelegramTransport,
  type TelegramUpdate,
  type TelegramChannelOptions,
} from "./telegram-channel.js";
export {
  startGateway,
  type GatewayRunOptions,
  type GatewayRunHandle,
} from "./run.js";
export {
  createSdkDaemonClient,
  isDaemonAgentGoneError,
  type SdkDaemonClientOptions,
  type SdkModule,
} from "./sdk-daemon-client.js";
export {
  startCronDelivery,
  CRON_DELIVERY_SCAN_CAP_MS,
  type CronDeliveryClock,
  type CronDeliveryHandle,
  type StartCronDeliveryOptions,
} from "./cron-delivery.js";
export {
  frameChannelMessage,
  sanitizeChannelText,
  CHANNEL_MESSAGE_GUIDANCE,
  type FrameChannelMessageInput,
} from "./untrusted.js";
export {
  detectPromptInjectionAttempt,
  normalizeForPromptInjectionScan,
  type PromptInjectionDecision,
} from "./prompt-injection.js";
export {
  XaiMemeFeature,
  parseMemePrompt,
  type GatewayMemeFeature,
  type GatewayMemeReplyOptions,
  type XaiMemeFeatureOptions,
} from "./meme.js";
export {
  TELEGRAM_OWNER_COMMANDS,
  TelegramOwnerControl,
  type TelegramOwnerControlDecision,
  type TelegramOwnerControlOptions,
  type TelegramOwnerControlState,
} from "./control-plane.js";
export {
  WebChatChannelAdapter,
  renderWebChatHtml,
  WEBCHAT_CHANNEL_ID,
  WEBCHAT_PEER_ID,
  WEBCHAT_CONVERSATION_ID,
  type WebChatChannelOptions,
} from "./webchat-channel.js";
