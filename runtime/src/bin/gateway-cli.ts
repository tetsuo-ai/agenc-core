/**
 * `agenc gateway` — inspect and operate the channel gateway (tasks 6-7).
 *
 *   agenc gateway run [--stdio]       start the gateway with configured
 *                                     channels (stdio dev channel + Telegram
 *                                     when AGENC_TELEGRAM_BOT_TOKEN is set)
 *   agenc gateway status              config summary (channels, policies,
 *                                     bindings, paired counts)
 *   agenc gateway pairing list        paired senders, per channel
 *   agenc gateway pairing revoke <channel> <peerId>
 *
 * Pairing/status never sign, spend, or mutate daemon state. `run` is a daemon
 * CLIENT: it opens no listener of its own (Telegram uses outbound long-poll).
 */

import { resolveAgencHome } from "../config/env.js";
import { loadGatewayConfig, resolveGatewayConfigPath } from "../gateway/config.js";
import { PairingStore } from "../gateway/pairing.js";
import { startGateway } from "../gateway/run.js";
import type { GatewayConfig } from "../gateway/types.js";

export type AgenCGatewayCliCommand =
  | { readonly kind: "run"; readonly stdio: boolean; readonly webchat: boolean }
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "pairing-list"; readonly json: boolean }
  | {
      readonly kind: "pairing-revoke";
      readonly channelId: string;
      readonly peerId: string;
    }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export function formatAgenCGatewayCliHelpText(): string {
  return [
    "agenc gateway — inspect and operate the channel gateway",
    "",
    "Usage:",
    "  agenc gateway run [--stdio] [--webchat]",
    "                                        Start the gateway. --stdio enables",
    "                                        the local dev channel; --webchat a",
    "                                        loopback token-gated browser UI;",
    "                                        Telegram when AGENC_TELEGRAM_BOT_TOKEN",
    "                                        is set. Runs until Ctrl-C.",
    "  agenc gateway status [--json]         Channels, DM policies, bindings,",
    "                                        paired-sender counts",
    "  agenc gateway pairing list [--json]   Paired senders per channel",
    "  agenc gateway pairing revoke <channel> <peerId>",
    "                                        Remove a paired sender",
    "",
    "Config: <AGENC_HOME>/gateway/config.json (fail-closed defaults when absent)",
    "Options:",
    "  -h, --help  Show this help text",
  ].join("\n");
}

export function parseAgenCGatewayCliArgs(
  argv: readonly string[],
): AgenCGatewayCliCommand | null {
  if (argv[0] !== "gateway") return null;
  const rest = argv.slice(1);
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    return { kind: "help", text: formatAgenCGatewayCliHelpText() };
  }
  const json = rest.includes("--json");
  const positional = rest.filter((a) => !a.startsWith("-"));

  if (positional[0] === "run") {
    return {
      kind: "run",
      stdio: rest.includes("--stdio"),
      webchat: rest.includes("--webchat"),
    };
  }
  if (positional[0] === "status") {
    return { kind: "status", json };
  }
  if (positional[0] === "pairing") {
    if (positional[1] === "list") {
      return { kind: "pairing-list", json };
    }
    if (positional[1] === "revoke") {
      const channelId = positional[2];
      const peerId = positional[3];
      if (channelId === undefined || peerId === undefined) {
        return {
          kind: "error",
          message: "pairing revoke needs <channel> <peerId>",
        };
      }
      return { kind: "pairing-revoke", channelId, peerId };
    }
    return {
      kind: "error",
      message: "unknown pairing subcommand (expected: list, revoke)",
    };
  }
  return {
    kind: "error",
    message: `unknown gateway subcommand '${positional[0] ?? ""}'`,
  };
}

export interface GatewayCliDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /**
   * `run` blocks until this resolves (default: SIGINT/SIGTERM). Test seam.
   */
  readonly waitForShutdown?: () => Promise<void>;
  /** `run` daemon-client + adapter injection. Test seam. */
  readonly startGateway?: typeof startGateway;
}

function waitForSignals(): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSignal = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

interface GatewayStatusReport {
  readonly configPath: string;
  readonly defaultAgent: string;
  readonly channels: ReadonlyArray<{
    readonly channelId: string;
    readonly dmPolicy: string;
    readonly allowlistSize: number;
    readonly pairedCount: number;
  }>;
  readonly bindingCount: number;
}

function buildStatus(
  agencHome: string,
  config: GatewayConfig,
  store: PairingStore,
): GatewayStatusReport {
  const channelIds = new Set<string>([
    ...Object.keys(config.channels),
    ...config.bindings.map((b) => b.channelId),
  ]);
  return {
    configPath: resolveGatewayConfigPath(agencHome),
    defaultAgent: config.defaultAgent,
    channels: [...channelIds].sort().map((channelId) => {
      const policy = config.channels[channelId];
      return {
        channelId,
        dmPolicy: policy?.dmPolicy ?? "pairing (default)",
        allowlistSize: policy?.allowlist.length ?? 0,
        pairedCount: store.listPaired(channelId).length,
      };
    }),
    bindingCount: config.bindings.length,
  };
}

export async function runAgenCGatewayCli(
  command: AgenCGatewayCliCommand,
  deps: GatewayCliDeps = {},
): Promise<number> {
  const stdout =
    deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr =
    deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (command.kind === "help") {
    stdout(command.text);
    return 0;
  }
  if (command.kind === "error") {
    stderr(`agenc: ${command.message}`);
    return 1;
  }

  const env = deps.env ?? process.env;
  const agencHome = resolveAgencHome(env);

  if (command.kind === "run") {
    const start = deps.startGateway ?? startGateway;
    let handle: Awaited<ReturnType<typeof startGateway>>;
    try {
      handle = await start({
        agencHome,
        env,
        stdio: command.stdio,
        webchat: command.webchat,
        log: (line) => stderr(line),
      });
    } catch (error) {
      stderr(`agenc: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    stdout(`gateway running (channels: ${handle.channels.join(", ")}). Ctrl-C to stop.`);
    if (handle.webchatUrl !== undefined) {
      stdout(`  WebChat: ${handle.webchatUrl}`);
    }
    try {
      await (deps.waitForShutdown ?? waitForSignals)();
    } finally {
      await handle.stop();
    }
    stdout("gateway stopped.");
    return 0;
  }

  const config = loadGatewayConfig({ agencHome, onWarn: (m) => stderr(m) });
  const store = new PairingStore({ agencHome });

  switch (command.kind) {
    case "status": {
      const report = buildStatus(agencHome, config, store);
      if (command.json) {
        stdout(JSON.stringify(report, null, 2));
        return 0;
      }
      stdout("AgenC channel gateway");
      stdout("");
      stdout(`  Config:        ${report.configPath}`);
      stdout(`  Default agent: ${report.defaultAgent}`);
      stdout(`  Bindings:      ${report.bindingCount}`);
      stdout("");
      if (report.channels.length === 0) {
        stdout("  No channels configured.");
      } else {
        stdout("  Channels:");
        for (const c of report.channels) {
          stdout(
            `    ${c.channelId}: dm=${c.dmPolicy}, allowlist=${c.allowlistSize}, paired=${c.pairedCount}`,
          );
        }
      }
      return 0;
    }
    case "pairing-list": {
      const channelIds = new Set<string>([
        ...Object.keys(config.channels),
        ...config.bindings.map((b) => b.channelId),
      ]);
      const listing = [...channelIds].sort().map((channelId) => ({
        channelId,
        paired: store.listPaired(channelId),
      }));
      if (command.json) {
        stdout(JSON.stringify(listing, null, 2));
        return 0;
      }
      let any = false;
      for (const entry of listing) {
        if (entry.paired.length === 0) continue;
        any = true;
        stdout(`${entry.channelId}:`);
        for (const peer of entry.paired) stdout(`  ${peer}`);
      }
      if (!any) stdout("No paired senders.");
      return 0;
    }
    case "pairing-revoke": {
      const removed = store.revoke(command.channelId, command.peerId);
      if (removed) {
        stdout(`Revoked ${command.peerId} on ${command.channelId}.`);
        return 0;
      }
      stderr(
        `agenc: ${command.peerId} is not paired on ${command.channelId}.`,
      );
      return 1;
    }
  }
}
