import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeDurableAtomicFileSync } from "../utils/durable-atomic-file.js";
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

/**
 * What one message is decided on: the stored state, or its fail-closed
 * stand-in when the state file is present but cannot be used.
 */
interface LoadedTelegramOwnerControlState extends TelegramOwnerControlState {
  /**
   * The state file exists but could not be read as a JSON object. The other
   * fields are then the closed values (public replies off, no stored owners),
   * not what was stored.
   */
  readonly unreadable: boolean;
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
] as const);

export const TELEGRAM_PUBLIC_MEDIA_COMMANDS = Object.freeze([
  { command: "image", description: "generate an AgenC image" },
  { command: "meme", description: "generate an AgenC meme" },
  { command: "voice", description: "generate a short voice clip" },
  { command: "song", description: "generate a short sung clip" },
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
  /** The unreadable state has been logged and has not been readable since. */
  #unreadableLogged = false;

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
      if (!isDm) {
        await reply(
          isOwner
            ? "Owner controls live in the private DM. Use the bot chat for /start, /stop, /status, and /help."
            : this.#ownerOnlyMessage(ownerCount, state.unreadable),
        );
        this.#log(
          `telegram-control: denied group owner command '/${command.name}' from '${message.sender.peerId}'`,
        );
        return { handled: true };
      }
      if (!isOwner) {
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

  /**
   * Three outcomes:
   * - no file: a first run, so the defaults apply (public replies on, no
   *   stored owners, the bot can be claimed);
   * - a JSON object: the stored state;
   * - anything else (a read error, an empty or cut-short file, JSON that is
   *   not an object): unreadable, which fails closed. Using the defaults
   *   here would turn a paused group back on and let another account claim
   *   the bot.
   * Loading never deletes or rewrites the file; only `#save` replaces it.
   */
  #load(): LoadedTelegramOwnerControlState {
    let raw: string;
    try {
      raw = readFileSync(this.#path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return this.#readable(undefined);
      return this.#failClosed(`the read failed with ${String(code)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.#failClosed(
        raw.trim().length === 0
          ? "the file is empty"
          : "the file is not valid JSON",
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return this.#failClosed("the JSON value is not an object");
    }
    return this.#readable(parsed as StoredTelegramOwnerControlState);
  }

  #readable(
    input: StoredTelegramOwnerControlState | undefined,
  ): LoadedTelegramOwnerControlState {
    this.#unreadableLogged = false;
    return { ...normalizeState(input, this.#now()), unreadable: false };
  }

  #failClosed(reason: string): LoadedTelegramOwnerControlState {
    // Every message loads the state, so say why once, not once per message.
    if (!this.#unreadableLogged) {
      this.#unreadableLogged = true;
      this.#log(
        [
          `telegram-control: control state '${this.#path}' is unreadable (${reason});`,
          "failing closed: public group replies are off, stored owners are ignored and /owner claims are refused.",
          "Repair or remove the file, or have an admin owner send /stop or /start to replace it.",
        ].join(" "),
      );
    }
    return {
      publicEnabled: false,
      ownerPeerIds: [],
      updatedAt: this.#now().toISOString(),
      unreadable: true,
    };
  }

  #save(state: Omit<TelegramOwnerControlState, "updatedAt">): void {
    const next: TelegramOwnerControlState = {
      publicEnabled: state.publicEnabled,
      ownerPeerIds: parsePeerList(state.ownerPeerIds),
      updatedAt: this.#now().toISOString(),
    };
    // Temporary file, fsync, rename: a write that fails or is interrupted
    // leaves the previous state in place, never an empty or cut-short file.
    // The helper creates the directory 0700; the file is always 0600.
    writeDurableAtomicFileSync(
      this.#path,
      `${this.#path}.${process.pid}.${randomUUID()}.tmp`,
      `${JSON.stringify(next, null, 2)}\n`,
      0o600,
    );
    this.#unreadableLogged = false;
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
    readonly state: LoadedTelegramOwnerControlState;
    readonly isOwner: boolean;
    readonly ownerCount: number;
    readonly args: string;
  }): Promise<void> {
    if (input.state.unreadable) {
      // Whether the bot already has an owner is not known, so nobody can
      // claim it until the state is readable again.
      await input.reply(
        [
          "Owner claim refused: the owner state on the host is unreadable.",
          input.isOwner
            ? "Use /status to see how to replace it."
            : "The host operator must repair or remove the state file first.",
        ].join("\n"),
      );
      return;
    }
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
    readonly state: LoadedTelegramOwnerControlState;
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

  #statusText(state: LoadedTelegramOwnerControlState): string {
    const groupStatus = state.publicEnabled ? "on" : "paused";
    return [
      "AgenC bot status",
      `Public group: ${groupStatus}`,
      "Private DM: owner-only",
      `Owners: ${this.#ownerCount(state)}`,
      ...(state.unreadable
        ? [
            "Stored state: unreadable on the host. Public group replies stay off, stored owners are ignored and /owner claims are refused.",
            "Send /stop or /start to replace it with a fresh state file (stored owners are not restored).",
          ]
        : []),
      "Media: /image, /meme, /voice, and /song are enabled when configured server-side.",
    ].join("\n");
  }

  #helpText(): string {
    return [
      "AgenC owner controls",
      "/start - turn public group replies on",
      "/stop - pause public group replies",
      "/status - show current state",
      "/image <idea> - generate an AgenC image",
      "/meme <idea> - generate a meme",
      "/voice <line> - generate a short voice clip",
      "/song <idea> - generate a short sung clip",
      "",
      "Private DMs are owner-only. Group messages are public when the bot is on.",
    ].join("\n");
  }

  #ownerOnlyMessage(ownerCount: number, unreadable: boolean): string {
    // With unreadable state a claim is refused, so do not invite one.
    if (
      !unreadable &&
      ownerCount === 0 &&
      this.#ownerClaimCode !== undefined
    ) {
      return "Owner setup is not claimed yet. The owner must DM /owner <code>.";
    }
    return "Owner-only command.";
  }

}
