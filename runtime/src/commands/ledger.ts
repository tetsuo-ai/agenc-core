/**
 * `/ledger` — query the Ledger wallet via the official `wallet-cli`
 * (Ledger Agent Stack). Thin pass-through: `/ledger <subcommand> [args]`
 * runs `wallet-cli <subcommand> [args]` and shows the output.
 *
 * Design notes (mirroring the wallet-cli-usage skill's safety rules):
 * - Read-only subcommands (session, balances, operations, assets, swap
 *   quote/status, earn yields/positions) run with a short timeout — no
 *   device needed.
 * - Device subcommands (account discover, receive, send, genuine-check,
 *   swap execute, earn deposit/withdraw, ring *) need the Ledger on USB and
 *   a physical on-device approval, so they get a long timeout and a heads-up
 *   line — per the skill, device commands must NOT be killed while the CLI
 *   is waiting for the human to confirm on the signer.
 * - Value-moving actions are never executed by this command alone; the
 *   Ledger hardware enforces the "agents propose, humans approve" boundary.
 *
 * @module
 */

import { spawn } from "node:child_process";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandResult,
} from "./types.js";

const READONLY_TIMEOUT_MS = 30_000;
const DEVICE_TIMEOUT_MS = 120_000;

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Exported for injection from tests. */
export function runWalletCli(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn("wallet-cli", [...args], { cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), code: -1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

/**
 * Subcommands that talk to the Ledger device over USB and wait for a
 * physical approval. Matched against the leading one/two words of the args.
 */
const DEVICE_PREFIXES = [
  "account discover",
  "receive",
  "send",
  "genuine-check",
  "swap execute",
  "earn deposit",
  "earn withdraw",
  "ring init",
  "ring encrypt",
  "ring decrypt",
  "ring keys",
  "ring destroy",
];

function requiresDevice(args: readonly string[]): boolean {
  const joined = args.join(" ").toLowerCase();
  return DEVICE_PREFIXES.some((prefix) => joined.startsWith(prefix));
}

const USAGE = [
  "/ledger — Ledger wallet (via wallet-cli)",
  "",
  "Read-only (no device):",
  "  /ledger session                     saved accounts",
  "  /ledger balances <label>            native + token balances",
  "  /ledger operations <label>          transaction history",
  "  /ledger swap quote ...              swap quotes",
  "  /ledger earn yields [-n ethereum]   staking / DeFi yields",
  "",
  "Needs the Ledger on USB + on-device approval:",
  "  /ledger account discover <bitcoin|ethereum|solana>",
  "  /ledger receive <label> [--verify]",
  "  /ledger genuine-check",
  "  /ledger send <label> --to <addr> --amount '<amt> <ticker>'",
  "  /ledger swap execute ...",
  "",
  "Networks: bitcoin, ethereum, solana. Value-moving actions always pause",
  "for physical approval on the device — agents propose, humans approve.",
].join("\n");

export const ledgerCommand: SlashCommand = {
  name: "ledger",
  description:
    "Ledger wallet via wallet-cli — balances, operations, send/swap/receive, earn. /ledger session to start",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const args = ctx.argsRaw.split(/\s+/).filter((s) => s.length > 0);

      // Bare `/ledger` → show the session (per the skill's "session first"
      // rule) followed by usage, so the user sees saved accounts immediately.
      if (args.length === 0) {
        const session = await runWalletCli(
          ["session", "view", "--output", "human"],
          ctx.cwd,
          READONLY_TIMEOUT_MS,
        );
        const sessionText =
          session.code === 0 && session.stdout.trim().length > 0
            ? session.stdout.trimEnd()
            : "(no saved accounts yet — run /ledger account discover <network>)";
        return {
          kind: "text",
          text: `${sessionText}\n\n${USAGE}`,
        };
      }

      const device = requiresDevice(args);
      const timeoutMs = device ? DEVICE_TIMEOUT_MS : READONLY_TIMEOUT_MS;
      const result = await runWalletCli(
        [...args, "--output", "human"],
        ctx.cwd,
        timeoutMs,
      );

      // wallet-cli not installed (spawn error / ENOENT).
      if (result.code === -1) {
        return {
          kind: "error",
          message:
            "wallet-cli not found. Install it: npm i -g @ledgerhq/wallet-cli (requires Bun).",
        };
      }
      if (result.timedOut) {
        return {
          kind: "error",
          message: device
            ? `wallet-cli timed out after ${DEVICE_TIMEOUT_MS / 1000}s waiting for on-device approval. Confirm on your Ledger and retry.`
            : `wallet-cli timed out after ${READONLY_TIMEOUT_MS / 1000}s.`,
        };
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        return {
          kind: "error",
          message: `wallet-cli failed (exit ${result.code}): ${detail}`,
        };
      }

      const body = result.stdout.trimEnd() || "(no output)";
      const text = device
        ? `[confirm on your Ledger device]\n${body}`
        : body;
      return { kind: "text", text };
    }),
};
