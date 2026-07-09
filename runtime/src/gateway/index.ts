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
