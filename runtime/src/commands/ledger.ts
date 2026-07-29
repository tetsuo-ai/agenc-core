/**
 * `/ledger` — query the Ledger wallet via the official `wallet-cli`
 * (Ledger Agent Stack). `/ledger <subcommand> [args]` maps friendly aliases,
 * applies transcript/device safety rules, and invokes the exact resolved
 * `wallet-cli` executable without a shell.
 *
 * Design notes (mirroring the wallet-cli-usage skill's safety rules):
 * - Read-only subcommands (session, balances, operations, assets, swap
 *   quote/status, earn yields/positions) run with a short timeout — no
 *   device needed.
 * - Device subcommands (account discover, verified receive, send,
 *   genuine-check, swap execute, earn deposit/withdraw, ring init) need the
 *   Ledger on USB and a physical on-device approval, so they have no
 *   artificial timeout and receive a heads-up line.
 * - Value-moving actions are never executed by this command alone; the
 *   Ledger hardware enforces the "agents propose, humans approve" boundary.
 *
 * @module
 */

import { join } from "node:path";
import {
  getLedgerStatusSnapshot,
  refreshLedgerStatus,
} from "../services/Ledger/ledgerStatus.js";
import {
  getWalletCliStatus,
  installLatestWalletCli,
  resolveWalletCliExecutable,
  runWalletCliProcess,
  type WalletCliProcessResult,
} from "../services/Ledger/walletCli.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandResult,
} from "./types.js";

const READONLY_TIMEOUT_MS = 30_000;

type CliResult = WalletCliProcessResult;

export type LedgerArgumentParseResult =
  | { readonly ok: true; readonly args: readonly string[] }
  | { readonly ok: false; readonly error: string };

/**
 * Parse slash-command arguments without invoking a shell. Quoted amounts and
 * paths remain one argv entry, while expansions and operators stay literal.
 */
export function parseLedgerArguments(raw: string): LedgerArgumentParseResult {
  const args: string[] = [];
  let current = "";
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (char === "\\" && quote !== "'") {
      const next = raw[index + 1];
      const escapesNext =
        next !== undefined &&
        (next === "\\" ||
          next === quote ||
          (quote === null &&
            (next === "'" || next === '"' || /\s/u.test(next))));
      if (escapesNext) {
        current += next;
        index++;
      } else {
        current += "\\";
      }
      tokenStarted = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += char;
    tokenStarted = true;
  }

  if (quote !== null) {
    return {
      ok: false,
      error: `Ledger arguments contain an unclosed ${quote} quote.`,
    };
  }
  if (tokenStarted) args.push(current);
  return { ok: true, args };
}

/** Exported for injection from tests. */
export function runWalletCli(
  args: readonly string[],
  cwd: string,
  timeoutMs: number | undefined,
  executable = "wallet-cli",
  captureStdout = true,
): Promise<CliResult> {
  return runWalletCliProcess(executable, args, {
    cwd,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    captureStdout,
  });
}

/**
 * Subcommands that talk to the Ledger device over USB and wait for a
 * physical approval. Matched against the leading one/two words of the args.
 */
function hasOption(args: readonly string[], names: readonly string[]): boolean {
  return args.some((arg) =>
    names.some((name) => arg === name || arg.startsWith(`${name}=`)),
  );
}

function requiresDevice(args: readonly string[]): boolean {
  const [command, subcommand] = args;
  if (hasOption(args, ["--help", "-h"])) return false;
  const dryRun = hasOption(args, ["--dry-run"]);
  if (command === "receive") {
    return !hasOption(args, ["--no-verify"]);
  }
  if (command === "send") return !dryRun;
  if (command === "account" && subcommand === "discover") return true;
  if (command === "genuine-check") return true;
  if (command === "swap" && subcommand === "execute") return true;
  if (
    command === "earn" &&
    (subcommand === "deposit" || subcommand === "withdraw")
  ) {
    return !dryRun;
  }
  return command === "ring" && subcommand === "init";
}

function withDefaultHumanOutput(args: readonly string[]): readonly string[] {
  const hasOutput = args.some(
    (arg) => arg === "--output" || arg.startsWith("--output="),
  );
  return hasOutput ? args : [...args, "--output", "human"];
}

const USAGE = [
  "Ledger Wallet CLI",
  "",
  "Setup",
  "  /ledger status                      CLI + USB device status",
  "  /ledger install                     install/update latest official CLI",
  "  /ledger help [command]              command help",
  "",
  "Session",
  "  /ledger                             show saved accounts",
  "  /ledger discover <network>          discover and save accounts",
  "  /ledger reset                       clear the local account session",
  "",
  "Read-only",
  "  /ledger balances <label>            native + token balances",
  "  /ledger operations <label>          transaction history",
  "  /ledger swap quote ...              swap quotes",
  "  /ledger earn yields [-n ethereum]   staking / DeFi yields",
  "  /ledger earn positions <label>      current earn positions",
  "",
  "Device approval",
  "  /ledger receive <label>             verify address on Ledger",
  "  /ledger genuine-check",
  "  /ledger send <label> --to <addr> --amount '<amt> <ticker>'",
  "  /ledger swap execute ...",
  "  /ledger earn deposit|withdraw ...",
  "",
  "Networks: bitcoin, ethereum, solana (plus supported testnets).",
  "Use --dry-run on send/earn to validate without signing.",
  "Value-moving actions pause for physical approval on the device.",
].join("\n");

const QUICK_START = [
  "Next",
  "  /ledger balances <label>",
  "  /ledger operations <label>",
  "  /ledger receive <label>",
  "  /ledger help",
].join("\n");

const SUPPORTED_COMMANDS = new Set([
  "account",
  "assets",
  "balances",
  "earn",
  "genuine-check",
  "operations",
  "receive",
  "ring",
  "send",
  "session",
  "swap",
]);

function normalizeLedgerArgs(args: readonly string[]): readonly string[] {
  const [command, ...rest] = args;
  if (command === "accounts") return ["session", "view", ...rest];
  if (command === "reset") return ["session", "reset", ...rest];
  if (command === "discover") return ["account", "discover", ...rest];
  if (command === "session" && rest.length === 0) {
    return ["session", "view"];
  }
  if (
    rest.length === 0 &&
    (command === "account" ||
      command === "assets" ||
      command === "earn" ||
      command === "ring" ||
      command === "swap")
  ) {
    return [command, "--help"];
  }
  return args;
}

function ringSafetyError(args: readonly string[]): string | null {
  if (args[0] !== "ring" || hasOption(args, ["--help", "-h"])) return null;
  const subcommand = args[1];
  if (subcommand === "encrypt" || subcommand === "decrypt") {
    if (!hasOption(args, ["--input", "-i"])) {
      return `/ledger ring ${subcommand} requires --input <file>; the slash command never reads secret data from the composer or terminal stdin.`;
    }
    if (!hasOption(args, ["--out", "-o"])) {
      return `/ledger ring ${subcommand} requires --out <file>; decrypted or encrypted payloads are never printed into the AgenC transcript.`;
    }
  }
  if (subcommand === "init" && !process.env.WALLET_PASS) {
    return [
      "/ledger ring init requires WALLET_PASS to already be provided by your",
      "user session or OS keychain. AgenC will never ask for or embed the",
      "password in the command.",
    ].join(" ");
  }
  if (subcommand === "destroy") {
    return [
      "Ledger Key Ring destruction requires interactive typed confirmation and",
      "is intentionally not automated by /ledger. Run wallet-cli ring destroy",
      "in a dedicated terminal after reviewing the remote and local wipe.",
    ].join(" ");
  }
  return null;
}

function renderCliOutput(stdout: string, args: readonly string[]): string {
  const trimmed = stdout.trimEnd();
  if (!hasOption(args, ["--help", "-h"])) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as {
      readonly data?: { readonly text?: unknown };
    };
    if (typeof parsed.data?.text === "string") return parsed.data.text;
  } catch {
    // Older releases already emit help as plain text.
  }
  return trimmed;
}

async function ledgerStatusText(agencHome: string): Promise<string> {
  const [cliStatus] = await Promise.all([
    getWalletCliStatus({ agencHome }),
    refreshLedgerStatus(),
  ]);
  const device = getLedgerStatusSnapshot();
  const cliLine = cliStatus.installed
    ? `CLI      installed${cliStatus.version ? ` · ${cliStatus.version}` : ""} · ${cliStatus.source}`
    : "CLI      not installed";
  const deviceLine = device.detected
    ? `DEVICE   connected · ${device.model ?? "Ledger"}`
    : "DEVICE   not detected on USB";
  return [
    "LEDGER STATUS",
    cliLine,
    deviceLine,
    ...(cliStatus.executable ? [`PATH     ${cliStatus.executable}`] : []),
    ...(!cliStatus.installed
      ? ["", "Next: /ledger install"]
      : ["", "Next: /ledger  (view saved accounts)"]),
  ].join("\n");
}

export const ledgerCommand: SlashCommand = {
  name: "ledger",
  aliases: ["wallet"],
  description:
    "Ledger wallet · session, balances, receive, send, swap and earn",
  argumentHint:
    "[status|install|session|discover|balances|operations|receive|send|swap|earn|ring|help]",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const parsed = parseLedgerArguments(ctx.argsRaw);
      if (!parsed.ok) return { kind: "error", message: parsed.error };
      const args = parsed.args;
      const agencHome = ctx.agencHome ?? join(ctx.home, ".agenc");

      if (
        args.length === 1 &&
        (args[0] === "help" || args[0] === "--help" || args[0] === "-h")
      ) {
        return { kind: "text", text: USAGE };
      }
      if (
        args.length === 1 &&
        (args[0] === "status" ||
          args[0] === "version" ||
          args[0] === "device")
      ) {
        return { kind: "text", text: await ledgerStatusText(agencHome) };
      }
      if (args[0] === "install" || args[0] === "update") {
        if (args.length !== 1) {
          return {
            kind: "error",
            message: `Usage: /ledger ${args[0]}`,
          };
        }
        const installed = await installLatestWalletCli({ agencHome });
        return {
          kind: "text",
          text: installed.alreadyCurrent
            ? `Ledger Wallet CLI ${installed.version} is already the latest official release.\n${installed.executable}`
            : `Installed Ledger Wallet CLI ${installed.version} from ${installed.platformPackage}.\n${installed.executable}`,
        };
      }

      const requested =
        args[0] === "help" && args.length > 1
          ? [...args.slice(1), "--help"]
          : args;
      const normalized =
        requested.length === 0
          ? ["session", "view"]
          : normalizeLedgerArgs(requested);
      const command = normalized[0];
      if (command === undefined || !SUPPORTED_COMMANDS.has(command)) {
        return {
          kind: "error",
          message: `Unknown Ledger command: ${command ?? "(empty)"}\n\n${USAGE}`,
        };
      }
      const safetyError = ringSafetyError(normalized);
      if (safetyError !== null) {
        return { kind: "error", message: safetyError };
      }

      // Engaging Ledger refreshes the passive bottom-bar USB indicator. It is
      // on-demand only; nothing polls the signer in the background.
      void refreshLedgerStatus();
      const executable = await resolveWalletCliExecutable({ agencHome });
      if (executable === null) {
        return {
          kind: "text",
          text: [
            "Ledger Wallet CLI is not installed.",
            "Nothing has been downloaded.",
            "",
            "Run /ledger install to approve and install the latest official",
            "@ledgerhq/wallet-cli release in AgenC-managed storage.",
          ].join("\n"),
        };
      }

      // Bare `/ledger` → show the session (per the skill's "session first"
      // rule) followed by a compact next-step guide.
      if (args.length === 0) {
        const session = await runWalletCli(
          ["session", "view", "--output", "human"],
          ctx.cwd,
          READONLY_TIMEOUT_MS,
          executable.path,
        );
        if (session.code === -1) {
          return {
            kind: "error",
            message:
              "Ledger Wallet CLI became unavailable. Run /ledger install to repair the managed installation.",
          };
        }
        if (session.code !== 0 || session.timedOut) {
          const detail = session.stderr.trim() || session.stdout.trim();
          return {
            kind: "error",
            message: session.timedOut
              ? `wallet-cli session view timed out after ${READONLY_TIMEOUT_MS / 1000}s.`
              : `wallet-cli session view failed (exit ${session.code}): ${detail}`,
          };
        }
        const sessionText =
          session.stdout.trim().length > 0
            ? session.stdout.trimEnd()
            : "(no saved accounts yet — run /ledger account discover <network>)";
        return {
          kind: "text",
          text: `${sessionText}\n\n${QUICK_START}`,
        };
      }

      const device = requiresDevice(normalized);
      // Device commands can legitimately wait indefinitely for the human to
      // review and approve on the physical signer. Only read-only network
      // queries receive the short command timeout.
      const timeoutMs = device ? undefined : READONLY_TIMEOUT_MS;
      const suppressDecryptedOutput =
        normalized[0] === "ring" && normalized[1] === "decrypt";
      const result = await runWalletCli(
        withDefaultHumanOutput(normalized),
        ctx.cwd,
        timeoutMs,
        executable.path,
        !suppressDecryptedOutput,
      );

      // The executable disappeared or became unreadable after resolution.
      if (result.code === -1) {
        return {
          kind: "error",
          message:
            "Ledger Wallet CLI became unavailable. Run /ledger install to repair the managed installation.",
        };
      }
      if (result.timedOut) {
        return {
          kind: "error",
          message: `wallet-cli timed out after ${READONLY_TIMEOUT_MS / 1000}s.`,
        };
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        return {
          kind: "error",
          message: `wallet-cli failed (exit ${result.code}): ${detail}`,
        };
      }

      const body = suppressDecryptedOutput
        ? "Decrypted output written to the requested file."
        : renderCliOutput(result.stdout, normalized) || "(no output)";
      const text = device
        ? `[confirm on your Ledger device]\n${body}`
        : body;
      return { kind: "text", text };
    }),
};
