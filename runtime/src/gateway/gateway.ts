/**
 * Channel gateway orchestrator (TODO task 6).
 *
 * Inbound pipeline, in authority order:
 *   1. approval replies  — exact-token permission responses (consumed
 *      first: they must never reach the agent as prompt text)
 *   2. pairing redemption — exact pairing-code replies from unpaired senders
 *   3. DM policy gate     — pairing challenge / allowlist / deny
 *   4. binding resolution — deterministic most-specific-wins agent pick
 *   5. session routing    — prompt turn with streamed, coalesced delivery
 *
 * The gateway is a daemon client. It never mutates daemon config, never
 * changes permission modes, and the only channel input with authority is
 * the exact single-use approval token (see approvals.ts).
 */

import { ApprovalRegistry, formatApprovalPrompt } from "./approvals.js";
import { resolveBinding } from "./bindings.js";
import type { TelegramOwnerControl } from "./control-plane.js";
import type { GatewayMemeFeature, GatewayMemeReplyOptions } from "./meme.js";
import { evaluateDmAccess, PairingStore } from "./pairing.js";
import { detectPromptInjectionAttempt } from "./prompt-injection.js";
import { SessionRouter } from "./session-router.js";
import { TELEGRAM_CHANNEL_ID } from "./telegram-channel.js";
import { frameChannelMessage } from "./untrusted.js";
import type {
  ChannelAdapter,
  GatewayConfig,
  GatewayDaemonClient,
  InboundChannelMessage,
} from "./types.js";

export interface GatewayOptions {
  readonly agencHome: string;
  readonly client: GatewayDaemonClient;
  readonly config: GatewayConfig;
  readonly log?: (line: string) => void;
  /** Test seams. */
  readonly now?: () => number;
  readonly generatePairingCode?: () => string;
  readonly generateApprovalToken?: () => string;
  readonly approvalTimeoutMs?: number;
  readonly flushIntervalMs?: number;
  readonly memeFeature?: GatewayMemeFeature;
  readonly controlPlane?: TelegramOwnerControl;
}

export class ChannelGateway {
  readonly #config: GatewayConfig;
  readonly #pairing: PairingStore;
  readonly #approvals: ApprovalRegistry;
  readonly #router: SessionRouter;
  readonly #adapters = new Map<string, ChannelAdapter>();
  readonly #log: (line: string) => void;
  readonly #memeFeature?: GatewayMemeFeature;
  readonly #controlPlane?: TelegramOwnerControl;

  constructor(options: GatewayOptions) {
    this.#config = options.config;
    this.#log = options.log ?? (() => {});
    this.#memeFeature = options.memeFeature;
    this.#controlPlane = options.controlPlane;
    this.#pairing = new PairingStore({
      agencHome: options.agencHome,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generatePairingCode !== undefined
        ? { generateCode: options.generatePairingCode }
        : {}),
    });
    this.#approvals = new ApprovalRegistry({
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.generateApprovalToken !== undefined
        ? { generateToken: options.generateApprovalToken }
        : {}),
      ...(options.approvalTimeoutMs !== undefined
        ? { timeoutMs: options.approvalTimeoutMs }
        : {}),
    });
    this.#router = new SessionRouter({
      agencHome: options.agencHome,
      client: options.client,
      ...(options.flushIntervalMs !== undefined
        ? { flushIntervalMs: options.flushIntervalMs }
        : {}),
    });
  }

  get pairingStore(): PairingStore {
    return this.#pairing;
  }

  async registerAdapter(adapter: ChannelAdapter): Promise<void> {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`gateway: duplicate channel adapter id '${adapter.id}'`);
    }
    this.#adapters.set(adapter.id, adapter);
    await adapter.start({
      onMessage: (message) => this.handleInbound(message),
    });
    this.#log(`gateway: channel '${adapter.id}' started`);
  }

  async stop(): Promise<void> {
    for (const adapter of this.#adapters.values()) {
      await adapter.stop();
    }
    this.#adapters.clear();
  }

  async handleInbound(message: InboundChannelMessage): Promise<void> {
    const adapter = this.#adapters.get(message.channelId);
    if (adapter === undefined) {
      this.#log(
        `gateway: dropped message for unregistered channel '${message.channelId}'`,
      );
      return;
    }
    const reply = (
      text: string,
      options: GatewayMemeReplyOptions = {},
    ): Promise<string> =>
      adapter.send({ conversationId: message.conversation.id, text, ...options });

    // 1. Approval replies always take precedence and are always consumed —
    //    settled or rejected, they never become prompt text.
    const approvalOutcome = this.#approvals.handleReply({
      channelId: message.channelId,
      conversationId: message.conversation.id,
      peerId: message.sender.peerId,
      text: message.text,
    });
    if (approvalOutcome === "settled") return;
    if (approvalOutcome === "rejected") {
      await reply("That approval token is not valid here.");
      return;
    }

    const control = await this.#controlPlane?.handle({ message, reply });
    if (control?.handled === true) return;
    const bypassAccess = control?.bypassAccess === true;

    // 2 + 3. DM policy gate (groups follow the same sender gate: an
    //    unpaired sender in a group cannot drive the agent either).
    if (!bypassAccess) {
      const policy = this.#config.channels[message.channelId];
      const access = evaluateDmAccess({
        ...(policy !== undefined ? { policy } : {}),
        channelId: message.channelId,
        sender: message.sender,
        store: this.#pairing,
      });
      if (access.kind === "denied") {
        this.#log(
          `gateway: denied '${message.sender.peerId}' on '${message.channelId}': ${access.reason}`,
        );
        return;
      }
      if (access.kind === "pairing_challenge") {
        // A pending challenge exists (or was just minted). An exact code
        // reply redeems it; anything else re-renders the challenge.
        if (this.#pairing.redeem(message.channelId, message.sender, message.text)) {
          await reply(
            "Paired. This conversation now reaches your AgenC agent — send a message to begin.",
          );
          return;
        }
        await reply(
          [
            "This agent is pairing-protected.",
            `Your pairing code: ${access.code}`,
            "Confirm it on the gateway host (agenc gateway pairing list), then reply with the code to pair.",
          ].join("\n"),
        );
        return;
      }
    }

    const injection = detectPromptInjectionAttempt(message.text);
    if (injection.blocked) {
      this.#log(
        `gateway: blocked prompt injection from '${message.sender.peerId}' on '${message.channelId}': ${injection.reason ?? "unknown"}`,
      );
      await reply(injection.reply ?? "Prompt injection blocked.");
      return;
    }

    if (this.#memeFeature !== undefined) {
      const handled = await this.#memeFeature.handle({
        text: message.text,
        reply,
      });
      if (handled) return;
    }

    // 4. Binding resolution.
    const resolved = resolveBinding({
      bindings: this.#config.bindings,
      defaultAgent: this.#config.defaultAgent,
      channelId: message.channelId,
      sender: message.sender,
      conversation: message.conversation,
    });

    // 5. Session routing + turn execution with the approval round-trip.
    // Channel text is untrusted: it is sanitized + framed here so it can never
    // forge system framing or be read as a privilege-escalation directive.
    // This is the ONLY form in which channel text reaches session.prompt.
    const framedText = frameChannelMessage({
      channelId: message.channelId,
      peerId: message.sender.peerId,
      ...(message.sender.displayName !== undefined
        ? { displayName: message.sender.displayName }
        : {}),
      text: message.text,
    });
    const key = SessionRouter.conversationKey({
      channelId: message.channelId,
      agent: resolved.agent,
      conversationId: message.conversation.id,
    });
    try {
      await this.#router.runTurn({
        key,
        text: framedText,
        adapter,
        conversationId: message.conversation.id,
        onPermissionRequest: async (request) => {
          if (message.channelId === TELEGRAM_CHANNEL_ID) {
            this.#log(
              `gateway: denied Telegram permission request '${request.toolName ?? "unknown"}' from '${message.sender.peerId}'`,
            );
            return {
              behavior: "deny",
              reason:
                "Telegram gateway does not expose privileged tools. Answer the user directly from available context without mentioning internal tool policy.",
            };
          }
          const { token, decision } = this.#approvals.register({
            channelId: message.channelId,
            conversationId: message.conversation.id,
            peerId: message.sender.peerId,
          });
          await reply(formatApprovalPrompt(request, token));
          return decision;
        },
      });
    } catch (error) {
      this.#log(`gateway: turn failed on '${key}': ${String(error)}`);
      await reply("The agent hit an error running that turn. Try again.");
    }
  }
}
