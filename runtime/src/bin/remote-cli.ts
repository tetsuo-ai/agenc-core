// Inert remote command front door. Disabled operation never imports the connector.
import { existsSync } from "node:fs";
import { loadCanonicalDaemonConfig } from "../config/repository.js";
import { pairPath, readPairFile, stopLegacyRemote, type RemoteCliRuntimeContext } from "./remote-state.js";
export { captureRemoteCliRuntimeContext, type RemoteCliRuntimeContext } from "./remote-state.js";
export { LEGACY_HOST_PROTOCOL, legacyBridgeDeniesMethod, legacyHostHandshake } from "./remote-protocol.js";
export type { RemoteOnStarted } from "./remote-connector.js";

export const REMOTE_CONTROL_DISABLED = "Phone remote control is disabled. Set [remote_control] enabled = true in your home config.toml to enable it (managed policy takes precedence).";
export const REMOTE_CONTROL_ENV_IGNORED = "Warning: AGENC_REMOTE_FULL_CONTROL is ignored while remote_control.enabled is false.";

function disabledMessage(context: RemoteCliRuntimeContext): string {
  return REMOTE_CONTROL_DISABLED + (context.environment.AGENC_REMOTE_FULL_CONTROL !== undefined ? ` ${REMOTE_CONTROL_ENV_IGNORED}` : "");
}

async function ownerEnabled(context: RemoteCliRuntimeContext): Promise<boolean> {
  try {
    const loaded = await loadCanonicalDaemonConfig({ home: context.home, env: context.environment });
    return loaded.config.remote_control?.enabled === true;
  } catch {
    // Unreadable/malformed owner authority never admits a network feature.
    return false;
  }
}

export interface RemoteCliCommand {
  readonly kind: "on" | "off" | "status" | "help";
  /** `agenc remote on --full-control`: the operator accepted what a paired phone can do. */
  readonly fullControl?: boolean;
}

/** Per-run full-control consent, subordinate to the owner capability switch. */
export const REMOTE_FULL_CONTROL_FLAG = "--full-control";
export const REMOTE_FULL_CONTROL_ENV = "AGENC_REMOTE_FULL_CONTROL";

export function parseAgenCRemoteCliArgs(argv: readonly string[]): RemoteCliCommand | null {
  if (argv[0] !== "remote") return null;
  const sub = argv[1];
  const rest = argv.slice(2);
  // Require an explicit subcommand so a bare `agenc remote` or `--help` never starts pairing.
  if (sub === "on") {
    const fullControl = rest.includes(REMOTE_FULL_CONTROL_FLAG);
    // Anything else after `on` is a mistake, not a request to pair.
    if (rest.some((arg) => arg !== REMOTE_FULL_CONTROL_FLAG)) return { kind: "help" };
    return { kind: "on", fullControl };
  }
  if (sub === "off") return { kind: "off" };
  if (sub === "status") return { kind: "status" };
  return { kind: "help" };
}

/** `/remote [on|off|status] [--full-control]` as typed in the TUI. */
export function parseRemoteSlashArgs(argsRaw: string): { readonly sub: string; readonly fullControl: boolean } {
  const tokens = (argsRaw || "").trim().split(/\s+/u).filter(Boolean);
  const fullControl = tokens.includes(REMOTE_FULL_CONTROL_FLAG);
  const args = tokens.filter((token) => token !== REMOTE_FULL_CONTROL_FLAG);
  const sub = args[0] ?? "on";
  if (args.length > 1 || !["on", "off", "status"].includes(sub) ||
      (fullControl && sub !== "on")) {
    return { sub: "help", fullControl: false };
  }
  return { sub, fullControl };
}

/**
 * Per-run consent after owner admission. Neither input can enable the owner
 * capability; the command front door checks home/managed policy first.
 */
export function remoteFullControlEnabled(context: RemoteCliRuntimeContext, flag: boolean | undefined): boolean {
  if (flag === true) return true;
  const raw = context.environment[REMOTE_FULL_CONTROL_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** One line the operator reads before the code: what enabling this means. */
export const REMOTE_FULL_CONTROL_WARNING =
  "Warning: a paired phone gets full control of this computer's AgenC.";

export function remoteFullControlRefusal(surface: "cli" | "tui"): string {
  const how = surface === "cli"
    ? `Turn it on for this run with \`agenc remote on ${REMOTE_FULL_CONTROL_FLAG}\`, or set ${REMOTE_FULL_CONTROL_ENV}=1 to keep it on.`
    : `Turn it on with \`/remote on ${REMOTE_FULL_CONTROL_FLAG}\`, or set ${REMOTE_FULL_CONTROL_ENV}=1 before starting agenc to keep it on.`;
  return [
    "Phone remote control is off.",
    "A paired phone gets full control of this computer's AgenC: it can start agents in any folder, run tools and change permission modes.",
    how,
  ].join("\n");
}

export function formatAgenCRemoteCliHelpText(): string {
  return [
    "agenc remote: control this computer from the AgenC phone app, from anywhere.",
    "",
    "Owner configuration: [remote_control] enabled = true in home config.toml (default false).",
    "Managed policy takes precedence; flags and environment cannot enable this capability.",
    "",
    "Usage:",
    "  agenc remote on --full-control",
    "                         Pair (first run shows a code) then keep this computer reachable.",
    "                         A paired phone gets full control of this computer's AgenC,",
    "                         so the flag or AGENC_REMOTE_FULL_CONTROL=1 is required.",
    "  agenc remote status    Show whether this computer is linked to a phone.",
    "  agenc remote off       Forget this computer's pairing locally.",
    "",
    "Environment:",
    "  AGENC_REMOTE_FULL_CONTROL=1",
    "                      Keep phone remote control on without the flag.",
    "  AGENC_BACKEND_URL   Identity backend (default https://id.agenc.ag).",
    "  AGENC_DAEMON_URL    Local daemon (default: the URL the running daemon",
    "                      recorded, else ws://127.0.0.1:7766).",
  ].join("\n");
}


export async function runAgenCRemoteCli(command: RemoteCliCommand, context: RemoteCliRuntimeContext): Promise<number> {
  if (command.kind === "help") {
    process.stdout.write(formatAgenCRemoteCliHelpText() + "\n");
    return 0;
  }
  if (command.kind === "status" || command.kind === "off") {
    process.stdout.write(localRemoteCommand(command.kind, context, "cli") + "\n");
    return 0;
  }
  if (!await ownerEnabled(context)) {
    process.stderr.write(disabledMessage(context) + "\n");
    return 1;
  }
  return (await import("./remote-connector.js")).runAgenCRemoteCli(command, context);
}

function localRemoteCommand(sub: "status" | "off", context: RemoteCliRuntimeContext, surface: "cli" | "tui"): string {
  if (sub === "status") {
    const pair = readPairFile(context);
    return pair ? `Linked to “${pair.machineName}” (pairing ${pair.pairingId}).\nBackend ${pair.backendUrl} · relay ${pair.relayUrl}`
      : `Not linked. Run \`${surface === "cli" ? "agenc remote" : "/remote"} on\` to link a phone.`;
  }
  const linked = existsSync(pairPath(context));
  stopLegacyRemote(context);
  return linked ? "Remote access stopped and the local pairing was removed." : "This computer is not linked.";
}

export async function runRemoteSlash(argsRaw: string, context: RemoteCliRuntimeContext): Promise<string> {
  const { sub, fullControl } = parseRemoteSlashArgs(argsRaw);
  if (sub === "status" || sub === "off") return localRemoteCommand(sub, context, "tui");
  if (sub !== "on") return "Usage: /remote [on|off|status] [--full-control]";
  const started = await startRemoteOn(context, { fullControl });
  if ("message" in started) return started.message;
  return `${started.box}\n  This computer is now reachable for this session. Pair, then talk to this agent from your phone.`;
}

export async function startRemoteOn(context: RemoteCliRuntimeContext, options: { readonly fullControl?: boolean } = {}): Promise<import("./remote-connector.js").RemoteOnStarted | { message: string }> {
  if (!await ownerEnabled(context)) return { message: disabledMessage(context) };
  return (await import("./remote-connector.js")).startRemoteOn(context, options);
}
