import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { TELEGRAM_CHANNEL_ID } from "./telegram-channel.js";
import type { ChannelSender, InboundChannelMessage } from "./types.js";

export interface TelegramOwnerControlState {
  readonly publicEnabled: boolean;
  readonly ownerPeerIds: readonly string[];
  readonly updatedAt: string;
}

export interface TelegramOwnerControlOptions {
  readonly agencHome: string;
  readonly adminPeerIds?: readonly string[];
  readonly ownerClaimCode?: string;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
}

export interface TelegramOwnerControlReplyOptions {
  readonly photoUrl?: string;
  readonly caption?: string;
}

export interface TelegramOwnerControlHandleInput {
  readonly message: InboundChannelMessage;
  readonly reply: (
    text: string,
    options?: TelegramOwnerControlReplyOptions,
  ) => Promise<string>;
}

export type TelegramOwnerControlDecision =
  | { readonly handled: true }
  | { readonly handled: false; readonly bypassAccess?: boolean };

interface StoredTelegramOwnerControlState {
  readonly publicEnabled?: unknown;
  readonly ownerPeerIds?: unknown;
  readonly updatedAt?: unknown;
}

interface ParsedCommand {
  readonly name: string;
  readonly args: string;
}

export const TELEGRAM_OWNER_COMMANDS = Object.freeze([
  { command: "start", description: "turn public group replies on" },
  { command: "stop", description: "pause public group replies" },
  { command: "status", description: "show bot control status" },
  { command: "help", description: "show owner controls" },
  { command: "meme", description: "generate an AgenC meme" },
] as const);

const CONTROL_COMMANDS = new Set([
  "start",
  "resume",
  "stop",
  "pause",
  "status",
  "help",
  "owner",
]);

function parsePeerList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const firstSpace = trimmed.search(/\s/);
  const raw =
    firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
  const name = raw.split("@", 1)[0]?.toLowerCase();
  if (name === undefined || name.length === 0) return undefined;
  const args = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  return { name, args };
}

function sanitizeOwnerIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeState(
  input: StoredTelegramOwnerControlState | undefined,
  now: Date,
): TelegramOwnerControlState {
  return {
    publicEnabled:
      typeof input?.publicEnabled === "boolean" ? input.publicEnabled : true,
    ownerPeerIds: sanitizeOwnerIds(input?.ownerPeerIds),
    updatedAt: typeof input?.updatedAt === "string" ? input.updatedAt : now.toISOString(),
  };
}

export class TelegramOwnerControl {
  readonly #path: string;
  readonly #adminPeerIds: readonly string[];
  readonly #ownerClaimCode?: string;
  readonly #log: (line: string) => void;
  readonly #now: () => Date;

  constructor(options: TelegramOwnerControlOptions) {
    this.#path = join(options.agencHome, "gateway", "control.json");
    this.#adminPeerIds = parsePeerList(options.adminPeerIds ?? []);
    this.#log = options.log ?? (() => {});
    this.#now = options.now ?? (() => new Date());
    const code = options.ownerClaimCode?.trim();
    if (code !== undefined && code.length > 0) {
      this.#ownerClaimCode = code;
    }
  }

  async handle(
    input: TelegramOwnerControlHandleInput,
  ): Promise<TelegramOwnerControlDecision> {
    const { message, reply } = input;
    if (message.channelId !== TELEGRAM_CHANNEL_ID) {
      return { handled: false };
    }

    const state = this.#load();
    const command = parseCommand(message.text);
    const isOwner = this.#isOwner(message.sender, state);
    const ownerCount = this.#ownerCount(state);
    const isDm = message.conversation.kind === "dm";

    if (command?.name === "owner") {
      await this.#handleOwnerClaim({ message, reply, state, isOwner, ownerCount, args: command.args });
      return { handled: true };
    }

    if (command !== undefined && CONTROL_COMMANDS.has(command.name)) {
      if (!isOwner) {
        if (!isDm) {
          await reply(this.#ownerOnlyMessage(ownerCount));
        }
        this.#log(
          `telegram-control: denied owner command '/${command.name}' from '${message.sender.peerId}'`,
        );
        return { handled: true };
      }
      await this.#handleOwnerCommand({ command, reply, state });
      return { handled: true };
    }

    if (isDm) {
      if (isOwner) return { handled: false, bypassAccess: true };
      this.#log(
        `telegram-control: denied private DM from non-owner '${message.sender.peerId}'`,
      );
      return { handled: true };
    }

    if (!state.publicEnabled) {
      return { handled: true };
    }
    return { handled: false, bypassAccess: true };
  }

  #load(): TelegramOwnerControlState {
    if (!existsSync(this.#path)) return normalizeState(undefined, this.#now());
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as
        | StoredTelegramOwnerControlState
        | undefined;
      return normalizeState(parsed, this.#now());
    } catch (error) {
      this.#log(`telegram-control: failed to read control state: ${String(error)}`);
      return normalizeState(undefined, this.#now());
    }
  }

  #save(state: Omit<TelegramOwnerControlState, "updatedAt">): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const next: TelegramOwnerControlState = {
      ...state,
      ownerPeerIds: parsePeerList(state.ownerPeerIds),
      updatedAt: this.#now().toISOString(),
    };
    writeFileSync(this.#path, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  #isOwner(sender: ChannelSender, state: TelegramOwnerControlState): boolean {
    return (
      this.#adminPeerIds.includes(sender.peerId) ||
      state.ownerPeerIds.includes(sender.peerId)
    );
  }

  #ownerCount(state: TelegramOwnerControlState): number {
    return new Set([...this.#adminPeerIds, ...state.ownerPeerIds]).size;
  }

  async #handleOwnerClaim(input: {
    readonly message: InboundChannelMessage;
    readonly reply: (text: string) => Promise<string>;
    readonly state: TelegramOwnerControlState;
    readonly isOwner: boolean;
    readonly ownerCount: number;
    readonly args: string;
  }): Promise<void> {
    if (input.ownerCount > 0) {
      await input.reply(
        input.isOwner
          ? "Owner already configured. Use /status to check the bot."
          : "Owner already configured. Private control is owner-only.",
      );
      return;
    }
    if (input.message.conversation.kind !== "dm") {
      await input.reply("Claim ownership from a private chat with the bot.");
      return;
    }
    if (this.#ownerClaimCode === undefined) {
      await input.reply("Owner claim is not configured on this bot.");
      return;
    }
    if (input.args.trim() !== this.#ownerClaimCode) {
      await input.reply("Wrong owner code.");
      return;
    }
    this.#save({
      publicEnabled: input.state.publicEnabled,
      ownerPeerIds: [input.message.sender.peerId],
    });
    await input.reply(
      [
        "Owner claimed.",
        "Private DMs are now owner-only.",
        "Use /stop to pause the public group and /start to turn it back on.",
      ].join("\n"),
    );
  }

  async #handleOwnerCommand(input: {
    readonly command: ParsedCommand;
    readonly reply: (text: string) => Promise<string>;
    readonly state: TelegramOwnerControlState;
  }): Promise<void> {
    const { command, reply, state } = input;
    if (command.name === "start" || command.name === "resume") {
      this.#save({
        publicEnabled: true,
        ownerPeerIds: state.ownerPeerIds,
      });
      await reply("Public group replies are ON.");
      return;
    }
    if (command.name === "stop" || command.name === "pause") {
      this.#save({
        publicEnabled: false,
        ownerPeerIds: state.ownerPeerIds,
      });
      await reply("Public group replies are PAUSED. Use /start to resume.");
      return;
    }
    if (command.name === "status") {
      await reply(this.#statusText(state));
      return;
    }
    await reply(this.#helpText());
  }

  #statusText(state: TelegramOwnerControlState): string {
    const groupStatus = state.publicEnabled ? "on" : "paused";
    return [
      "AgenC bot status",
      `Public group: ${groupStatus}`,
      "Private DM: owner-only",
      `Owners: ${this.#ownerCount(state)}`,
      "Media: /meme is enabled when configured server-side.",
    ].join("\n");
  }

  #helpText(): string {
    return [
      "AgenC owner controls",
      "/start - turn public group replies on",
      "/stop - pause public group replies",
      "/status - show current state",
      "/meme <idea> - generate a meme",
      "",
      "Private DMs are owner-only. Group messages are public when the bot is on.",
    ].join("\n");
  }

  #ownerOnlyMessage(ownerCount: number): string {
    if (ownerCount === 0 && this.#ownerClaimCode !== undefined) {
      return "Owner setup is not claimed yet. The owner must DM /owner <code>.";
    }
    return "Owner-only command.";
  }

}
