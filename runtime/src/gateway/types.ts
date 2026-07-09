/**
 * Channel gateway core types (TODO task 6, Phase 1).
 *
 * The gateway is a DAEMON CLIENT: it turns messaging surfaces (Telegram,
 * Discord, WebChat, a stdio dev channel, ...) into conversations with agents
 * owned by the local daemon. It speaks to the daemon exclusively through the
 * narrow {@link GatewayDaemonClient} seam, whose production implementation
 * wraps `@tetsuo-ai/agenc-sdk` — never runtime session internals.
 *
 * Security invariants (backlog protocol rule 6):
 *  - Unknown DM senders get the pairing flow by default; `open` must be an
 *    explicit `"*"` in configuration.
 *  - Channel text is untrusted work data. It can never change permission
 *    mode, signer/wallet config, or tool policy. The ONLY channel input with
 *    authority is an exact, single-use approval token replied by the same
 *    sender the request was rendered to.
 */

// ---------------------------------------------------------------------------
// Channel surface
// ---------------------------------------------------------------------------

/** Where an inbound message came from, channel-neutrally. */
export interface ChannelSender {
  /** Stable per-channel peer id (e.g. a Telegram user id). */
  readonly peerId: string;
  readonly displayName?: string;
}

export interface ChannelConversation {
  /** `dm` = 1:1 with the sender; `group` = shared room/thread. */
  readonly kind: "dm" | "group";
  /** Stable per-channel conversation id. */
  readonly id: string;
}

export interface InboundChannelMessage {
  readonly channelId: string;
  readonly sender: ChannelSender;
  readonly conversation: ChannelConversation;
  readonly text: string;
}

export interface OutboundChannelMessage {
  readonly conversationId: string;
  readonly text: string;
  /**
   * Optional public image URL to deliver as native media on channels that
   * support it. Adapters without media support may ignore it and send `text`.
   */
  readonly photoUrl?: string;
  /** Optional media caption; defaults to `text` when omitted. */
  readonly caption?: string;
  /** Optional audio bytes to deliver as a native audio file. */
  readonly audioBytes?: Uint8Array;
  readonly audioFileName?: string;
  readonly audioContentType?: string;
  readonly audioTitle?: string;
  readonly audioPerformer?: string;
  /**
   * When set, adapters that support edit-in-place update the message they
   * previously returned this id for (streaming coalescing); adapters without
   * edit support may ignore it and send a new message.
   */
  readonly editMessageId?: string;
}

export type ChannelReplyOptions = Omit<
  OutboundChannelMessage,
  "conversationId" | "text" | "editMessageId"
>;

export interface ChannelAdapterContext {
  /** Deliver an inbound message into the gateway pipeline. */
  onMessage(message: InboundChannelMessage): Promise<void>;
}

/**
 * One messaging surface. Implementations own their transport (long-poll,
 * websocket, stdio) and translate to/from the channel-neutral types.
 */
export interface ChannelAdapter {
  readonly id: string;
  /** True when the surface can edit an already-sent message in place. */
  readonly supportsEdit: boolean;
  start(context: ChannelAdapterContext): Promise<void>;
  stop(): Promise<void>;
  /** Returns the channel-native message id (used for later edits). */
  send(message: OutboundChannelMessage): Promise<string>;
}

// ---------------------------------------------------------------------------
// DM policy + pairing
// ---------------------------------------------------------------------------

export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export interface GatewayChannelPolicy {
  readonly dmPolicy: DmPolicy;
  /** Peer ids always allowed. `open` REQUIRES the literal `"*"` here. */
  readonly allowlist: readonly string[];
}

// ---------------------------------------------------------------------------
// Bindings: which agent serves which sender/conversation
// ---------------------------------------------------------------------------

/**
 * Deterministic routing rule. Specificity (most specific wins):
 *   peer (exact sender) > group (exact conversation) > channel default.
 * `agent` names a daemon-side agent profile; v1 uses it as a session-scope
 * label so two bindings never share a session.
 */
export interface GatewayBinding {
  readonly agent: string;
  readonly channelId: string;
  readonly peerId?: string;
  readonly groupId?: string;
}

// ---------------------------------------------------------------------------
// Daemon seam (production impl wraps @tetsuo-ai/agenc-sdk)
// ---------------------------------------------------------------------------

export interface GatewayPermissionRequest {
  readonly requestId: string;
  readonly toolName?: string;
  readonly permissions: readonly string[];
  readonly reason?: string;
}

export type GatewayPermissionDecision =
  | { readonly behavior: "allow"; readonly scope: "once" }
  | { readonly behavior: "deny"; readonly reason?: string };

export type GatewayPromptEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "status"; readonly message?: string };

export interface GatewayPromptResult {
  readonly stopReason: "completed" | "errored" | "stopped";
  readonly finalMessage: string;
  /** Real token usage, when the daemon reports it (used for budget reconcile). */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface GatewayPromptHandlers {
  onEvent(event: GatewayPromptEvent): void | Promise<void>;
  onPermissionRequest(
    request: GatewayPermissionRequest,
  ): Promise<GatewayPermissionDecision>;
}

export interface GatewaySession {
  readonly sessionId: string;
  prompt(
    text: string,
    handlers: GatewayPromptHandlers,
  ): Promise<GatewayPromptResult>;
}

export interface GatewaySessionCreateOptions {
  /**
   * Operator-facing label for the daemon agent backing this session (e.g.
   * the conversation key or "heartbeat") — shows up in `agenc agents list`.
   */
  readonly label?: string;
}

export interface GatewayDaemonClient {
  createSession(options?: GatewaySessionCreateOptions): Promise<GatewaySession>;
  attachSession(sessionId: string): Promise<GatewaySession>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Gateway configuration
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  /** Per-channel policy; a missing entry means the fail-closed default. */
  readonly channels: Readonly<Record<string, GatewayChannelPolicy>>;
  readonly bindings: readonly GatewayBinding[];
  /** Default agent label when no binding matches. */
  readonly defaultAgent: string;
}

/** Fail-closed defaults: pairing-gated DMs, empty allowlist. */
export const DEFAULT_CHANNEL_POLICY: GatewayChannelPolicy = Object.freeze({
  dmPolicy: "pairing",
  allowlist: Object.freeze([]) as readonly string[],
});

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = Object.freeze({
  channels: Object.freeze({}),
  bindings: Object.freeze([]) as readonly GatewayBinding[],
  defaultAgent: "default",
});
