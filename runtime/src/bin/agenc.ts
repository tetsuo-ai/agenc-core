#!/usr/bin/env node
/**
 * `agenc` CLI entry point - daemon-backed dispatcher.
 *
 * Reads startup input from argv or stdin, checks workspace trust, starts or
 * attaches daemon-owned agents, and mounts the Ink TUI against daemon sessions.
 * Runtime provider/session construction now lives behind the daemon.
 *
 * Usage:
 *   agenc "help me understand this repo"
 *   echo "..." | agenc
 *
 * Env:
 *   XAI_API_KEY        required — xAI API key (also accepts GROK_API_KEY)
 *   AGENC_MODEL        optional — model override (default: grok-4.3)
 *   AGENC_WORKSPACE    optional — project root (default: process.cwd())
 *   AGENC_HOME         optional — state dir (default: $HOME/.agenc)
 *
 * Invariants wired here:
 *   I-45 (SIGTERM orderly shutdown, exit 0)
 *   I-46 (SIGHUP treated as stdin-lost terminal)
 *   I-47 (SIGUSR1 config reload request, SIGUSR2 state dump request)
 *   I-52 (AGENC_HOME / $HOME/.agenc writable precheck)
 */

import { mkdirSync } from "node:fs";
import { cwd as processCwd } from "node:process";
import { VERSION } from "../index.js";
import { applyBestEffortPreMainProcessHardening } from "../sandbox/hardening/index.js";
import {
  classifyCLI,
  extractFlagValues,
  isStartupValueFlagToken,
  routeCLI,
  stripRoutingFlags,
  type BootTUIArgs,
  type ContinueTUIArgs,
  type ResumeTUIArgs,
} from "./route.js";
import type {
  LLMContentPart,
  LLMMessage,
} from "../llm/types.js";
import {
  normalizeUserImageInput,
  userImageInputsToContentParts,
} from "../prompts/attachments/user-image-input.js";
import type { PhaseEvent } from "../phases/events.js";
import { Session } from "../session/session.js";
import {
  AUTONOMOUS_SUBMIT_SOURCE,
  AutonomousKeepaliveScheduler,
  isAutonomousModeEnabled,
  type SessionSubmitOptions,
} from "../session/autonomous-mode.js";
import type { TurnContext } from "../session/turn-context.js";
import { runTurn } from "../session/run-turn.js";
import { seedFileMentionSessionReads } from "../session/file-mention-session-reads.js";
import type { Terminal } from "../session/turn-state.js";
import {
  SchemaMismatchError,
  SessionLockedError,
} from "../session/session-store.js";
import { runSlashCommand } from "./slash.js";
import type { SlashCommandAppStateBridge } from "../commands/types.js";
import { ConfigStore } from "../config/store.js";
import { resolveAgencHome, resolveWorkspace as resolveWorkspaceFromEnv } from "../config/env.js";
import type { AgenCConfig } from "../config/schema.js";
import {
  loadTieredInstructions,
  assembleTieredInstructions,
  formatTieredInstructionWarnings,
} from "../prompts/agenc-md.js";
import {
  expandFileMentions,
  extractMentionAllowedRoots,
  formatFileMentionRejection,
  type FileMentionExpansion,
} from "../prompts/file-mentions.js";
import {
  assembleSystemPrompt,
  buildAssembleSystemPromptOpts,
  type McpServerInstructionsInput,
} from "../prompts/system-prompt.js";
import { getOutputStyleConfig } from "../constants/outputStyles.js";
import { renderHookAdditionalContextSection } from "../prompts/hook-context-framing.js";
import { loadSessionMcpServerInstructions } from "../prompts/mcp-server-instructions.js";
import { clearSystemPromptSections } from "../prompts/sections.js";
import { enableConfigs } from "../config/init.js";
import {
  resolveLatestSessionId,
  resolveResumeSessionId,
} from "./resume-session.js";
import {
  formatAgenCDaemonCliHelpText,
  parseAgenCDaemonCliArgs,
  runAgenCDaemonCli,
} from "../app-server/daemon-cli.js";
import {
  formatAgenCRemoteCliHelpText,
  parseAgenCRemoteCliArgs,
  runAgenCRemoteCli,
} from "./remote-cli.js";
import {
  createConnectedAgenCJsonLineDaemonTuiClient,
  defaultEnsureDaemonReady,
  formatAgenCAgentCliHelpText,
  parseAgenCAgentCliArgs,
  resolveAgenCAgentAttachCwd,
  runAgenCAgentCli,
} from "../app-server/agent-cli.js";
import {
  createAgenCDaemonOnlyTuiContext,
  findAgenCDaemonAgentBySessionId,
  listAgenCDaemonAgents,
  startAgenCDaemonPromptAgent,
  stopAgenCDaemonPromptAgent,
} from "../app-server-client/index.js";
import {
  emitLocalTuiEvent,
  emitLocalTuiPhaseEvent,
  emitLocalTuiSlashResult,
} from "./tui-local-events.js";
import type {
  AgentCreateParams,
  AgentStopParams,
  JsonObject,
  MessageContentBlock,
} from "../app-server/protocol/index.js";
import {
  ensureAgenCDaemonAutostart,
  resolveAgenCDaemonAutostartEnabled,
} from "../app-server/daemon-autostart.js";
import {
  formatAgenCAuthCliHelpText,
  parseAgenCAuthCliArgs,
  runAgenCAuthCli,
} from "./auth-cli.js";
import {
  formatAgenCMcpCliHelpText,
  parseAgenCMcpCliArgs,
  runAgenCMcpCli,
} from "./mcp-cli.js";
import {
  formatAgenCDoctorCliHelpText,
  parseAgenCDoctorCliArgs,
  runAgenCDoctorCli,
} from "./doctor-cli.js";
import {
  formatAgenCOnboardCliHelpText,
  parseAgenCOnboardCliArgs,
  readOnboardDaemonStatus,
  runAgenCOnboardCli,
} from "./onboard-cli.js";
import {
  buildSecurityAuditReport,
  formatAgenCSecurityCliHelpText,
  formatSecurityAuditSummaryLine,
  parseAgenCSecurityCliArgs,
  runAgenCSecurityCli,
} from "./security-cli.js";
import {
  formatAgenCGatewayCliHelpText,
  parseAgenCGatewayCliArgs,
  runAgenCGatewayCli,
} from "./gateway-cli.js";
import {
  formatAgenCBudgetCliHelpText,
  parseAgenCBudgetCliArgs,
  runAgenCBudgetCli,
} from "./budget-cli.js";
import {
  formatAgenCInitCliHelpText,
  parseAgenCInitCliArgs,
  runAgenCInitCli,
} from "./init-cli.js";
import {
  formatAgenCProvidersCliHelpText,
  parseAgenCProvidersCliArgs,
  runAgenCProvidersCli,
} from "./providers-cli.js";
import {
  formatAgenCConfigCliHelpText,
  parseAgenCConfigCliArgs,
  runAgenCConfigCli,
} from "./config-cli.js";
import {
  formatAgenCPluginCliHelpText,
  parseAgenCPluginCliArgs,
  runAgenCPluginCli,
} from "../plugins/cli/pluginCliCommands.js";
import {
  formatAgenCPermissionsCliHelpText,
  parseAgenCPermissionsCliArgs,
  runAgenCPermissionsCli,
} from "../permissions/permission-cli.js";
import { USER_ADDRESSABLE_PERMISSION_MODES } from "../permissions/types.js";
import {
  formatAgenCStateCliHelpText,
  parseAgenCStateCliArgs,
  runAgenCStateCli,
} from "./state-cli.js";
import {
  formatAgenCTrajectoriesCliHelpText,
  parseAgenCTrajectoriesCliArgs,
  runAgenCTrajectoriesCli,
} from "./trajectories-cli.js";
import {
  executeUserPromptSubmitHooks,
  getUserPromptSubmitHookBlockingMessage,
} from "../hooks/user-prompt-submit.js";
import {
  ConfiguredHooksRuntime,
  type HookInstallTarget,
} from "../hooks/configured-hooks.js";
import {
  readStartupCliFlags,
  resolveStartupSelection,
} from "./startup-selection.js";
import {
  isProjectTrustedSync,
  resolveProjectTrustRootSync,
  trustProject,
} from "../permissions/trust/project-trust.js";
import {
  formatProjectTrustSources,
  summarizeProjectTrustSources,
} from "../permissions/trust/trust-sources.js";
import { runStartupConfigMigrations } from "../state/migrations/config-migrations.js";
import { setSessionTrustAccepted } from "../bootstrap/state.js";
import { installGlobalErrorNet } from "../utils/gracefulShutdown.js";
import { isRecord } from "../utils/record.js";

type AgenCDaemonCliDeps = {
  readonly startPromptAgent: typeof startAgenCDaemonPromptAgent;
  readonly stopPromptAgent: typeof stopAgenCDaemonPromptAgent;
  readonly createConnectedTuiClient: typeof createConnectedAgenCJsonLineDaemonTuiClient;
  readonly findAgentBySessionId: typeof findAgenCDaemonAgentBySessionId;
  readonly createTuiContext: typeof createAgenCDaemonOnlyTuiContext;
  readonly ensureDaemonReady: typeof defaultEnsureDaemonReady;
  /**
   * Relaunch into a prior session after the live TUI exits. Defaults to
   * `resumeTUIEntry`; injectable so the `/resume` relaunch wiring can be
   * contract-tested without spinning a real daemon attach.
   */
  readonly resumeTui: (args: ResumeTUIArgs) => Promise<number>;
};

const DEFAULT_DAEMON_CLI_DEPS: AgenCDaemonCliDeps = {
  startPromptAgent: startAgenCDaemonPromptAgent,
  stopPromptAgent: stopAgenCDaemonPromptAgent,
  createConnectedTuiClient: createConnectedAgenCJsonLineDaemonTuiClient,
  findAgentBySessionId: findAgenCDaemonAgentBySessionId,
  createTuiContext: createAgenCDaemonOnlyTuiContext,
  ensureDaemonReady: defaultEnsureDaemonReady,
  resumeTui: (args: ResumeTUIArgs) => resumeTUIEntry(args),
};

let daemonCliDepsForTest: Partial<AgenCDaemonCliDeps> | null = null;

function daemonCliDeps(): AgenCDaemonCliDeps {
  return {
    ...DEFAULT_DAEMON_CLI_DEPS,
    ...(daemonCliDepsForTest ?? {}),
  };
}

/** Test-only helper for daemon-backed CLI entry tests. */
export function __setDaemonCliDepsForTest(
  deps: Partial<AgenCDaemonCliDeps> | null,
): void {
  daemonCliDepsForTest = deps;
}

export {
  PROVIDER_MODEL_CATALOG,
  resolveModelOrThrow,
  sessionConfigurationFromAgenCConfig,
} from "./bootstrap.js";

/**
 * Detect whether one of the boolean short-circuit flags (`--help`, `-h`,
 * `--version`) appears as a REAL leading flag rather than as prompt text.
 *
 * A token only counts when it sits in the leading option region: before the
 * first positional/prompt token and before an end-of-options `--`. We walk
 * argv left-to-right, skipping the value consumed by a startup value flag
 * (e.g. the `gpt` in `--model gpt`) so it is not mistaken for a positional.
 * The first bare token that is neither a flag, a `--flag` option, nor a
 * value consumed by a preceding value flag ends the option region; anything
 * at or after it (including `--`) is prompt content and never short-circuits.
 *
 * This mirrors the `--image`/value-flag exemption already used elsewhere so
 * free-form prompts like `agenc what does --version mean` or
 * `agenc explain the --help flag` run the agent instead of printing help.
 */
function leadingFlagBeforePrompt(
  argv: readonly string[],
  targets: readonly string[],
): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // Literal `--` ends the option region: everything after is prompt.
    if (arg === "--") return false;
    if (targets.includes(arg)) return true;
    if (isStartupValueFlagToken(arg)) {
      // `--flag value` form consumes the next token as its value, so that
      // value is not a positional that would end the option region.
      const next = argv[i + 1];
      if (typeof next === "string" && !next.startsWith("-")) i += 1;
      continue;
    }
    // Any other option-looking token (`-x`, `--foo`, `--foo=bar`) stays in
    // the option region; the first bare positional ends it.
    if (arg.startsWith("-")) continue;
    return false;
  }
  return false;
}

export function formatCliHelpText(): string {
  return [
    "Usage: agenc [options] [PROMPT]",
    "       agenc -p|--print [options] [PROMPT]",
    "       agenc help [command]",
    "       agenc onboard [--status [--json] | --reset]",
    "       agenc security audit [--json] [--fix]",
    "       agenc gateway <status|pairing> [args]",
    "       agenc budget <status|reset> [args]",
    "       agenc init [--force]",
    "       agenc <login|logout|whoami>",
    "       agenc providers [--json] [--no-local-check]",
    "       agenc config <command> [args]",
    "       agenc plugin <command> [options]",
    "       agenc permissions <command>",
    "       agenc state export <agent-id>",
    "       agenc state import",
    "       agenc trajectories export [--format sft|dpo] [--dir <path>] [--out <file>]",
    "       agenc daemon start [--foreground]",
    "       agenc daemon <stop|status|reload|restart>",
    "       agenc agent start <objective>",
    "       agenc agent list",
    "       agenc agent attach <id>",
    "       agenc agent stop <id>",
    "       agenc agent logs <id>",
    "       agenc mcp <serve|add|list|get|remove|add-json|add-from-agenc-desktop|reset-project-choices|doctor|xaa>",
    "",
    "Commands:",
    "  onboard                                 Set up AgenC: provider, key, theme, first chat",
    "  security                                Audit local exposure; --fix applies safe fixes",
    "  gateway                                 Inspect/operate the channel gateway (pairing)",
    "  budget                                  Inspect/operate cost-bounded autonomy",
    "  init                                    Create .agenc/config.json and AGENC.md",
    "  login | logout | whoami                  Manage the configured auth session",
    "  providers                               Check provider readiness and local health",
    "  config                                  Show, mutate, validate, or edit config.toml",
    "  plugin                                  Manage local plugins and marketplaces",
    "  permissions                             List/update rules or resolve live requests",
    "  state                                   Export or import project state",
    "  trajectories                            Curate exported trajectories into training JSONL",
    "  daemon                                  Manage the local AgenC daemon",
    "  agent                                   Start, attach, inspect, or stop background agents",
    "  mcp                                     Manage MCP servers or serve AgenC tools over MCP",
    "  help [command]                          Show top-level or command help",
    "",
    "Options:",
    "  -h, --help                              Show this help text",
    `  --version                                Show version (${VERSION})`,
    "  -p, --print                             Run in headless one-shot print mode",
    "  --output-format <format>                 Print mode output: text, json, or stream-json",
    "  --input-format <format>                  Print mode input: stream-json",
    "  --no-tui                                 Force one-shot CLI mode",
    "  -c, --continue                           Continue the latest project session",
    "  -r, --resume <session-id>                Resume a prior project session in the TUI",
    "  --profile <name>                         Use a named config profile",
    "  --provider <name>                        Override provider for this session",
    "  --model <id|provider:id>                 Override model for this session",
    "  --permission-mode <mode>                 Override the startup permission mode",
    "  --autonomous, --proactive                Enable autonomous tick mode",
    "  --dangerously-bypass-approvals-and-sandbox",
    "                                           Bypass approvals and sandbox checks",
    "  --yolo                                   Alias for approval/sandbox bypass",
    "  --allow-dangerously-skip-permissions     Skip approval prompts",
    "  --image <file|url|data-url>              Attach a startup image",
    "",
    "Examples:",
    "  agenc",
    "  agenc init",
    "  agenc \"summarize this repository\"",
    "  agenc --no-tui \"run the tests and report failures\"",
    "  agenc --resume <session-id>",
    "  agenc agent start \"fix the failing parser test\"",
    "  agenc config validate",
    "  agenc mcp serve --transport stdio",
    "  agenc mcp list",
    "  agenc help permissions",
  ].join("\n");
}

function normalizeCliHelpTopic(topic: string): string {
  return topic.trim().toLowerCase();
}

export function formatCliHelpTopicText(topic: string): string | null {
  switch (normalizeCliHelpTopic(topic)) {
    case "":
      return formatCliHelpText();
    case "agent":
      return formatAgenCAgentCliHelpText();
    case "help":
      return formatCliHelpText();
    case "init":
      return formatAgenCInitCliHelpText();
    case "auth":
    case "login":
    case "logout":
    case "whoami":
      return formatAgenCAuthCliHelpText();
    case "daemon":
      return formatAgenCDaemonCliHelpText();
    case "remote":
      return formatAgenCRemoteCliHelpText();
    case "mcp":
      return formatAgenCMcpCliHelpText();
    case "doctor":
      return formatAgenCDoctorCliHelpText();
    case "onboard":
      return formatAgenCOnboardCliHelpText();
    case "security":
      return formatAgenCSecurityCliHelpText();
    case "gateway":
      return formatAgenCGatewayCliHelpText();
    case "budget":
      return formatAgenCBudgetCliHelpText();
    case "permissions":
      return formatAgenCPermissionsCliHelpText();
    case "plugin":
    case "plugins":
      return formatAgenCPluginCliHelpText();
    case "providers":
      return formatAgenCProvidersCliHelpText();
    case "config":
      return formatAgenCConfigCliHelpText();
    case "state":
      return formatAgenCStateCliHelpText();
    case "trajectories":
      return formatAgenCTrajectoriesCliHelpText();
    default:
      return null;
  }
}

type StartupShortCircuit =
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "version"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export function detectStartupShortCircuit(
  argv: readonly string[],
): StartupShortCircuit | null {
  if (argv[0] === "help") {
    if (argv.length > 2) {
      return {
        kind: "error",
        message: "help accepts at most one command topic",
      };
    }
    const topic = argv[1] ?? "";
    if (topic === "--help" || topic === "-h") {
      return { kind: "help", text: formatCliHelpText() };
    }
    const text = formatCliHelpTopicText(topic);
    if (text === null) {
      return {
        kind: "error",
        message: `unknown help topic: ${topic}\nRun 'agenc help' to see available topics.`,
      };
    }
    return { kind: "help", text };
  }
  if (leadingFlagBeforePrompt(argv, ["--help", "-h"])) {
    return { kind: "help", text: formatCliHelpText() };
  }
  if (leadingFlagBeforePrompt(argv, ["--version"])) {
    return { kind: "version", text: `agenc ${VERSION}` };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Argv / stdin / env resolution
// ─────────────────────────────────────────────────────────────────────

async function readStdin(signal: AbortSignal): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    if (signal.aborted) break;
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  if (signal.aborted) {
    throw new InitAbortedError("stdin read aborted");
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

type OneShotOutputFormat = "text" | "json" | "stream-json";
type OneShotInputFormat = "stream-json";

function firstFlagValue(
  argv: readonly string[],
  flag: string,
): string | undefined {
  return extractFlagValues(argv, flag)[0];
}

function readOneShotOutputFormat(
  argv: readonly string[] = process.argv.slice(2),
): OneShotOutputFormat {
  const raw = firstFlagValue(argv, "--output-format");
  if (raw === undefined || raw === "text") return "text";
  if (raw === "json" || raw === "stream-json") return raw;
  throw new Error(
    `unknown output format '${raw}'. Expected one of: text, json, stream-json`,
  );
}

function readOneShotInputFormat(
  argv: readonly string[] = process.argv.slice(2),
): OneShotInputFormat | undefined {
  const raw = firstFlagValue(argv, "--input-format");
  if (raw === undefined) return undefined;
  if (raw === "stream-json") return raw;
  throw new Error(
    `unknown input format '${raw}'. Expected one of: stream-json`,
  );
}

function contentTextFromStreamJsonValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const part of value) {
    if (
      isRecord(part) &&
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      parts.push(part.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function promptTextFromStreamJsonRecord(record: unknown): string | null {
  if (typeof record === "string") return record;
  if (!isRecord(record)) return null;
  if (record.type === "prompt" && typeof record.prompt === "string") {
    return record.prompt;
  }
  if (record.type === "input_text" && typeof record.text === "string") {
    return record.text;
  }
  if (
    record.type === "message" &&
    (record.role === undefined || record.role === "user")
  ) {
    return contentTextFromStreamJsonValue(record.content);
  }
  if (record.role === "user") {
    return (
      contentTextFromStreamJsonValue(record.content) ??
      (typeof record.text === "string" ? record.text : null) ??
      (typeof record.message === "string" ? record.message : null)
    );
  }
  return null;
}

export function parseStreamJsonPrompt(input: string): string {
  const messages: string[] = [];
  const lines = input.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `invalid stream-json input on line ${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const text = promptTextFromStreamJsonRecord(parsed);
    if (text !== null && text.length > 0) {
      messages.push(text);
    }
  }
  if (messages.length === 0) {
    throw new Error(
      "stream-json input did not contain a prompt or user message",
    );
  }
  return messages.join("\n\n");
}

async function resolveUserMessage(signal: AbortSignal): Promise<string> {
  // Strip routing-level flags (--no-tui, --resume) before treating the
  // residue as the prompt; T12 routing peels these off upstream but
  // Non-router entry paths still call `resolveUserMessage` directly.
  const userArgv = process.argv.slice(2);
  const argv = stripRoutingFlags(userArgv);
  if (argv.length > 0) {
    return argv.join(" ").trim();
  }
  const piped = await readStdin(signal);
  if (piped) {
    return readOneShotInputFormat(userArgv) === "stream-json"
      ? parseStreamJsonPrompt(piped)
      : piped;
  }
  if (extractFlagValues(userArgv, "--image").length > 0) return "";
  throw new Error(
    "no prompt provided — pass as argv (`agenc ...`) or pipe via stdin",
  );
}

function startupImageMessagesFromInputs(
  imageInputs: readonly string[],
  cwd: string,
  home?: string,
): LLMMessage[] {
  if (imageInputs.length === 0) return [];
  const images = imageInputs.map((input) => {
    const image = normalizeUserImageInput(input, cwd, home);
    if (image === null) {
      throw new Error(`unable to read startup image: ${input}`);
    }
    return image;
  });
  return [
    {
      role: "user",
      content: userImageInputsToContentParts(images),
    },
  ];
}

function startupContentFromInputs(
  prompt: string,
  imageInputs: readonly string[],
  cwd: string,
  home?: string,
): readonly MessageContentBlock[] | undefined {
  const imageMessages = startupImageMessagesFromInputs(imageInputs, cwd, home);
  const imageParts = imageMessages.flatMap((message) => {
    if (!Array.isArray(message.content)) return [];
    return message.content.flatMap((part) => {
      if (part.type !== "image_url") return [];
      return [{ type: "image_url" as const, image_url: part.image_url }];
    });
  });
  if (imageParts.length === 0) return undefined;
  const text = prompt.trim();
  return [
    ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
    ...imageParts,
  ];
}

// ─────────────────────────────────────────────────────────────────────
// I-51: Init step abort propagates cleanly.
// ─────────────────────────────────────────────────────────────────────

/**
 * Thrown when an init step observes its AbortSignal. The top-level
 * IIFE recognises this error type + exits with code 130 (SIGINT
 * conventional) after running reverse-cleanup. Mirrors I-51 rule
 * "emit error:'init_aborted'".
 */
class InitAbortedError extends Error {
  constructor(message: string) {
    super(`init_aborted: ${message}`);
    this.name = "InitAbortedError";
  }
}

/**
 * Wire pre-session signal handlers to the init-stage AbortController.
 * Ctrl+C / SIGTERM / SIGHUP during init propagates to every async
 * init step, which in turn throws InitAbortedError; the top-level
 * catcher runs reverse-cleanup before exit.
 */
export function installInitSignalHandlers(
  initAbort: AbortController,
  proc: Pick<NodeJS.Process, "once" | "removeListener"> = process,
): () => void {
  const onSigInt = () => initAbort.abort("SIGINT during init");
  const onSigTerm = () => initAbort.abort("SIGTERM during init");
  const onSigHup = () => initAbort.abort("SIGHUP during init");
  proc.once("SIGINT", onSigInt);
  proc.once("SIGTERM", onSigTerm);
  proc.once("SIGHUP", onSigHup);
  return () => {
    proc.removeListener("SIGINT", onSigInt);
    proc.removeListener("SIGTERM", onSigTerm);
    proc.removeListener("SIGHUP", onSigHup);
  };
}

// ─────────────────────────────────────────────────────────────────────
// I-52: validate AGENC_HOME / $HOME/.agenc writable before anything else.
// ─────────────────────────────────────────────────────────────────────

export function validateAgencHome(
  env: NodeJS.ProcessEnv = process.env,
  mkdir: typeof mkdirSync = mkdirSync,
): string {
  const explicit = env.AGENC_HOME;
  const home =
    explicit && explicit.length > 0
      ? explicit
      : env.HOME && env.HOME.length > 0
        ? `${env.HOME}/.agenc`
        : "";
  if (!home) {
    throw new Error(
      "HOME unset and AGENC_HOME unset — set AGENC_HOME to a writable dir",
    );
  }
  try {
    mkdir(home, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EROFS" || code === "EACCES") {
      throw new Error(
        `AGENC_HOME (${home}) is not writable (${code}) — set AGENC_HOME to a writable dir`,
      );
    }
    throw error;
  }
  return home;
}

export function envForAttachBootstrap(
  env: NodeJS.ProcessEnv,
  workspace: string,
): NodeJS.ProcessEnv {
  return {
    ...env,
    AGENC_WORKSPACE: workspace,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Signal handlers (I-45 / I-46 / I-47)
// ─────────────────────────────────────────────────────────────────────

/**
 * Mutable latch SIGUSR1 flips when the operator requests a config
 * reload. I-47: the handler never reloads mid-turn; the between-turn
 * check in `maybeReloadConfigBetweenTurns` drains the latch before
 * the next `runTurn`.
 */
export interface ConfigReloadLatch {
  requested: boolean;
}

export function installSignalHandlers(
  getSession: () => Session | null,
  configReloadLatch: ConfigReloadLatch,
  proc: Pick<NodeJS.Process, "once" | "on"> = process,
): void {
  // Wave 5-B: tear the Ink tree down before we abort the session so a
  // lingering renderer can't paint into a terminal that's about to be
  // reset by `signal-exit`. No-op when no TUI is active.
  const unmountActiveInk = (): void => {
    try {
      activeInkUnmount?.();
    } catch {
      // Ink may have torn itself down already.
    }
  };
  // I-45: SIGTERM — orderly shutdown, exit 0.
  proc.once("SIGTERM", () => {
    unmountActiveInk();
    getSession()?.abortTerminal("signal_received");
  });
  // I-46: SIGHUP — same path as stdin loss (T12 wires the stdin handler).
  proc.once("SIGHUP", () => {
    unmountActiveInk();
    getSession()?.abortTerminal("stdin_lost");
  });
  // I-47: SIGUSR1 — config reload requested (takes effect next turn per I-30).
  //       SIGUSR2 — state dump to ~/.agenc/diag-<pid>-<ts>.json (T-future).
  proc.on("SIGUSR1", () => {
    // T10 Group I: latch only. The between-turn drain runs the real
    // ConfigStore.reload() + clearSystemPromptSections() + emits a
    // warning event once the current turn (if any) completes.
    configReloadLatch.requested = true;
    getSession()?.emit({
      id: "startup",
      msg: {
        type: "warning",
        payload: {
          cause: "config_reload_requested",
          message: "config reload will take effect at next turn (I-30)",
        },
      },
    });
  });
  proc.on("SIGUSR2", () => {
    // T-future: dump session state. Logged as a warning so we can audit.
    getSession()?.emit({
      id: "startup",
      msg: {
        type: "warning",
        payload: {
          cause: "state_dump_requested",
          message: "state dump requested (T-future)",
        },
      },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// T10 Group I — I-47 between-turn config reload
// ─────────────────────────────────────────────────────────────────────

/**
 * Drain the SIGUSR1 latch if set. Reloads the ConfigStore, wipes the
 * system-prompt section cache so a stale static head can't leak into
 * the next turn, and emits a session warning documenting the change.
 *
 * MUST be called between turns, never mid-turn. I-47 + I-30.
 *
 * Returns `{ reloaded, previous, next }` so callers/tests can inspect
 * the transition.
 */
export async function maybeReloadConfigBetweenTurns(params: {
  readonly latch: ConfigReloadLatch;
  readonly store: ConfigStore;
  readonly session: Session | null;
  readonly clearCache?: () => void;
}): Promise<
  | { readonly reloaded: false }
  | {
      readonly reloaded: true;
      readonly previous: AgenCConfig;
      readonly next: AgenCConfig;
    }
> {
  if (!params.latch.requested) return { reloaded: false };
  const previous = params.store.current();
  const next = await params.store.reload();
  params.latch.requested = false;
  // Wipe the prompt-section cache so the refresh picks up any new
  // static-head inputs (env info, model, MCP, etc.) on the next turn.
  (params.clearCache ?? clearSystemPromptSections)();
  let mcpRefreshSuffix = "";
  const refreshMcp = (
    params.session?.services as
      | { mcpManager?: Session["services"]["mcpManager"] }
      | undefined
  )?.mcpManager?.refreshFromConfig;
  if (params.session && typeof refreshMcp === "function") {
    try {
      const result = await refreshMcp.call(
        params.session.services.mcpManager,
        next,
      );
      mcpRefreshSuffix = `; MCP refreshed (${result.configuredServers.length} configured, ${result.requiredServers.length} required)`;
    } catch (error) {
      params.session.emit({
        id: params.session.nextInternalSubId(),
        msg: {
          type: "error",
          payload: {
            cause: "mcp_config_refresh_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      });
      throw error;
    }
  }
  params.session?.emit({
    id: params.session.nextInternalSubId(),
    msg: {
      type: "warning",
      payload: {
        cause: "config_reloaded",
        message: `config reloaded (model: ${previous.model ?? "default"} → ${next.model ?? "default"})${mcpRefreshSuffix}`,
      },
    },
  });
  return { reloaded: true, previous, next };
}

// ─────────────────────────────────────────────────────────────────────
// System prompt + rendering
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// T10 Group I — runSingleTurn seam (R1: multi-turn future-proofing)
// ─────────────────────────────────────────────────────────────────────

/**
 * Inputs the single-turn helper needs per invocation. Kept narrow so a
 * future multi-turn REPL loop can call `runSingleTurn` repeatedly with
 * the same shared state and a fresh `input` each pass.
 */
export interface RunSingleTurnOpts {
  readonly session: Session;
  readonly ctx: TurnContext;
  readonly input: string | readonly LLMContentPart[];
  readonly agencHome?: string;
  /**
   * Transcript-facing prompt when `input` has model-only attachments injected.
   * `null` suppresses the visible user-message event for internal meta turns.
   */
  readonly displayInput?: string | null;
  /** T10: config snapshot + latch so `maybeReloadConfigBetweenTurns` can drain SIGUSR1. */
  readonly configStore: ConfigStore;
  readonly configReloadLatch: ConfigReloadLatch;
  /**
   * Preferred seam: load fresh prompt/memory/MCP inputs for this turn.
   * Called after between-turn reload handling so AGENTS, MEMORY, and
   * MCP instructions observe the latest snapshot on the next turn.
   */
  readonly loadTurnInputsFn?: () => Promise<PreparedTurnRuntimeInputs>;
  /** Compatibility direct inputs retained for focused unit tests. */
  readonly projectInstructions?: string;
  readonly memoryPromptText?: string;
  readonly allMemories?: readonly [];
  /** Tool registry + MCP inputs that shape the system prompt. */
  readonly enabledToolNames?: ReadonlySet<string>;
  readonly mcpServers?: readonly McpServerInstructionsInput[];
  readonly provider: string;
  /** Optional: injected for tests so we don't have to spin real runTurn. */
  readonly runTurnFn?: typeof runTurn;
  readonly reloadConfigFn?: typeof maybeReloadConfigBetweenTurns;
  readonly assembleSystemPromptFn?: typeof assembleSystemPrompt;
}

/**
 * Drive a single LLM turn through the T10 pipeline:
 *   1. drain the I-47 config-reload latch (between-turn only)
 *   2. assemble the system prompt (tiered instructions + memory tail)
 *   3. invoke `runTurn` and forward every event
 *
 * A future multi-turn REPL loop calls this repeatedly with the same
 * session + ctx and a fresh `input` each iteration. Today `main()`
 * calls it exactly once for the one-shot CLI flow.
 */
export async function* runSingleTurn(
  opts: RunSingleTurnOpts,
): AsyncGenerator<PhaseEvent, Terminal | undefined> {
  const reload = opts.reloadConfigFn ?? maybeReloadConfigBetweenTurns;
  const assemble = opts.assembleSystemPromptFn ?? assembleSystemPrompt;
  const drive = opts.runTurnFn ?? runTurn;

  // I-47: drain SIGUSR1 before we build the system prompt + send the
  // turn so any reload takes effect on this exact turn, not the one
  // after. Call is idempotent when the latch is unset.
  await reload({
    latch: opts.configReloadLatch,
    store: opts.configStore,
    session: opts.session,
  });

  const turnInputs = opts.loadTurnInputsFn
    ? await opts.loadTurnInputsFn()
    : {
        projectInstructions: opts.projectInstructions ?? "",
        memoryPromptText: opts.memoryPromptText ?? "",
        allMemories: opts.allMemories ?? [],
        enabledToolNames: opts.enabledToolNames ?? new Set<string>(),
        mcpServers: opts.mcpServers ?? [],
      };

  // Surface the active permission mode to the model. Approval-policy and
  // sandbox-mode prose is injected as a dynamic section by the assembler
  // when a context is supplied.
  let permissionContext = null as ReturnType<
    typeof opts.session.permissionModeRegistry.current
  > | null;
  try {
    permissionContext = opts.session.permissionModeRegistry.current();
  } catch {
    permissionContext = null;
  }

  // Route through the shared {@link buildAssembleSystemPromptOpts} helper
  // so the /context display (`runContextUsage`) and this production turn
  // driver always pass the same input shape to `assembleSystemPrompt`.
  // Adding a new required field here forces both sites to update at
  // compile time, preventing silent under-counts in the displayed
  // context size.
  const assembled = await assemble(
    buildAssembleSystemPromptOpts({
      session: opts.session,
      ctx: opts.ctx,
      projectInstructions: turnInputs.projectInstructions,
      memoryPrompt: turnInputs.memoryPromptText,
      mcpServers: turnInputs.mcpServers,
      enabledToolNames: turnInputs.enabledToolNames,
      outputStyle: await getOutputStyleConfig(),
      provider: opts.provider,
      permissionContext,
      autonomousMode:
        (opts.ctx.config as { readonly autonomousMode?: boolean } | undefined)
          ?.autonomousMode === true,
    }),
  );

  const iter = drive(opts.session, opts.ctx, opts.input, {
    systemPrompt: assembled.text,
    displayUserMessage: opts.displayInput,
  });
  while (true) {
    const step = await iter.next();
    if (step.done) return step.value;
    yield step.value;
  }
}

export interface PreparedTurnRuntimeInputs {
  readonly projectInstructions: string;
  readonly memoryPromptText: string;
  readonly allMemories: readonly [];
  readonly enabledToolNames: ReadonlySet<string>;
  readonly mcpServers: readonly McpServerInstructionsInput[];
}


export async function prepareTurnRuntimeInputs(params: {
  readonly session: Session;
  readonly configStore: ConfigStore;
  readonly workspaceRoot: string;
  readonly memoryDir: string;
  readonly memoryMdPath: string;
  readonly registry: { readonly tools: readonly { readonly name: string }[] };
}): Promise<PreparedTurnRuntimeInputs> {
  const currentConfig = params.configStore.current();
  const projectInstructionsResult = await loadTieredInstructions({
    cwd: params.workspaceRoot,
    ...(currentConfig.project_root_markers !== undefined
      ? { projectRootMarkers: currentConfig.project_root_markers }
      : {}),
    ...(currentConfig.project_doc_max_bytes !== undefined
      ? { projectDocMaxBytes: currentConfig.project_doc_max_bytes }
      : {}),
  });
  const assembledProjectInstructions = assembleTieredInstructions(
    projectInstructionsResult,
  );
  const projectMemoryWarnings = formatTieredInstructionWarnings(
    projectInstructionsResult,
  );
  const warningSink = params.session as unknown as {
    setProjectMemoryWarnings?: (warnings: readonly string[]) => void;
    projectMemoryWarnings?: string[];
  };
  if (typeof warningSink.setProjectMemoryWarnings === "function") {
    warningSink.setProjectMemoryWarnings(projectMemoryWarnings);
  } else {
    warningSink.projectMemoryWarnings = [...projectMemoryWarnings];
  }

  return {
    projectInstructions: assembledProjectInstructions,
    memoryPromptText: "",
    allMemories: [],
    enabledToolNames: new Set(params.registry.tools.map((tool) => tool.name)),
    mcpServers: await loadSessionMcpServerInstructions(
      params.session,
      currentConfig,
    ),
  };
}

function resolveUserHome(
  env: NodeJS.ProcessEnv = process.env,
  fallback: string = readProcessCwdSafely() ?? ".",
): string {
  return env.HOME ?? env.USERPROFILE ?? fallback;
}

export function formatUnavailableCliCwdMessage(): string {
  return "current working directory is unavailable. Open a valid directory or set AGENC_WORKSPACE.";
}

function readProcessCwdSafely(cwdFn: () => string = processCwd): string | null {
  try {
    return cwdFn();
  } catch {
    return null;
  }
}

export function resolveCliCwdForStartup(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    readonly useEnvWorkspace?: boolean;
    readonly cwdFn?: () => string;
  } = {},
):
  | { readonly ok: true; readonly cwd: string }
  | { readonly ok: false; readonly message: string } {
  if (options.useEnvWorkspace !== false) {
    const workspace = resolveWorkspaceFromEnv(env);
    if (workspace !== undefined) {
      return { ok: true, cwd: workspace };
    }
  }
  const cwd = readProcessCwdSafely(options.cwdFn);
  if (cwd === null) {
    return { ok: false, message: formatUnavailableCliCwdMessage() };
  }
  return { ok: true, cwd };
}

export function isUnavailableCliCwdError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const nodeError = error as NodeJS.ErrnoException & { readonly syscall?: string };
  return (
    nodeError.syscall === "uv_cwd" ||
    error.message.includes("uv_cwd")
  );
}

function cliStartupErrorMessage(error: unknown): string {
  if (isUnavailableCliCwdError(error)) {
    return formatUnavailableCliCwdMessage();
  }
  return error instanceof Error ? error.message : String(error);
}

function writeUnavailableCliCwd(): number {
  process.stderr.write(`agenc: ${formatUnavailableCliCwdMessage()}\n`);
  return 1;
}

function emitFileMentionWarnings(
  session: Session,
  expansion: FileMentionExpansion,
): void {
  for (const rejection of expansion.rejected) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "file_mention_attachment_dropped",
          message: formatFileMentionRejection(rejection),
          ...{
            path: rejection.raw,
            reason: rejection.reason,
          },
        },
      },
    });
  }
}

function writeFileMentionWarnings(
  stderr: Pick<NodeJS.WriteStream, "write">,
  expansion: FileMentionExpansion,
): void {
  for (const rejection of expansion.rejected) {
    stderr.write(`agenc: ${formatFileMentionRejection(rejection)}\n`);
  }
}

async function expandPromptFileMentions(params: {
  readonly session: Session;
  readonly configStore: ConfigStore;
  readonly input: string;
}): Promise<{ readonly input: string; readonly displayInput?: string }> {
  const cwd = params.session.sessionConfiguration.cwd ?? process.cwd();
  const config = params.configStore.current();
  const expansion = await expandFileMentions(params.input, {
    cwd,
    allowedRoots: extractMentionAllowedRoots(config),
  });
  emitFileMentionWarnings(params.session, expansion);
  if (expansion.attachments.length === 0) {
    return { input: params.input };
  }
  await seedFileMentionSessionReads(
    params.session.conversationId,
    expansion.attachments,
  );
  return {
    input: expansion.prompt,
    displayInput: params.input,
  };
}

async function expandOneShotPromptFileMentions(params: {
  readonly configStore: Pick<ConfigStore, "current">;
  readonly input: string;
  readonly cwd: string;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}): Promise<string> {
  const config = params.configStore.current();
  const expansion = await expandFileMentions(params.input, {
    cwd: params.cwd,
    allowedRoots: extractMentionAllowedRoots(config),
  });
  writeFileMentionWarnings(params.stderr, expansion);
  return expansion.attachments.length === 0 ? params.input : expansion.prompt;
}

function userInputDisplayText(input: string | readonly LLMContentPart[]): string {
  if (typeof input === "string") return input;
  return input
    .map((part) => {
      if (part.type === "text") return part.text;
      return "[image]";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

const MAX_USER_PROMPT_SUBMIT_CONTEXT_LENGTH = 10_000;

function truncateUserPromptSubmitContext(context: string): string {
  if (context.length <= MAX_USER_PROMPT_SUBMIT_CONTEXT_LENGTH) return context;
  return `${context.substring(0, MAX_USER_PROMPT_SUBMIT_CONTEXT_LENGTH)}… [output truncated - exceeded ${MAX_USER_PROMPT_SUBMIT_CONTEXT_LENGTH} characters]`;
}

function appendUserPromptSubmitContexts(
  input: string | readonly LLMContentPart[],
  contexts: readonly string[],
): string | readonly LLMContentPart[] {
  if (contexts.length === 0) return input;
  const contextText = formatUserPromptSubmitContexts(contexts);
  if (contextText.length === 0) return input;
  if (typeof input === "string") {
    return input.trim().length > 0 ? `${input}\n\n${contextText}` : contextText;
  }
  const next = [...input];
  const last = next[next.length - 1];
  if (last?.type === "text") {
    next[next.length - 1] = {
      ...last,
      text: `${last.text}\n\n${contextText}`,
    };
    return next;
  }
  next.push({ type: "text", text: contextText });
  return next;
}

function formatUserPromptSubmitContexts(contexts: readonly string[]): string {
  return renderHookAdditionalContextSection(
    contexts.map((context) => ({
      hookName: "UserPromptSubmit",
      hookEvent: "UserPromptSubmit",
      content: truncateUserPromptSubmitContext(context),
    })),
  ) ?? "";
}

function appendUserPromptSubmitContextsToMessage(
  message: string,
  contexts: readonly string[],
): string {
  if (contexts.length === 0) return message;
  const contextText = formatUserPromptSubmitContexts(contexts);
  return contextText.length === 0 ? message : `${message}\n\n${contextText}`;
}

function emitUserPromptSubmitHookThrown(
  session: Session,
  err: unknown,
  idx: number,
): void {
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "warning",
      payload: {
        cause: "user_prompt_submit_hook_threw",
        message: `UserPromptSubmit hook ${idx} threw: ${err instanceof Error ? err.message : String(err)}`,
      },
    },
  });
}

async function collectUserPromptSubmitHookOutcome(params: {
  readonly session: Session;
  readonly prompt: string;
}): Promise<{
  readonly blocked: boolean;
  readonly additionalContexts: readonly string[];
  readonly blockMessage?: string;
}> {
  const permissionMode = params.session.permissionModeRegistry.current().mode;
  const additionalContexts: string[] = [];
  for await (const hookResult of executeUserPromptSubmitHooks(
    params.prompt,
    permissionMode,
    {
      session: params.session,
      services: params.session.services,
      cwd: params.session.sessionConfiguration.cwd ?? process.cwd(),
      abortController: params.session.abortController,
    },
    undefined,
    (err, idx) => emitUserPromptSubmitHookThrown(params.session, err, idx),
  )) {
    if (hookResult.additionalContexts) {
      additionalContexts.push(...hookResult.additionalContexts);
    }
    if (hookResult.blockingError) {
      const message = getUserPromptSubmitHookBlockingMessage(
        hookResult.blockingError,
      );
      const messageWithContext = appendUserPromptSubmitContextsToMessage(
        message,
        additionalContexts,
      );
      params.session.emit({
        id: params.session.nextInternalSubId(),
        msg: {
          type: "error",
          payload: {
            cause: "user_prompt_submit_hook_blocked",
            message: messageWithContext,
          },
        },
      });
      return {
        blocked: true,
        additionalContexts,
        blockMessage: messageWithContext,
      };
    }
    if (hookResult.preventContinuation) {
      const message = hookResult.stopReason
        ? `Operation stopped by hook: ${hookResult.stopReason}`
        : "Operation stopped by hook";
      const messageWithContext = appendUserPromptSubmitContextsToMessage(
        message,
        additionalContexts,
      );
      params.session.emit({
        id: params.session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "user_prompt_submit_hook_stopped",
            message: messageWithContext,
          },
        },
      });
      return {
        blocked: true,
        additionalContexts,
        blockMessage: messageWithContext,
      };
    }
    const attachment = hookResult.message?.attachment;
    if (
      attachment?.type === "hook_success" &&
      typeof attachment.content === "string" &&
      attachment.content.length > 0
    ) {
      additionalContexts.push(attachment.content);
    }
  }
  return {
    blocked: false,
    additionalContexts,
  };
}

function createOneShotHookTarget(): HookInstallTarget {
  return {
    preToolUseHooks: [],
    postToolUseHooks: [],
    failureToolUseHooks: [],
    permissionDecisionHooks: [],
    userPromptSubmitHooks: [],
    stopHooks: [],
    stopFailureHooks: [],
    clearConfiguredLifecycleHooks: () => {},
  };
}

async function prepareOneShotPromptForDaemon(params: {
  readonly prompt: string;
  readonly configStore: Pick<ConfigStore, "current">;
  readonly agencHome: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}): Promise<
  | { readonly blocked: false; readonly prompt: string }
  | { readonly blocked: true; readonly blockMessage: string }
> {
  const target = createOneShotHookTarget();
  const hooksRuntime = new ConfiguredHooksRuntime({
    cwd: params.cwd,
    env: params.env,
    agencHome: params.agencHome,
    shellPath: params.env.SHELL ?? "/bin/sh",
  });
  hooksRuntime.attachTarget(target);
  hooksRuntime.load(params.configStore.current().hooks);

  const additionalContexts: string[] = [];
  for await (const hookResult of executeUserPromptSubmitHooks(
    params.prompt,
    "default",
    {
      cwd: params.cwd,
      services: { hooks: target },
      abortController: { signal: params.signal },
    },
    undefined,
    (err, idx) => {
      params.stderr.write(
        `agenc: UserPromptSubmit hook ${idx} threw: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    },
  )) {
    if (hookResult.additionalContexts) {
      additionalContexts.push(...hookResult.additionalContexts);
    }
    if (hookResult.blockingError) {
      return {
        blocked: true,
        blockMessage: appendUserPromptSubmitContextsToMessage(
          getUserPromptSubmitHookBlockingMessage(hookResult.blockingError),
          additionalContexts,
        ),
      };
    }
    if (hookResult.preventContinuation) {
      return {
        blocked: true,
        blockMessage: appendUserPromptSubmitContextsToMessage(
          hookResult.stopReason
            ? `Operation stopped by hook: ${hookResult.stopReason}`
            : "Operation stopped by hook",
          additionalContexts,
        ),
      };
    }
    const attachment = hookResult.message?.attachment;
    if (
      attachment?.type === "hook_success" &&
      typeof attachment.content === "string" &&
      attachment.content.length > 0
    ) {
      additionalContexts.push(attachment.content);
    }
  }

  const expandedPrompt = await expandOneShotPromptFileMentions({
    configStore: params.configStore,
    input: params.prompt,
    cwd: params.cwd,
    stderr: params.stderr,
  });
  const promptWithContext = appendUserPromptSubmitContexts(
    expandedPrompt,
    additionalContexts,
  );
  return {
    blocked: false,
    prompt:
      typeof promptWithContext === "string"
        ? promptWithContext
        : userInputDisplayText(promptWithContext),
  };
}

async function prepareSubmittedPromptForTurn(params: {
  readonly session: Session;
  readonly configStore: ConfigStore;
  readonly input: string | readonly LLMContentPart[];
}): Promise<{
  readonly blocked: boolean;
  readonly input: string | readonly LLMContentPart[];
  readonly displayInput?: string;
  readonly blockMessage?: string;
}> {
  const prompt = userInputDisplayText(params.input);
  const hookOutcome = await collectUserPromptSubmitHookOutcome({
    session: params.session,
    prompt,
  });
  if (hookOutcome.blocked) {
    return {
      blocked: true,
      input: params.input,
      ...(hookOutcome.blockMessage !== undefined
        ? { blockMessage: hookOutcome.blockMessage }
        : {}),
    };
  }

  if (typeof params.input === "string") {
    const expanded = await expandPromptFileMentions({
      session: params.session,
      configStore: params.configStore,
      input: params.input,
    });
    return {
      blocked: false,
      input: appendUserPromptSubmitContexts(
        expanded.input,
        hookOutcome.additionalContexts,
      ),
      displayInput: expanded.displayInput ?? params.input,
    };
  }

  return {
    blocked: false,
    input: appendUserPromptSubmitContexts(
      params.input,
      hookOutcome.additionalContexts,
    ),
    displayInput: prompt,
  };
}

function installTuiSessionContract(params: {
  readonly session: Session;
  readonly configStore: ConfigStore;
  readonly agencHome: string;
  readonly resolvedProvider: string;
  readonly autonomousModeEnabled: boolean;
  readonly loadTurnInputsFn: () => Promise<PreparedTurnRuntimeInputs>;
  readonly runSingleTurnFn?: typeof runSingleTurn;
}): () => void {
  const configReloadLatch: ConfigReloadLatch = { requested: false };
  let sessionRef: Session | null = params.session;
  installSignalHandlers(() => sessionRef, configReloadLatch);
  const autonomousKeepalive = new AutonomousKeepaliveScheduler({
    isActive: () =>
      isAutonomousModeEnabled({
        enabled: params.autonomousModeEnabled,
        permissionContext: params.session.permissionModeRegistry.current(),
      }),
    submitTick: (tick) =>
      params.session.submit(tick, { source: AUTONOMOUS_SUBMIT_SOURCE }),
    onError: (error) => {
      params.session.emit({
        id: params.session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "autonomous_keepalive_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      });
    },
  });

  params.session.installTurnDriverHooks({
    submit: async (
      message: string | readonly LLMContentPart[],
      submitOpts?: SessionSubmitOptions,
    ) => {
      const isAutonomousTick = submitOpts?.source === AUTONOMOUS_SUBMIT_SOURCE;
      if (!isAutonomousTick) autonomousKeepalive.cancel();
      if (
        isAutonomousTick &&
        !isAutonomousModeEnabled({
          enabled: params.autonomousModeEnabled,
          permissionContext: params.session.permissionModeRegistry.current(),
        })
      ) {
        return;
      }

      let completedPromptTurn = false;
      let lastTurnToolNames = new Set<string>();
      let lastTurnStopReason:
        | Extract<PhaseEvent, { type: "turn_complete" }>["stopReason"]
        | null = null;
      const runPromptTurn = async (
        prompt: string | readonly LLMContentPart[],
        opts: { readonly displayInput?: string | null } = {},
      ): Promise<void> => {
        const preparedPrompt = await prepareSubmittedPromptForTurn({
          session: params.session,
          configStore: params.configStore,
          input: prompt,
        });
        if (preparedPrompt.blocked) return;
        const ctx = params.session.newDefaultTurn();
        // The task-dispatch subsystem (see session/tasks.ts) owns the
        // activeTurn lifecycle now. `runTurnKernel` calls
        // `session.spawnTask` at entry (which aborts any prior turn
        // with `TurnAbortReason::Replaced`) and `session.onTaskFinished`
        // in a finally. The earlier ad-hoc `activeTurn.swap` pattern
        // here was redundant AND incorrect under the new semantics: it
        // would populate the slot before the kernel tried to spawn,
        // and the kernel would then abort it as a "replaced" prior
        // turn.
        const toolNames = new Set<string>();
        const driveSingleTurn = params.runSingleTurnFn ?? runSingleTurn;
        for await (const event of driveSingleTurn({
          session: params.session,
          ctx,
          input: preparedPrompt.input,
          displayInput:
            opts.displayInput !== undefined
              ? opts.displayInput
              : preparedPrompt.displayInput,
          agencHome: params.agencHome,
          configStore: params.configStore,
          configReloadLatch,
          loadTurnInputsFn: params.loadTurnInputsFn,
          provider: params.resolvedProvider,
        })) {
          if (event.type === "tool_call") {
            toolNames.add(event.toolCall.name);
          }
          if (event.type === "turn_complete") {
            lastTurnStopReason = event.stopReason;
          }
          params.session.emitPhaseEvent(event);
        }
        lastTurnToolNames = toolNames;
        completedPromptTurn = true;
        autonomousKeepalive.setContextBlocked(lastTurnStopReason === "error");
      };

      const shouldScheduleNextAutonomousTick = (): boolean => {
        if (!completedPromptTurn) return false;
        if (lastTurnStopReason !== "completed") return false;
        if (!autonomousKeepalive.isActive()) return false;
        if (!isAutonomousTick) return true;
        if (lastTurnToolNames.has("Sleep")) return true;
        const activeToolNames = [...lastTurnToolNames].filter(
          (name) => name !== "Brief" && name !== "SendUserMessage",
        );
        return activeToolNames.length > 0;
      };

      const emitSlashResult = (
        input: string,
        result:
          | { readonly kind: "text"; readonly text: string }
          | { readonly kind: "compact"; readonly text: string }
          | { readonly kind: "prompt"; readonly content: string }
          | { readonly kind: "skip" }
          | { readonly kind: "exit"; readonly code: number }
          | { readonly kind: "error"; readonly message: string },
      ): void => {
        params.session.emitPhaseEvent({
          type: "slash_result",
          input,
          result,
          timestamp: Date.now(),
          turnId: params.session.activeTurn.unsafePeek()?.turnId,
        } as unknown as PhaseEvent);
      };

      const trimmed = typeof message === "string" ? message.trimStart() : "";
      if (typeof message === "string" && trimmed.startsWith("/")) {
        // The TUI publishes `session.appStateBridge` from
        // AgenCAppStateProvider so slash commands can refresh React-side
        // state synchronously (e.g., `/model` updates the status bar
        // immediately without waiting for the next turn boundary).
        const appStateBridge = (
          params.session as Session & { appStateBridge?: SlashCommandAppStateBridge }
        ).appStateBridge;
        const slash = await runSlashCommand(message, {
          session: params.session,
          cwd: params.session.sessionConfiguration.cwd ?? process.cwd(),
          home: resolveUserHome(
            process.env,
            params.session.sessionConfiguration.cwd ?? process.cwd(),
          ),
          agencHome: params.agencHome,
          configStore: params.configStore,
          ...(appStateBridge ? { appState: appStateBridge } : {}),
        });
        switch (slash.kind) {
          case "skip":
            emitSlashResult(message, {
              kind: "error",
              message: /[\r\n]/.test(message)
                ? "slash command rejected (multi-line input not allowed)"
                : "slash command rejected (invalid syntax)",
            });
            return;
          case "passthrough":
            await runPromptTurn(slash.input);
            if (shouldScheduleNextAutonomousTick()) {
              autonomousKeepalive.scheduleNext();
            }
            return;
          case "unknown":
          case "blocked_by_bridge":
            emitSlashResult(message, {
              kind: "error",
              message: slash.message,
            });
            return;
          case "dispatched":
            emitSlashResult(message, slash.result);
            if (slash.result.kind === "compact") {
              autonomousKeepalive.setContextBlocked(false);
            }
            if (slash.result.kind === "prompt") {
              await runPromptTurn(slash.result.content);
              if (shouldScheduleNextAutonomousTick()) {
                autonomousKeepalive.scheduleNext();
              }
              return;
            }
            if (slash.result.kind === "exit") {
              autonomousKeepalive.dispose();
              activeInkUnmount?.();
            }
            return;
        }
      }

      await runPromptTurn(message, {
        displayInput:
          submitOpts?.displayUserMessage !== undefined
            ? submitOpts.displayUserMessage
            : isAutonomousTick
              ? null
              : undefined,
      });
      if (shouldScheduleNextAutonomousTick()) {
        autonomousKeepalive.scheduleNext();
      }
    },
    flushEventLog: () => {
      params.session.rolloutStore?.flushDurable();
    },
  });

  return () => {
    sessionRef = null;
    autonomousKeepalive.dispose();
    params.session.installTurnDriverHooks(null);
  };
}

export const __installTuiSessionContractForTest = installTuiSessionContract;

// ─────────────────────────────────────────────────────────────────────
// Wave 5-B: shared module-level unmount ref. Signal handlers call this
// before `session.abortTerminal(...)` so the Ink tree tears down cleanly
// when a TUI is active. The wrapper is `null` while only the one-shot
// path is running.
// ─────────────────────────────────────────────────────────────────────

let activeInkUnmount: (() => void) | null = null;

/** Test-only helper — reset the module-level unmount ref between tests. */
export function __resetActiveInkUnmountForTest(): void {
  activeInkUnmount = null;
}

/** Test-only helper — install an unmount hook from unit tests. */
export function __setActiveInkUnmountForTest(fn: (() => void) | null): void {
  activeInkUnmount = fn;
}

type ConnectedDaemonTuiClient = Awaited<
  ReturnType<typeof createConnectedAgenCJsonLineDaemonTuiClient>
>;

async function stopDaemonAgentBestEffort(params: {
  readonly deps: AgenCDaemonCliDeps;
  readonly daemonClient?: ConnectedDaemonTuiClient | null;
  readonly env: NodeJS.ProcessEnv;
  readonly agentId: string;
  readonly reason: string;
}): Promise<void> {
  const stopParams: AgentStopParams = {
    agentId: params.agentId,
    reason: params.reason,
  };
  if (params.daemonClient !== undefined && params.daemonClient !== null) {
    try {
      await params.daemonClient.request("agent.stop", stopParams);
      return;
    } catch {
      /* fall through to one-shot stop client */
    }
  }
  await params.deps
    .stopPromptAgent({
      agentId: params.agentId,
      reason: params.reason,
      env: params.env,
    })
    .catch(() => {
      /* best effort */
    });
}

type DaemonOneShotFinalStatus = {
  readonly code: number;
  readonly message?: string;
};

type OneShotJsonResult = {
  readonly type: "result";
  readonly sessionId: string;
  readonly agentId: string;
  readonly exitCode: number;
  readonly finalMessage: string;
  readonly deniedPermissionRequestIds: readonly string[];
  readonly tokenUsage?: unknown;
  readonly cacheStats?: unknown;
  readonly events?: readonly unknown[];
};

function isJsonRecord(value: unknown): value is JsonObject {
  return isRecord(value);
}

function daemonEventParams(event: unknown): JsonObject | null {
  if (!isJsonRecord(event)) return null;
  return isJsonRecord(event.params) ? event.params : event;
}

function daemonNestedTranscriptEvent(event: unknown): JsonObject | null {
  const params = daemonEventParams(event);
  if (params === null) return null;
  if (isJsonRecord(params.event)) return params.event;
  if (isJsonRecord(params.msg)) return params.msg;
  return params;
}

function daemonOneShotMessageChunk(event: unknown): string | null {
  if (!isJsonRecord(event)) return null;
  const params = daemonEventParams(event);
  if (
    event.method === "event.message_chunk" &&
    params !== null &&
    typeof params.delta === "string"
  ) {
    return params.delta;
  }
  const transcriptEvent = daemonNestedTranscriptEvent(event);
  if (transcriptEvent === null) return null;
  const payload = isJsonRecord(transcriptEvent.payload)
    ? transcriptEvent.payload
    : null;
  if (
    transcriptEvent.type === "agent_message_delta" &&
    payload !== null &&
    typeof payload.delta === "string"
  ) {
    return payload.delta;
  }
  if (
    transcriptEvent.type === "agent_message" &&
    payload !== null &&
    typeof payload.message === "string"
  ) {
    return `${payload.message}\n`;
  }
  return null;
}

function writeOneShotJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function oneShotSnapshotFields(snapshot: unknown): Pick<
  OneShotJsonResult,
  "tokenUsage" | "cacheStats"
> {
  if (!isJsonRecord(snapshot)) return {};
  return {
    ...(isJsonRecord(snapshot.tokenUsage)
      ? { tokenUsage: snapshot.tokenUsage }
      : {}),
    ...(isJsonRecord(snapshot.cacheStats)
      ? { cacheStats: snapshot.cacheStats }
      : {}),
  };
}

/**
 * Detect a daemon `event.permission_request` and extract the `requestId` the
 * client must answer.
 *
 * The one-shot `--print` CLI is inherently non-interactive: there is no human
 * attached to answer an "ask"/"pause" permission request. The daemon forces
 * `--autonomous`, so any tool the model invokes that is not on the (empty by
 * default) unattended allowlist resolves to a pause → the evaluator surfaces an
 * "ask", and the runner suspends the turn awaiting a client decision that never
 * arrives — the run hangs until the wrapper SIGTERMs it. Answering the request
 * with a DENY (see {@link runDaemonOneShotPrompt}) lets the agent continue: the
 * tool call is rejected, and the agent produces a terminal answer/error so the
 * run terminates. This NEVER grants a permission — the only behavior change is
 * "unanswerable ask in non-interactive one-shot → deny + continue".
 */
function daemonOneShotPermissionRequestId(event: unknown): string | null {
  if (!isJsonRecord(event)) return null;
  if (event.method !== "event.permission_request") return null;
  const params = daemonEventParams(event);
  if (params === null) return null;
  return typeof params.requestId === "string" && params.requestId.length > 0
    ? params.requestId
    : null;
}

/**
 * Exit code used when a non-interactive one-shot run auto-denied at least one
 * permission request and then "completed" (the model gave up after its tool
 * call was rejected). Distinct from a real success (0) and from a daemon error
 * (1) so callers/scripts can tell a tool-blocked giveup from a genuine answer.
 */
const ONE_SHOT_TOOL_DENIED_EXIT_CODE = 2;

/**
 * Stderr marker emitted alongside {@link ONE_SHOT_TOOL_DENIED_EXIT_CODE} so a
 * human reading the run can see why it failed and how to grant the tool.
 */
const ONE_SHOT_TOOL_DENIED_MARKER =
  "agenc: tool denied in non-interactive mode; the run could not complete its " +
  "tool call and gave up. Re-run with --permission-mode or " +
  "--dangerously-bypass-approvals-and-sandbox to allow tools.";

function daemonOneShotFinalStatus(
  event: unknown,
): DaemonOneShotFinalStatus | null {
  if (!isJsonRecord(event)) return null;
  const params = daemonEventParams(event);
  if (event.method === "event.agent_status" && params !== null) {
    const runStatus =
      typeof params.runStatus === "string" ? params.runStatus : undefined;
    const status = typeof params.status === "string" ? params.status : undefined;
    const message = typeof params.message === "string" ? params.message : undefined;
    if (runStatus === "completed" || status === "idle") {
      return { code: 0, ...(message !== undefined ? { message } : {}) };
    }
    if (runStatus === "stopped" || status === "stopped") {
      return { code: 130, ...(message !== undefined ? { message } : {}) };
    }
    if (runStatus === "errored" || status === "error") {
      return { code: 1, ...(message !== undefined ? { message } : {}) };
    }
  }
  const transcriptEvent = daemonNestedTranscriptEvent(event);
  if (transcriptEvent === null) return null;
  const payload = isJsonRecord(transcriptEvent.payload)
    ? transcriptEvent.payload
    : null;
  if (transcriptEvent.type === "turn_complete") {
    const message =
      payload !== null && typeof payload.lastAgentMessage === "string"
        ? payload.lastAgentMessage
        : undefined;
    return { code: 0, ...(message !== undefined ? { message } : {}) };
  }
  if (transcriptEvent.type === "error") {
    const message =
      payload !== null && typeof payload.message === "string"
        ? payload.message
        : undefined;
    return { code: 1, ...(message !== undefined ? { message } : {}) };
  }
  return null;
}

async function runDaemonOneShotPrompt(params: {
  readonly deps: AgenCDaemonCliDeps;
  readonly prompt: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly outputFormat?: OneShotOutputFormat;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly initialContent?: string | readonly MessageContentBlock[];
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions";
}): Promise<number> {
  await params.deps.ensureDaemonReady(params.env)();
  const daemonClient = await params.deps.createConnectedTuiClient({
    env: params.env,
  });
  let startedAgentId: string | null = null;
  let unsubscribeEvents: (() => void) | null = null;
  let unsubscribeConnection: (() => void) | null = null;
  let completed = false;
  let printedAssistantOutput = false;
  let assistantOutput = "";
  let lastPrintedChar = "";
  const outputFormat = params.outputFormat ?? "text";
  const collectedEvents: unknown[] = [];

  try {
    const createParams: AgentCreateParams = {
      objective: params.prompt,
      instructions: params.prompt,
      cwd: params.cwd,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.provider !== undefined ? { provider: params.provider } : {}),
      ...(params.profile !== undefined ? { profile: params.profile } : {}),
      ...(params.initialContent !== undefined
        ? { initialContent: params.initialContent }
        : {}),
      ...(params.permissionMode !== undefined
        ? { permissionMode: params.permissionMode }
        : {}),
      metadata: {
        source: "agenc.prompt",
        mode: "one-shot",
      },
    };
    const started = await daemonClient.request("agent.create", createParams);
    startedAgentId = started.agentId;
    const attachment = await daemonClient.request("agent.attach", {
      agentId: started.agentId,
      clientId: `agenc-one-shot-${process.pid}`,
    });
    const sessionId =
      attachment.sessionIds[0] ?? started.sessionId ?? started.activeSessionIds?.[0];
    if (sessionId === undefined) {
      throw new Error(`daemon agent has no attached session: ${started.agentId}`);
    }

    const deniedPermissionRequestIds = new Set<string>();
    const code = await new Promise<number>((resolve, reject) => {
      let settled = false;
      let finalizing = false;
      const settle = (next: { readonly code: number } | { readonly error: Error }) => {
        if (settled) return;
        settled = true;
        unsubscribeEvents?.();
        unsubscribeConnection?.();
        if ("error" in next) {
          reject(next.error);
        } else {
          resolve(next.code);
        }
      };
      const snapshotFieldsForStructuredOutput =
        async (): Promise<Pick<OneShotJsonResult, "tokenUsage" | "cacheStats">> => {
          if (outputFormat === "text") return {};
          try {
            return oneShotSnapshotFields(
              await daemonClient.request("session.snapshot", { sessionId }),
            );
          } catch {
            return {};
          }
        };
      const writeFinalResult = async (result: {
        readonly exitCode: number;
        readonly finalMessage: string;
      }): Promise<void> => {
        if (outputFormat === "text") return;
        const jsonResult: OneShotJsonResult = {
          type: "result",
          sessionId,
          agentId: started.agentId,
          exitCode: result.exitCode,
          finalMessage: result.finalMessage,
          deniedPermissionRequestIds: [...deniedPermissionRequestIds],
          ...(await snapshotFieldsForStructuredOutput()),
          ...(outputFormat === "json" ? { events: collectedEvents } : {}),
        };
        if (outputFormat === "json") {
          process.stdout.write(`${JSON.stringify(jsonResult)}\n`);
        } else if (outputFormat === "stream-json") {
          writeOneShotJsonLine(jsonResult);
        }
      };

      unsubscribeConnection = daemonClient.subscribeToConnectionState((state) => {
        if (state.status === "disconnected") {
          settle({
            error: new Error(state.message ?? "daemon connection closed"),
          });
        }
      });

      unsubscribeEvents = daemonClient.subscribeToSessionEvents(
        sessionId,
        (event) => {
          if (outputFormat === "json") {
            collectedEvents.push(event);
          } else if (outputFormat === "stream-json") {
            writeOneShotJsonLine({
              type: "event",
              sessionId,
              agentId: started.agentId,
              event,
            });
          }
          // Non-interactive one-shot has no human to answer a permission
          // request, so an unanswered "ask"/"pause" suspends the turn and the
          // run hangs forever. DENY it (never grant) so the agent continues and
          // produces a terminal status. See daemonOneShotPermissionRequestId.
          const permissionRequestId = daemonOneShotPermissionRequestId(event);
          if (
            permissionRequestId !== null &&
            !deniedPermissionRequestIds.has(permissionRequestId)
          ) {
            deniedPermissionRequestIds.add(permissionRequestId);
            void daemonClient
              .request("tool.deny", {
                sessionId,
                requestId: permissionRequestId,
                reason: "non-interactive one-shot: no approver",
              })
              .catch(() => {
                /* best effort: a stale/already-resolved request is harmless */
              });
            return;
          }

          const chunk = daemonOneShotMessageChunk(event);
          if (chunk !== null && chunk.length > 0) {
            assistantOutput += chunk;
            if (outputFormat === "text") {
              process.stdout.write(chunk);
            }
            printedAssistantOutput = true;
            lastPrintedChar = chunk.at(-1) ?? lastPrintedChar;
          }

          const finalStatus = daemonOneShotFinalStatus(event);
          if (finalStatus === null) return;
          if (finalizing) return;
          finalizing = true;
          void (async () => {
            const finalMessage =
              finalStatus.message ?? assistantOutput.trimEnd();
            if (outputFormat === "text" && printedAssistantOutput) {
              if (lastPrintedChar !== "\n") process.stdout.write("\n");
            } else if (
              outputFormat === "text" &&
              finalStatus.code === 0 &&
              finalStatus.message !== undefined &&
              finalStatus.message.length > 0
            ) {
              process.stdout.write(`${finalStatus.message}\n`);
            }
            if (
              finalStatus.code !== 0 &&
              finalStatus.message !== undefined &&
              finalStatus.message.length > 0
            ) {
              process.stderr.write(`${finalStatus.message}\n`);
            }
            // A tool-blocked giveup must NOT masquerade as a successful answer.
            // When the run auto-denied a permission request (no human to approve;
            // see daemonOneShotPermissionRequestId) and then "completed", the
            // model gave up after its tool call was rejected. Override the
            // otherwise-zero exit so callers/scripts can distinguish a real answer
            // from a tool-blocked giveup, and surface a clear stderr marker. A run
            // that denied nothing keeps its normal exit code, so genuine no-tool
            // answers still exit 0 and genuine daemon errors still exit non-zero.
            if (finalStatus.code === 0 && deniedPermissionRequestIds.size > 0) {
              process.stderr.write(`${ONE_SHOT_TOOL_DENIED_MARKER}\n`);
              await writeFinalResult({
                exitCode: ONE_SHOT_TOOL_DENIED_EXIT_CODE,
                finalMessage,
              });
              settle({ code: ONE_SHOT_TOOL_DENIED_EXIT_CODE });
              return;
            }
            await writeFinalResult({
              exitCode: finalStatus.code,
              finalMessage,
            });
            settle({ code: finalStatus.code });
          })().catch((error: unknown) => {
            settle({
              error:
                error instanceof Error ? error : new Error(String(error)),
            });
          });
        },
      );
    });
    completed = true;
    return code;
  } catch (error) {
    if (startedAgentId !== null && !completed) {
      await stopDaemonAgentBestEffort({
        deps: params.deps,
        daemonClient,
        env: params.env,
        agentId: startedAgentId,
        reason: "one_shot_failed",
      });
    }
    throw error;
  } finally {
    const stopEvents = unsubscribeEvents as (() => void) | null;
    const stopConnection = unsubscribeConnection as (() => void) | null;
    stopEvents?.();
    stopConnection?.();
    await daemonClient.close().catch(() => {
      /* best effort */
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// One-shot CLI - daemon-backed non-TUI path.
// ─────────────────────────────────────────────────────────────────────

/**
 * Run a one-shot prompt through a daemon-owned agent and stream the answer.
 *
 * When `userMessage` is a non-empty string (routing path), it's used as
 * the prompt directly. Otherwise the function falls back to the
 * `resolveUserMessage` argv/stdin pipeline so older entry adapters still
 * work without a pre-resolved prompt.
 */
export async function oneShotCLI(
  userMessage: string | null = null,
  startupImages: readonly string[] = [],
): Promise<number> {
  const initAbort = new AbortController();
  const uninstallInitSignals = installInitSignalHandlers(initAbort);

  const throwIfAborted = (step: string) => {
    if (initAbort.signal.aborted) {
      throw new InitAbortedError(
        `${step}: ${String(initAbort.signal.reason ?? "aborted")}`,
      );
    }
  };

  try {
    validateAgencHome();
    throwIfAborted("validateAgencHome");
    const agencHome = resolveAgencHome(process.env);
    const oneShotArgv = process.argv.slice(2);
    const outputFormat = readOneShotOutputFormat(oneShotArgv);
    readOneShotInputFormat(oneShotArgv);

    const resolvedUserMessage =
      userMessage !== null && userMessage.length > 0
        ? userMessage
        : await resolveUserMessage(initAbort.signal);
    throwIfAborted("resolveUserMessage");

    const cliCwd = resolveCliCwdForStartup(process.env);
    if (!cliCwd.ok) {
      process.stderr.write(`agenc: ${cliCwd.message}\n`);
      return 1;
    }
    if (
      !(await requireProjectTrustForTui({
        env: process.env,
        argv: process.argv,
        cwd: cliCwd.cwd,
      }))
    ) {
      return 1;
    }
    throwIfAborted("requireProjectTrustForTui");

    const daemonCwd = cliCwd.cwd;
    const configStore = new ConfigStore({
      home: agencHome,
      env: process.env,
      onWarn: (message) => process.stderr.write(`${message}\n`),
    });
    await configStore.reload();
    const startup = resolveStartupSelection({
      config: configStore.current(),
      env: process.env,
      argv: process.argv,
    });
    const promptPreparation = await prepareOneShotPromptForDaemon({
      prompt: resolvedUserMessage,
      configStore,
      agencHome,
      cwd: daemonCwd,
      env: process.env,
      signal: initAbort.signal,
      stderr: process.stderr,
    });
    throwIfAborted("prepareOneShotPromptForDaemon");
    if (promptPreparation.blocked) {
      process.stderr.write(`${promptPreparation.blockMessage}\n`);
      return 1;
    }
    const preparedUserMessage = promptPreparation.prompt;
    const resolvedStartupImages =
      startupImages.length > 0
        ? startupImages
        : extractFlagValues(process.argv.slice(2), "--image");
    const initialContent = startupContentFromInputs(
      preparedUserMessage,
      resolvedStartupImages,
      daemonCwd,
      process.env.HOME,
    );
    const daemonPrompt =
      preparedUserMessage.trim().length > 0
        ? preparedUserMessage
        : initialContent !== undefined
          ? "Multimodal AgenC startup"
          : preparedUserMessage;
    // Forward --yolo / dangerously-skip flags to the daemon so the
    // print-mode oneShot agent runs under bypassPermissions, matching
    // the bootTUI path. See GAP-PE-GUARDIAN-YOLO-LEAK.
    const isYoloOneShot =
      oneShotArgv.includes("--yolo") ||
      oneShotArgv.includes("--dangerously-bypass-approvals-and-sandbox") ||
      oneShotArgv.includes("--allow-dangerously-skip-permissions");
    // Honor a validated `--permission-mode <value>` in the print path. Without
    // this, only --yolo/bypass propagated and acceptEdits/plan/default were
    // silently dropped. readStartupCliFlags already validated the flag (throwing
    // on a typo so a less-restrictive session can't boot silently). The daemon's
    // forced --autonomous does NOT override a forwarded acceptEdits/plan:
    // applyUnattendedPermissionPolicyToContext explicitly preserves the user's
    // explicit mode (only default → unattended), so forwarding takes effect
    // without weakening the unattended/security posture. --yolo still wins:
    // bypassPermissions takes precedence over any other forwarded mode. Narrow
    // to the daemon-accepted subset (agent.create rejects dontAsk/auto); other
    // user-addressable modes fall back to the unattended default as before.
    const startupCliFlags = readStartupCliFlags(process.argv);
    const oneShotPermissionMode = isYoloOneShot
      ? ("bypassPermissions" as const)
      : startupCliFlags.permissionMode === "default" ||
          startupCliFlags.permissionMode === "plan" ||
          startupCliFlags.permissionMode === "acceptEdits" ||
          startupCliFlags.permissionMode === "bypassPermissions"
        ? startupCliFlags.permissionMode
        : undefined;
    return await runDaemonOneShotPrompt({
      deps: daemonCliDeps(),
      prompt: daemonPrompt,
      env: process.env,
      cwd: daemonCwd,
      outputFormat,
      model: startup.model,
      provider: startup.provider,
      ...(startup.profileName !== undefined ? { profile: startup.profileName } : {}),
      ...(initialContent !== undefined ? { initialContent } : {}),
      ...(oneShotPermissionMode !== undefined
        ? { permissionMode: oneShotPermissionMode }
        : {}),
    });
  } catch (error) {
    if (error instanceof InitAbortedError) {
      process.stderr.write(`agenc: ${error.message}\n`);
      return 130;
    }
    if (
      error instanceof SessionLockedError ||
      error instanceof SchemaMismatchError
    ) {
      process.stderr.write(`agenc: ${error.message}\n`);
      return 1;
    }
    process.stderr.write(`agenc: ${cliStartupErrorMessage(error)}\n`);
    return 1;
  } finally {
    uninstallInitSignals();
  }
}

// ─────────────────────────────────────────────────────────────────────
// T12 Wave 5-B — TUI entry adapters
// ─────────────────────────────────────────────────────────────────────

/**
 * Load `tui/main.js` via dynamic import so the main `tsconfig.json`
 * (which excludes `src/tui/**`) can still typecheck `bin/agenc.ts`.
 * The TUI module itself is compiled through `tsconfig.tui.json`.
 */
async function loadBootTUI(): Promise<
  (opts: {
    session: unknown;
    configStore: unknown;
    model?: string;
    initialPrompt?: string;
    initialComposerText?: string;
    initialUserMessages?: readonly LLMMessage[];
  }) => Promise<{ unmount: () => void; waitUntilExit: () => Promise<void> }>
> {
  // The path is relative to the *compiled* output layout (both
  // `src/bin/agenc.ts` and `src/tui/main.tsx` emit into sibling
  // directories under `dist/`). We dodge static resolution by passing
  // the specifier through a variable — the main `tsconfig.json`
  // excludes `src/tui/**` so a direct `import("../tui/main.js")`
  // would fail to typecheck for lack of JSX configuration. The TUI
  // module is compiled through `tsconfig.tui.json` + tsup; runtime
  // resolution works unchanged because `dist/tui/main.js` sits next
  // to `dist/bin/agenc.js`.
  const specifier = "../tui/main.js";
  const mod = (await import(specifier)) as {
    readonly bootTUI: (opts: {
      session: unknown;
      configStore: unknown;
      model?: string;
      initialPrompt?: string;
      initialComposerText?: string;
      initialUserMessages?: readonly LLMMessage[];
    }) => Promise<{
      unmount: () => void;
      waitUntilExit: () => Promise<void>;
    }>;
  };
  return mod.bootTUI;
}

/**
 * Read and clear the session id the in-session `/resume` picker asked to
 * relaunch into. Loaded through a variable specifier for the same reason
 * as `loadBootTUI`: `src/tui/**` is excluded from the main tsconfig and
 * compiled separately, so a static `import("../tui/pending-resume.js")`
 * would not typecheck here. Returns `null` when no resume was requested
 * (the common case — the user just exited normally).
 */
async function consumePendingResumeSessionId(): Promise<string | null> {
  const specifier = "../tui/pending-resume.js";
  const mod = (await import(specifier)) as {
    readonly consumePendingResumeSessionId: () => string | null;
  };
  return mod.consumePendingResumeSessionId();
}

/**
 * After a live TUI exits, check whether the `/resume` picker requested a
 * relaunch. If so, re-enter the proven `resumeTUIEntry` attach path for
 * the chosen session (rehydrates cold rollouts + rebuilds the daemon
 * bridge). Runs only after `waitUntilExit()` + teardown, so the prior
 * session is cleanly detached first. Returns the exit code to surface.
 */
export async function exitOrResumeAfterTui(exitCode: number): Promise<number> {
  const resumeId = await consumePendingResumeSessionId();
  if (resumeId === null) return exitCode;
  return daemonCliDeps().resumeTui({ resumeId });
}

async function loadProjectTrustPrompt(): Promise<
  (opts: {
    readonly workspaceRoot: string;
    readonly riskSources?: readonly string[];
    readonly bypassPermissionsRequested?: boolean;
    readonly stdin?: NodeJS.ReadStream;
    readonly stdout?: NodeJS.WriteStream;
    readonly stderr?: NodeJS.WriteStream;
  }) => Promise<boolean>
> {
  const specifier = "./tui-trust-prompt.js";
  const mod = (await import(specifier)) as {
    readonly renderProjectTrustPrompt: (opts: {
      readonly workspaceRoot: string;
      readonly riskSources?: readonly string[];
      readonly bypassPermissionsRequested?: boolean;
      readonly stdin?: NodeJS.ReadStream;
      readonly stdout?: NodeJS.WriteStream;
      readonly stderr?: NodeJS.WriteStream;
    }) => Promise<boolean>;
  };
  return mod.renderProjectTrustPrompt;
}

async function markLegacySessionTrustAccepted(): Promise<void> {
  setSessionTrustAccepted(true);
}

export interface ProjectTrustPreflightOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly useEnvWorkspace?: boolean;
  readonly allowPrompt?: boolean;
  readonly renderPrompt?: (opts: {
    readonly workspaceRoot: string;
    readonly riskSources?: readonly string[];
    readonly stdin?: NodeJS.ReadStream;
    readonly stdout?: NodeJS.WriteStream;
    readonly stderr?: NodeJS.WriteStream;
  }) => Promise<boolean>;
  readonly markSessionTrusted?: () => Promise<void>;
}

export interface ProjectTrustPreflightResult {
  readonly accepted: boolean;
  readonly projectRoot: string;
  readonly prompted: boolean;
}

export async function runProjectTrustPreflightForTui(
  options: ProjectTrustPreflightOptions = {},
): Promise<ProjectTrustPreflightResult> {
  const env = options.env ?? process.env;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const agencHome = resolveAgencHome(env);
  const configStore = new ConfigStore({ home: agencHome, env });
  await configStore.reload();
  const startup = resolveStartupSelection({
    config: configStore.current(),
    env,
    argv: options.argv ?? process.argv,
  });
  const startupCliFlags = readStartupCliFlags(options.argv ?? process.argv);
  const rawWorkspace =
    options.useEnvWorkspace === false
      ? options.cwd ?? process.cwd()
      : resolveWorkspaceFromEnv(env) ?? options.cwd ?? process.cwd();
  const projectRoot = resolveProjectTrustRootSync({
    cwd: rawWorkspace,
    projectRootMarkers: startup.config.project_root_markers,
  });
  const configMigrations = await runStartupConfigMigrations({
    home: agencHome,
    cwd: projectRoot,
    configStore,
  });
  if (configMigrations.wrote) {
    await configStore.reload();
  }
  if (
    isProjectTrustedSync({
      agencHome,
      env,
      projectRoot,
      projectRootMarkers: startup.config.project_root_markers,
    })
  ) {
    await (options.markSessionTrusted ?? markLegacySessionTrustAccepted)();
    return { accepted: true, projectRoot, prompted: false };
  }

  const canPrompt =
    options.allowPrompt !== false && Boolean(stdin.isTTY) && Boolean(stdout.isTTY);
  if (!canPrompt) {
    stderr.write(`agenc: project is not trusted: ${projectRoot}\n`);
    return { accepted: false, projectRoot, prompted: false };
  }

  const riskSources = formatProjectTrustSources(
    await summarizeProjectTrustSources({
      cwd: projectRoot,
      home: agencHome,
      configStore,
    }),
  );
  const renderProjectTrustPrompt =
    options.renderPrompt ?? (await loadProjectTrustPrompt());
  const accepted = await renderProjectTrustPrompt({
    workspaceRoot: projectRoot,
    riskSources,
    bypassPermissionsRequested:
      startupCliFlags.allowDangerouslySkipPermissions === true ||
      startupCliFlags.permissionMode === "bypassPermissions",
    stdin,
    stdout,
    stderr,
  });
  if (!accepted) {
    return { accepted: false, projectRoot, prompted: true };
  }
  await trustProject({
    agencHome,
    env,
    projectRoot,
  });
  await (options.markSessionTrusted ?? markLegacySessionTrustAccepted)();
  return { accepted: true, projectRoot, prompted: true };
}

async function requireProjectTrustForTui(
  options: ProjectTrustPreflightOptions = {},
): Promise<boolean> {
  return (await runProjectTrustPreflightForTui(options)).accepted;
}

function isInteractiveTuiRoutePlan(
  plan: ReturnType<typeof classifyCLI>,
): boolean {
  return (
    plan.kind === "bootTUI" ||
    plan.kind === "resumeTUI" ||
    plan.kind === "continueTUI"
  );
}

export async function resolveAttachTargetTrustRoot(
  client: Awaited<
    ReturnType<typeof createConnectedAgenCJsonLineDaemonTuiClient>
  >,
  agentId: string,
): Promise<string> {
  const matches = (await listAgenCDaemonAgents(client)).filter(
    (agent) => agent.agentId === agentId,
  );

  if (matches.length !== 1) {
    throw new Error(`daemon agent not found for attach: ${agentId}`);
  }
  const cwd = matches[0]?.cwd?.trim();
  if (cwd === undefined || cwd.length === 0) {
    throw new Error(`daemon agent has no workspace metadata: ${agentId}`);
  }
  return cwd;
}

async function loadCreateDaemonTuiSession(): Promise<
  (opts: {
    baseSession: unknown;
    client: unknown;
    sessionId: string;
    conversationId?: string;
    clientId: string;
  }) => Promise<unknown>
> {
  const mod = (await import("../tui/daemon-session.js")) as {
    readonly createDaemonTuiSession: (opts: {
      baseSession: unknown;
      client: unknown;
      sessionId: string;
      conversationId?: string;
      clientId: string;
    }) => unknown;
  };
  return (opts) => Promise.resolve(mod.createDaemonTuiSession(opts));
}

type EarlyInputCapture = {
  readonly startCapturingEarlyInput?: () => void;
  readonly consumeEarlyInput?: (options?: {
    readonly restoreRawMode?: boolean;
  }) => string;
  readonly stopCapturingEarlyInput?: (options?: {
    readonly restoreRawMode?: boolean;
  }) => void;
};

async function startTuiEarlyInputCapture(): Promise<() => string> {
  try {
    const mod = (await import(
      "../utils/earlyInput.js"
    )) as EarlyInputCapture;
    mod.startCapturingEarlyInput?.();
    return () => mod.consumeEarlyInput?.({ restoreRawMode: true }) ?? "";
  } catch {
    return () => "";
  }
}

function messageContentBlocksFromUnknown(input: unknown): MessageContentBlock[] {
  if (typeof input === "string") return [{ type: "text", text: input }];
  if (typeof input !== "object" || input === null) return [];
  const content = (input as { readonly content?: unknown }).content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): MessageContentBlock[] => {
    if (typeof part !== "object" || part === null) return [];
    const record = part as {
      readonly type?: unknown;
      readonly text?: unknown;
      readonly image_url?: unknown;
    };
    if (record.type === "text" && typeof record.text === "string") {
      return [{ type: "text", text: record.text }];
    }
    if (record.type === "image_url") {
      const image = record.image_url;
      if (
        typeof image === "object" &&
        image !== null &&
        typeof (image as { readonly url?: unknown }).url === "string"
      ) {
        return [
          {
            type: "image_url",
            image_url: { url: (image as { readonly url: string }).url },
          },
        ];
      }
    }
    return [];
  });
}

type TuiSessionShape = {
  submit?: (
    message: string,
    opts?: { readonly displayUserMessage?: string | null },
  ) => Promise<void>;
  enqueueIdleInput?: (input: unknown) => number;
  subscribeToEvents?: (cb: (event: unknown) => void) => () => void;
  emit?: (event: unknown) => void;
  emitPhaseEvent?: (event: PhaseEvent) => void;
  cancelActiveTurn?: (reason?: string) => Promise<void>;
  clearDaemonSession?: () => Promise<void>;
  getDaemonSessionSnapshot?: () => Promise<unknown>;
  partialCompactFromMessage?: (params: {
    readonly messageOrdinal: number;
    readonly direction: "from" | "up_to";
    readonly feedback?: string;
    readonly signal?: AbortSignal;
  }) => Promise<unknown>;
  setPendingProviderSwitch?: (
    pending: { provider: string; model: string; profile?: string } | null,
  ) => void;
  setDaemonPermissionMode?: (mode: string) => Promise<unknown>;
  getDaemonHooksStatus?: () => Promise<unknown>;
  setDaemonHooksDisabled?: (disabled: boolean) => Promise<unknown>;
  applyDaemonConfig?: (params: {
    profile?: string;
    reload?: boolean;
  }) => Promise<unknown>;
  getInitialTranscriptEvents?: () => readonly unknown[];
  activeTurn?: {
    unsafePeek?: () => { readonly turnId: string } | null;
  } | null;
};

type LocalTuiSlashOutcome =
  | { readonly kind: "handled" }
  | { readonly kind: "prompt"; readonly content: string };

async function handleLocalTuiSlashCommand(params: {
  readonly message: string;
  readonly session: TuiSessionShape & Record<string, unknown>;
  readonly subscribers: Iterable<(event: unknown) => void>;
  readonly configStore: Pick<ConfigStore, "current">;
  readonly agencHome: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<LocalTuiSlashOutcome> {
  const appStateBridge = (
    params.session as TuiSessionShape & {
      appStateBridge?: SlashCommandAppStateBridge;
    }
  ).appStateBridge;
  const slash = await runSlashCommand(params.message, {
    session: params.session as unknown as Session,
    cwd: params.cwd,
    home: resolveUserHome(params.env, params.cwd),
    agencHome: params.agencHome,
    configStore: params.configStore as ConfigStore,
    ...(appStateBridge ? { appState: appStateBridge } : {}),
  });
  switch (slash.kind) {
    case "skip":
      emitLocalTuiSlashResult(params.subscribers, params.message, {
        kind: "error",
        message: /[\r\n]/.test(params.message)
          ? "slash command rejected (multi-line input not allowed)"
          : "slash command rejected (invalid syntax)",
      });
      return { kind: "handled" };
    case "passthrough":
      return { kind: "prompt", content: slash.input };
    case "unknown":
    case "blocked_by_bridge":
      emitLocalTuiSlashResult(params.subscribers, params.message, {
        kind: "error",
        message: slash.message,
      });
      return { kind: "handled" };
    case "dispatched":
      emitLocalTuiSlashResult(params.subscribers, params.message, slash.result);
      if (slash.result.kind === "prompt") {
        return { kind: "prompt", content: slash.result.content };
      }
      if (slash.result.kind === "exit") {
        activeInkUnmount?.();
      }
      return { kind: "handled" };
  }
}

async function createDeferredDaemonPromptTuiSession(params: {
  readonly baseSession: unknown;
  readonly configStore: Pick<ConfigStore, "current">;
  readonly deps: AgenCDaemonCliDeps;
  readonly agencHome: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly clientId: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions";
}): Promise<{ readonly session: unknown; readonly close: () => Promise<void> }> {
  // Mutable bootstrap config for the not-yet-created daemon session. Pre-first-
  // turn slash commands (`/model`, `/provider`, `/permissions mode`, `/plan`)
  // stage their choice HERE so the FIRST daemon turn (created lazily in
  // `ensureLiveSession`) consumes it. Seeded from the startup CLI flags; the
  // forwarders below overwrite these when `liveSession === null`. See the
  // pre-first-turn caveat fix.
  let pendingModel = params.model;
  let pendingProvider = params.provider;
  let pendingProfile = params.profile;
  let pendingPermissionMode = params.permissionMode;
  let liveSession: TuiSessionShape | null = null;
  let liveSessionPromise: Promise<TuiSessionShape | null> | null = null;
  let daemonClient: Awaited<
    ReturnType<typeof createConnectedAgenCJsonLineDaemonTuiClient>
  > | null = null;
  let queuedInputs: MessageContentBlock[] = [];
  let queuedInputCount = 0;
  const subscribers = new Set<(event: unknown) => void>();
  const liveUnsubscribers = new Map<(event: unknown) => void, () => void>();

  const detachLiveSession = async (): Promise<void> => {
    for (const unsubscribe of liveUnsubscribers.values()) unsubscribe();
    liveUnsubscribers.clear();
    liveSession = null;
    liveSessionPromise = null;
    const client = daemonClient;
    daemonClient = null;
    await client?.close().catch(() => {
      /* best effort */
    });
  };

  const ensureLiveSession = async (
    firstMessage: string,
  ): Promise<TuiSessionShape | null> => {
    if (liveSession !== null) return liveSession;
    if (liveSessionPromise !== null) return liveSessionPromise;
    liveSessionPromise = (async () => {
      const preparedFirstMessage =
        firstMessage.length > 0
          ? await prepareDaemonTuiPrompt({
              message: firstMessage,
              configStore: params.configStore,
              agencHome: params.agencHome,
              cwd: params.cwd,
              env: params.env,
              stderr: process.stderr,
            })
          : firstMessage;
      if (preparedFirstMessage === null) return null;
      const content: MessageContentBlock[] = [
        ...queuedInputs,
        ...(preparedFirstMessage.length > 0
          ? [{ type: "text" as const, text: preparedFirstMessage }]
          : []),
      ];
      if (content.length === 0) return null;
      const prompt =
        preparedFirstMessage.trim().length > 0
          ? preparedFirstMessage
          : "Multimodal AgenC startup";
      let startedAgentId: string | null = null;
      // Propagate --yolo from the user's argv into the daemon-spawned
      // agent's session config so the deferred TUI mirrors the bootTUI
      // path. See GAP-PE-GUARDIAN-YOLO-LEAK.
      const deferredArgvForYolo = process.argv.slice(2);
      const isYoloDeferred =
        deferredArgvForYolo.includes("--yolo") ||
        deferredArgvForYolo.includes("--dangerously-bypass-approvals-and-sandbox") ||
        deferredArgvForYolo.includes("--allow-dangerously-skip-permissions");
      try {
        const started = await params.deps.startPromptAgent({
          prompt,
          env: envWithBridgeMcpServers(params.baseSession, params.env),
          cwd: params.cwd,
          ...(pendingModel !== undefined ? { model: pendingModel } : {}),
          ...(pendingProvider !== undefined ? { provider: pendingProvider } : {}),
          ...(pendingProfile !== undefined ? { profile: pendingProfile } : {}),
          initialContent:
            content.length === 1 && content[0]?.type === "text"
              ? content[0].text
              : content,
          // Pre-first-turn `/permissions mode` / `/plan` stage their choice in
          // `pendingPermissionMode`; an explicit `--yolo` argv still wins so the
          // bootTUI-parity bypass behavior is preserved.
          ...(isYoloDeferred
            ? { permissionMode: "bypassPermissions" as const }
            : pendingPermissionMode !== undefined
              ? { permissionMode: pendingPermissionMode }
              : {}),
          metadata: { mode: "tui" },
        });
        startedAgentId = started.agentId;
        daemonClient = await params.deps.createConnectedTuiClient({
          env: params.env,
        });
        const attachment = await daemonClient.request("agent.attach", {
          agentId: started.agentId,
          clientId: params.clientId,
        });
        const sessionId = attachment.sessionIds[0];
        if (sessionId === undefined) {
          throw new Error(
            `daemon agent has no attached session: ${started.agentId}`,
          );
        }
        const createDaemonTuiSession = await loadCreateDaemonTuiSession();
        liveSession = wrapDaemonTuiSessionWithPromptPreparation(
          (await createDaemonTuiSession({
            baseSession: params.baseSession,
            client: daemonClient,
            sessionId,
            conversationId:
              attachment.runtimeSessionId ?? attachment.agentId ?? sessionId,
            clientId: params.clientId,
          })) as TuiSessionShape,
          {
            configStore: params.configStore,
            agencHome: params.agencHome,
            cwd: params.cwd,
            env: params.env,
            stderr: process.stderr,
          },
        );
        queuedInputs = [];
        queuedInputCount = 0;
        for (const subscriber of subscribers) {
          const unsubscribe = liveSession.subscribeToEvents?.(subscriber);
          if (unsubscribe !== undefined) {
            liveUnsubscribers.set(subscriber, unsubscribe);
          }
        }
        return liveSession;
      } catch (error) {
        if (startedAgentId !== null) {
          await stopDaemonAgentBestEffort({
            deps: params.deps,
            daemonClient,
            env: params.env,
            agentId: startedAgentId,
            reason: "tui_startup_failed",
          });
        }
        throw error;
      }
    })();
    try {
      return await liveSessionPromise;
    } finally {
      if (liveSession === null) liveSessionPromise = null;
    }
  };

  const base = params.baseSession as Record<string, unknown>;
  const originalEmit =
    typeof base.emit === "function"
      ? (base.emit as (event: unknown) => void).bind(base)
      : undefined;
  const session: TuiSessionShape & Record<string, unknown> = {
    ...base,
    // The Ink TUI's slash dispatcher in `App.tsx` calls `dispatchSlashCommand`
    // directly against `props.session` (this outer deferred wrapper) instead
    // of routing through `session.submit`, which means daemon-only methods
    // like `clearDaemonSession` must be reachable on this object. Without
    // this forwarder, `/clear` runs the local "Session cleared." render path
    // but never sends `session.clear` to the daemon — the model on the next
    // turn still sees the cleared history server-side. See round-2 finding
    // B-NEW1 (power-chainer-screen.log:117).
    clearDaemonSession: async () => {
      if (liveSession !== null) {
        await (liveSession as TuiSessionShape).clearDaemonSession?.();
      }
    },
    cancelActiveTurn: async (reason) => {
      if (liveSession !== null) {
        await liveSession.cancelActiveTurn?.(reason);
        return;
      }
      const abortAllTasks = (
        base as {
          abortAllTasks?: (reason: "interrupted") => Promise<void> | void;
        }
      ).abortAllTasks;
      if (abortAllTasks !== undefined) {
        await abortAllTasks.call(base, "interrupted");
      }
    },
    // Same forwarder pattern as clearDaemonSession: /status, /usage,
    // and /cache-stats all call `session.getDaemonSessionSnapshot()`
    // via App.tsx's slash dispatcher, which routes through this
    // outer deferred wrapper. Without forwarding to liveSession, the
    // snapshot is undefined and bridge-session counters stay at zero
    // even after real turns complete.
    getDaemonSessionSnapshot: async () => {
      if (liveSession === null) return undefined;
      const live = liveSession as TuiSessionShape & {
        getDaemonSessionSnapshot?: () => Promise<unknown>;
      };
      if (typeof live.getDaemonSessionSnapshot !== "function") {
        return undefined;
      }
      return live.getDaemonSessionSnapshot();
    },
    // Same forwarder pattern as clearDaemonSession/getDaemonSessionSnapshot:
    // `/compact` reaches the daemon's already-wired
    // `session.partialCompactFromMessage` RPC only through liveSession. The
    // deferred wrapper is the outer `props.session` App.tsx dispatches
    // against, so without forwarding, /compact silently no-ops on the
    // daemon path.
    partialCompactFromMessage: async (compactParams) => {
      if (liveSession === null) {
        // Honest pre-first-turn signal: there is genuinely no conversation to
        // compact, so we surface a clear message instead of faking success.
        throw new Error(
          "Nothing to compact yet — no conversation has started. Send a message first.",
        );
      }
      const live = liveSession as TuiSessionShape;
      if (typeof live.partialCompactFromMessage !== "function") {
        throw new Error(
          "Conversation compaction is not supported by this session.",
        );
      }
      return live.partialCompactFromMessage(compactParams);
    },
    // `/model` and `/provider` stage their switch by calling
    // setPendingProviderSwitch; forward to liveSession so the daemon's
    // session.setModel RPC runs the real switch machinery. Pre-first-turn
    // (no live session yet) persist the choice into the deferred-session
    // bootstrap config so the FIRST created turn picks it up, and mirror it
    // into baseSession.sessionConfiguration so `/model`'s readSessionSelection
    // and the chrome reflect the staged switch instead of silently faking
    // success.
    setPendingProviderSwitch: (pending) => {
      const live = liveSession as TuiSessionShape | null;
      if (live !== null) {
        live.setPendingProviderSwitch?.(pending);
        return;
      }
      if (pending === null) return;
      if (pending.model !== undefined) pendingModel = pending.model;
      if (pending.provider !== undefined) pendingProvider = pending.provider;
      if (pending.profile !== undefined) pendingProfile = pending.profile;
      const sessionConfiguration = (
        base as {
          sessionConfiguration?: {
            provider?: { slug?: string };
            collaborationMode?: { model?: string };
          };
        }
      ).sessionConfiguration;
      if (sessionConfiguration !== undefined) {
        if (pending.provider !== undefined) {
          sessionConfiguration.provider = {
            ...(sessionConfiguration.provider ?? {}),
            slug: pending.provider,
          };
        }
        if (pending.model !== undefined) {
          sessionConfiguration.collaborationMode = {
            ...(sessionConfiguration.collaborationMode ?? {}),
            model: pending.model,
          };
        }
      }
    },
    // `/permissions mode` and `/plan` route their mode change to the
    // daemon's real registry through liveSession.setDaemonPermissionMode.
    // Pre-first-turn (no live session yet) persist the mode into the
    // deferred-session bootstrap config so the FIRST created turn starts in
    // that mode, keep the client-local registry consistent, and return a
    // synthetic SessionSetPermissionModeResult so `/permissions mode` and
    // `/plan` report honest success instead of throwing / silently faking.
    setDaemonPermissionMode: async (mode) => {
      if (liveSession === null) {
        if (
          !(USER_ADDRESSABLE_PERMISSION_MODES as readonly string[]).includes(
            mode,
          )
        ) {
          throw new Error(
            `Unknown permission mode: "${mode}". Expected one of: ${USER_ADDRESSABLE_PERMISSION_MODES.join(", ")}`,
          );
        }
        const registry = (
          base as {
            services?: {
              permissionModeRegistry?: {
                current?: () => { readonly mode: string };
                update?: (next: {
                  readonly mode: string;
                  readonly [key: string]: unknown;
                }) => unknown;
              };
            };
          }
        ).services?.permissionModeRegistry;
        const previousMode = registry?.current?.().mode ?? "default";
        // Validated above against USER_ADDRESSABLE_PERMISSION_MODES, which is a
        // subset of the daemon prompt-agent permissionMode union.
        pendingPermissionMode = mode as
          | "default"
          | "plan"
          | "acceptEdits"
          | "bypassPermissions";
        if (registry?.update !== undefined && registry.current !== undefined) {
          await registry.update({ ...registry.current(), mode });
        }
        return {
          sessionId: "",
          applied: previousMode !== mode,
          previousMode,
          mode,
        };
      }
      const live = liveSession as TuiSessionShape;
      if (typeof live.setDaemonPermissionMode !== "function") {
        throw new Error(
          "Permission-mode switching is not supported by this session.",
        );
      }
      return live.setDaemonPermissionMode(mode);
    },
    // `/hooks` reads the daemon session's REAL configured-hooks runtime
    // through liveSession.getDaemonHooksStatus. Hooks live on the daemon
    // agent session, so there is nothing to inspect pre-first-turn.
    getDaemonHooksStatus: async () => {
      if (liveSession === null) {
        throw new Error(
          "Cannot inspect hooks yet: no live daemon session. Send a message first.",
        );
      }
      const live = liveSession as TuiSessionShape;
      if (typeof live.getDaemonHooksStatus !== "function") {
        throw new Error(
          "Hooks inspection is not supported by this session.",
        );
      }
      return live.getDaemonHooksStatus();
    },
    // `/hooks enable|disable` toggles the daemon session's live hooks runtime
    // through liveSession.setDaemonHooksDisabled.
    setDaemonHooksDisabled: async (disabled) => {
      if (liveSession === null) {
        throw new Error(
          "Cannot toggle hooks yet: no live daemon session. Send a message first.",
        );
      }
      const live = liveSession as TuiSessionShape;
      if (typeof live.setDaemonHooksDisabled !== "function") {
        throw new Error(
          "Hooks toggling is not supported by this session.",
        );
      }
      return live.setDaemonHooksDisabled(disabled);
    },
    // `/config profile` and `/config reload` re-apply config to the daemon's
    // live session through liveSession.applyDaemonConfig.
    applyDaemonConfig: async (configParams) => {
      if (liveSession === null) {
        throw new Error(
          "Cannot apply config yet: no live daemon session. Send a message first.",
        );
      }
      const live = liveSession as TuiSessionShape;
      if (typeof live.applyDaemonConfig !== "function") {
        throw new Error(
          "Config apply is not supported by this session.",
        );
      }
      return live.applyDaemonConfig(configParams);
    },
    activeTurn: {
      unsafePeek: () =>
        liveSession?.activeTurn?.unsafePeek?.() ??
        (
          typeof (
            base.activeTurn as
              | { readonly unsafePeek?: () => { readonly turnId: string } | null }
              | undefined
          )?.unsafePeek === "function"
            ? (
                base.activeTurn as {
                  readonly unsafePeek: () => { readonly turnId: string } | null;
                }
              ).unsafePeek()
            : null
        ),
    },
    submit: async (message, opts) => {
      // User-message rendering is driven entirely by daemon events:
      //   - Turn 1 (initialContent via `startPromptAgent`) is emitted
      //     from `BackgroundAgentRunner.startAgent` after the active
      //     agent and event-log bridge are installed; the event is
      //     buffered when `sessionBinding === undefined` and replayed
      //     when the TUI's `agent.attach` completes.
      //   - Turn 2+ (message.stream) is emitted by
      //     `BackgroundAgentRunner.submitAgentMessage`.
      // The previous local optimistic broadcast caused a duplicate
      // user-message row whenever both emits fired with different ids,
      // because the transcript reducer's dedup keys on `event.id`.
      if (liveSession !== null) {
        try {
          await liveSession.submit?.(message, opts);
          return;
        } catch (error) {
          if (
            isLocalSlashCommandInput(message) ||
            !isDaemonSessionGoneError(error)
          ) {
            throw error;
          }
          await detachLiveSession();
        }
      }
      const firstMessage = isLocalSlashCommandInput(message)
        ? await handleLocalTuiSlashCommand({
            message,
            session,
            subscribers,
            configStore: params.configStore,
            agencHome: params.agencHome,
            cwd: params.cwd,
            env: params.env,
          })
        : { kind: "prompt" as const, content: message };
      if (firstMessage.kind === "handled") return;
      await ensureLiveSession(firstMessage.content);
    },
    enqueueIdleInput: (input) => {
      if (liveSession !== null) {
        return liveSession.enqueueIdleInput?.(input) ?? 0;
      }
      const blocks = messageContentBlocksFromUnknown(input);
      queuedInputs.push(...blocks);
      queuedInputCount += blocks.length;
      return queuedInputCount;
    },
    emitPhaseEvent: (event) => {
      emitLocalTuiPhaseEvent(liveSession, subscribers, event);
    },
    emit: (event) => {
      if (typeof liveSession?.emit === "function") {
        liveSession.emit(event);
        return;
      }
      originalEmit?.(event);
      emitLocalTuiEvent(subscribers, event);
    },
    subscribeToEvents: (cb) => {
      subscribers.add(cb);
      if (liveSession !== null) {
        const unsubscribe = liveSession.subscribeToEvents?.(cb);
        if (unsubscribe !== undefined) liveUnsubscribers.set(cb, unsubscribe);
      }
      return () => {
        subscribers.delete(cb);
        liveUnsubscribers.get(cb)?.();
        liveUnsubscribers.delete(cb);
      };
    },
    getInitialTranscriptEvents: () =>
      liveSession?.getInitialTranscriptEvents?.() ??
      (typeof base.getInitialTranscriptEvents === "function"
        ? (base.getInitialTranscriptEvents as () => readonly unknown[])()
        : []),
  };

  return {
    session,
    close: async () => {
      await detachLiveSession();
    },
  };
}

/**
 * Test-only handle on the deferred daemon-prompt TUI session wrapper so the
 * pre-first-turn slash-command contract (model/provider/permission-mode/
 * compact staging into the initial bootstrap config) can be exercised without
 * a live daemon. Not part of the public CLI surface.
 */
export const __createDeferredDaemonPromptTuiSessionForTest =
  createDeferredDaemonPromptTuiSession;

function isLocalSlashCommandInput(message: string): boolean {
  const trimmed = message.trimStart();
  return trimmed.startsWith("/") && !/[\r\n]/.test(message);
}

function isDaemonSessionGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/AgenC daemon session not found or closed:/.test(message)) return true;
  if (!isRecord(error)) return false;
  if (error.code === "AGENT_NOT_FOUND") return true;
  const data = error.data;
  return isRecord(data) && data.code === "AGENT_NOT_FOUND";
}

function envWithBridgeMcpServers(
  baseSession: unknown,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const manager = (
    baseSession as {
      readonly services?: {
        readonly mcpManager?: {
          readonly getConfiguredServers?: () => readonly unknown[];
        };
      };
    }
  ).services?.mcpManager;
  const configs = manager?.getConfiguredServers?.();
  if (!Array.isArray(configs) || configs.length === 0) return env;
  return {
    ...env,
    AGENC_MCP_SERVERS: JSON.stringify(configs),
  };
}

async function prepareDaemonTuiPrompt(params: {
  readonly message: string;
  readonly configStore: Pick<ConfigStore, "current">;
  readonly agencHome: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}): Promise<string | null> {
  if (isLocalSlashCommandInput(params.message)) return null;
  const outcome = await prepareOneShotPromptForDaemon({
    prompt: params.message,
    configStore: params.configStore,
    agencHome: params.agencHome,
    cwd: params.cwd,
    env: params.env,
    signal: new AbortController().signal,
    stderr: params.stderr,
  });
  if (outcome.blocked) {
    params.stderr.write(`${outcome.blockMessage}\n`);
    return null;
  }
  return outcome.prompt;
}

function wrapDaemonTuiSessionWithPromptPreparation<
  Session extends {
    submit?: (
      message: string,
      opts?: { readonly displayUserMessage?: string | null },
    ) => Promise<void>;
    subscribeToEvents?: (cb: (event: unknown) => void) => () => void;
    emit?: (event: unknown) => void;
    emitPhaseEvent?: (event: PhaseEvent) => void;
  },
>(
  session: Session,
  params: {
    readonly configStore: Pick<ConfigStore, "current">;
    readonly agencHome: string;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly stderr: Pick<NodeJS.WriteStream, "write">;
  },
): Session {
  const originalSubmit = session.submit?.bind(session);
  if (originalSubmit === undefined) return session;
  const originalSubscribe = session.subscribeToEvents?.bind(session);
  const originalEmit = session.emit?.bind(session);
  const originalEmitPhaseEvent = session.emitPhaseEvent?.bind(session);
  const localSubscribers = new Set<(event: unknown) => void>();
  let wrapped!: Session;
  wrapped = {
    ...session,
    submit: async (message, opts) => {
      const nextMessage = isLocalSlashCommandInput(message)
        ? await handleLocalTuiSlashCommand({
            message,
            session: wrapped as TuiSessionShape & Record<string, unknown>,
            subscribers: localSubscribers,
            configStore: params.configStore,
            agencHome: params.agencHome,
            cwd: params.cwd,
            env: params.env,
          })
        : { kind: "prompt" as const, content: message };
      if (nextMessage.kind === "handled") return;
      const prepared = await prepareDaemonTuiPrompt({
        message: nextMessage.content,
        ...params,
      });
      if (prepared === null) return;
      await originalSubmit(prepared, opts);
    },
    subscribeToEvents: ((cb: (event: unknown) => void) => {
      localSubscribers.add(cb);
      const unsubscribeOriginal = originalSubscribe?.(cb);
      return () => {
        localSubscribers.delete(cb);
        unsubscribeOriginal?.();
      };
    }) as Session["subscribeToEvents"],
    emit: ((event: unknown) => {
      originalEmit?.(event);
      emitLocalTuiEvent(localSubscribers, event);
    }) as Session["emit"],
    emitPhaseEvent: ((event: PhaseEvent) => {
      emitLocalTuiPhaseEvent(
        { emitPhaseEvent: originalEmitPhaseEvent },
        localSubscribers,
        event,
      );
    }) as Session["emitPhaseEvent"],
  };
  return wrapped;
}

type BootTUIEntryArgs = BootTUIArgs & { readonly resumeId?: string };

/** Boot the TUI, preserving argv prompts and any pre-Ink typed draft text. */
export async function bootTUIEntry(args: BootTUIEntryArgs): Promise<number> {
  const startupCliFlags = readStartupCliFlags(process.argv);
  const cliCwd = resolveCliCwdForStartup(process.env);
  if (!cliCwd.ok) {
    return writeUnavailableCliCwd();
  }
  if (
    !(await requireProjectTrustForTui({
      env: process.env,
      argv: process.argv,
      cwd: cliCwd.cwd,
    }))
  ) {
    return 1;
  }
  const consumeEarlyInputRaw = await startTuiEarlyInputCapture();
  let earlyInputConsumed = false;
  const consumeEarlyInput = (): string => {
    if (earlyInputConsumed) return "";
    earlyInputConsumed = true;
    return consumeEarlyInputRaw();
  };
  try {
    validateAgencHome();
    if (args.resumeId !== undefined) {
      const deps = daemonCliDeps();
      const daemonClient = await deps.createConnectedTuiClient();
      let transferred = false;
      try {
        const agent = await deps.findAgentBySessionId(daemonClient, args.resumeId);
        if (agent === null) {
          process.stderr.write(`agenc: session not found: ${args.resumeId}\n`);
          return 1;
        }
        transferred = true;
        const code = await attachAgentTuiEntry({
          agentId: agent.agentId,
          clientId: `agenc-tui-${process.pid}`,
          daemonClient,
          initialComposerText: consumeEarlyInput(),
          startupImages: args.startupImages,
        });
        // attachAgentTuiEntry has closed its client + detached the prior
        // session; relaunch now if the /resume picker requested it.
        return exitOrResumeAfterTui(code);
      } finally {
        if (!transferred) {
          await daemonClient.close().catch(() => {
            /* best effort */
          });
        }
      }
    }
    const capturedEarlyInput = consumeEarlyInput();
    const initialPrompt = args.initialPrompt?.trim();
    const daemonCwd = cliCwd.cwd;
    const startupImages = args.startupImages ?? [];
    if (
      (initialPrompt === undefined || initialPrompt.length === 0) &&
      startupImages.length === 0
    ) {
      const deps = daemonCliDeps();
      const idleArgvForYolo = process.argv.slice(2);
      const isYoloIdle =
        idleArgvForYolo.includes("--yolo") ||
        idleArgvForYolo.includes("--dangerously-bypass-approvals-and-sandbox") ||
        idleArgvForYolo.includes("--allow-dangerously-skip-permissions");
      const {
        configStore,
        workspaceRoot,
        baseSession,
        model,
        close: closeTuiContext = async () => undefined,
      } = await deps.createTuiContext({
        env: process.env,
        cwd: daemonCwd,
        conversationId: `agenc-tui-idle-${process.pid}`,
        ...(startupCliFlags.provider !== undefined ? { provider: startupCliFlags.provider } : {}),
        ...(startupCliFlags.model !== undefined ? { model: startupCliFlags.model } : {}),
        ...(startupCliFlags.profile !== undefined ? { profile: startupCliFlags.profile } : {}),
        ...(isYoloIdle
          ? { permissionMode: "bypassPermissions" as const }
          : {}),
      });
      const deferred = await createDeferredDaemonPromptTuiSession({
        baseSession,
        configStore: configStore as unknown as Pick<ConfigStore, "current">,
        deps,
        agencHome:
          (configStore as { readonly agencHome?: string }).agencHome ??
          resolveAgencHome(process.env),
        env: process.env,
        cwd: workspaceRoot,
        clientId: `agenc-tui-${process.pid}`,
        ...(startupCliFlags.provider !== undefined ? { provider: startupCliFlags.provider } : {}),
        ...(startupCliFlags.model !== undefined ? { model: startupCliFlags.model } : {}),
        ...(startupCliFlags.profile !== undefined ? { profile: startupCliFlags.profile } : {}),
        // Seed the deferred bootstrap permission mode the same way the daemon
        // createTuiContext above does: an explicit `--yolo` forces bypass,
        // otherwise honor the startup `--permission-mode` flag. Pre-first-turn
        // `/permissions mode` / `/plan` then overwrite this staged value.
        ...(isYoloIdle
          ? { permissionMode: "bypassPermissions" as const }
          : startupCliFlags.permissionMode === "default" ||
              startupCliFlags.permissionMode === "plan" ||
              startupCliFlags.permissionMode === "acceptEdits" ||
              startupCliFlags.permissionMode === "bypassPermissions"
            ? { permissionMode: startupCliFlags.permissionMode }
            : {}),
      });
      const boot = await loadBootTUI();
      try {
        const handle = await boot({
          session: deferred.session,
          configStore,
          model,
          ...(capturedEarlyInput.length > 0
            ? { initialComposerText: capturedEarlyInput }
            : {}),
        });
        activeInkUnmount = handle.unmount;
        await handle.waitUntilExit();
      } finally {
        activeInkUnmount = null;
        await deferred.close();
        await closeTuiContext();
      }
      // Teardown is complete (prior session detached): honor a pending
      // /resume picker selection by relaunching into that session.
      return exitOrResumeAfterTui(0);
    }
    const objective =
      initialPrompt !== undefined && initialPrompt.length > 0
        ? initialPrompt
        : "Multimodal AgenC startup";
    const agencHome = resolveAgencHome(process.env);
    const configStore = new ConfigStore({
      home: agencHome,
      env: process.env,
      onWarn: (message) => process.stderr.write(`${message}\n`),
    });
    await configStore.reload();
    const startup = resolveStartupSelection({
      config: configStore.current(),
      env: process.env,
      argv: process.argv,
    });
    const promptPreparation =
      initialPrompt !== undefined && initialPrompt.length > 0
        ? await prepareOneShotPromptForDaemon({
            prompt: objective,
            configStore,
            agencHome,
            cwd: daemonCwd,
            env: process.env,
            signal: new AbortController().signal,
            stderr: process.stderr,
          })
        : { blocked: false as const, prompt: objective };
    if (promptPreparation.blocked) {
      process.stderr.write(`${promptPreparation.blockMessage}\n`);
      return 1;
    }
    const preparedObjective = promptPreparation.prompt;
    const initialContent = startupContentFromInputs(
      preparedObjective,
      startupImages,
      daemonCwd,
      process.env.HOME,
    );
    const deps = daemonCliDeps();
    // Propagate --yolo (and the deprecated aliases) to the daemon so the
    // spawned agent's session resolves approvalPolicy correctly. Without
    // this, --yolo only affected the local CLI bootstrap and dropped on
    // the wire — see GAP-PE-GUARDIAN-YOLO-LEAK and the daemon-side
    // forwarding in background-agent-runner.buildBootstrapArgv.
    const cliArgvForYolo = process.argv.slice(2);
    const isYoloFromCli =
      cliArgvForYolo.includes("--yolo") ||
      cliArgvForYolo.includes("--dangerously-bypass-approvals-and-sandbox") ||
      cliArgvForYolo.includes("--allow-dangerously-skip-permissions");
    const started = await deps.startPromptAgent({
      prompt: preparedObjective,
      env: process.env,
      cwd: daemonCwd,
      model: startup.model,
      provider: startup.provider,
      ...(startup.profileName !== undefined ? { profile: startup.profileName } : {}),
      ...(initialContent !== undefined ? { initialContent } : {}),
      ...(isYoloFromCli
        ? { permissionMode: "bypassPermissions" as const }
        : {}),
      metadata: { mode: "tui" },
    });
    try {
      const exitCode = await attachAgentTuiEntry({
        agentId: started.agentId,
        clientId: `agenc-tui-${process.pid}`,
        initialComposerText:
          args.initialPrompt === undefined ? capturedEarlyInput : "",
      });
      if (exitCode !== 0) {
        await stopDaemonAgentBestEffort({
          deps,
          env: process.env,
          agentId: started.agentId,
          reason: "tui_startup_failed",
        });
      }
      // Honor a pending /resume picker selection (prior session detached).
      return exitOrResumeAfterTui(exitCode);
    } catch (error) {
      await stopDaemonAgentBestEffort({
        deps,
        env: process.env,
        agentId: started.agentId,
        reason: "tui_startup_failed",
      });
      throw error;
    }
  } catch (error) {
    consumeEarlyInput();
    if (
      error instanceof SessionLockedError ||
      error instanceof SchemaMismatchError
    ) {
      process.stderr.write(`agenc: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

export interface AttachAgentTuiEntryArgs {
  readonly agentId: string;
  readonly clientId: string;
  readonly initialComposerText?: string;
  readonly startupImages?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly daemonClient?: Awaited<
    ReturnType<typeof createConnectedAgenCJsonLineDaemonTuiClient>
  >;
}

/** Attach the Ink TUI to a daemon-owned background agent session. */
export async function attachAgentTuiEntry(
  args: AttachAgentTuiEntryArgs,
): Promise<number> {
  const env = args.env ?? process.env;
  let daemonClient: Awaited<
    ReturnType<typeof createConnectedAgenCJsonLineDaemonTuiClient>
  > | null = null;
  try {
    validateAgencHome(env);
    daemonClient =
      args.daemonClient ??
      (await daemonCliDeps().createConnectedTuiClient({
        env,
      }));
    const targetCwd = await resolveAttachTargetTrustRoot(
      daemonClient,
      args.agentId,
    );
    if (
      !(await requireProjectTrustForTui({
        env,
        argv: process.argv,
        cwd: targetCwd,
        useEnvWorkspace: false,
      }))
    ) {
      return 1;
    }
    const attachment = await daemonClient.request("agent.attach", {
      agentId: args.agentId,
      clientId: args.clientId,
    });
    const sessionId = attachment.sessionIds[0];
    if (sessionId === undefined) {
      throw new Error(`daemon agent has no attached session: ${args.agentId}`);
    }
    const runtimeSessionId =
      attachment.runtimeSessionId ?? attachment.agentId ?? sessionId;
    const bootstrapCwd = resolveAgenCAgentAttachCwd(attachment, targetCwd);
    const bootstrapEnv = envForAttachBootstrap(env, bootstrapCwd);
    const attachArgvForYolo = process.argv.slice(2);
    const isYoloAttach =
      attachArgvForYolo.includes("--yolo") ||
      attachArgvForYolo.includes(
        "--dangerously-bypass-approvals-and-sandbox",
      ) ||
      attachArgvForYolo.includes("--allow-dangerously-skip-permissions");
    const {
      configStore,
      workspaceRoot,
      baseSession,
      model,
      close: closeTuiContext = async () => undefined,
    } = await daemonCliDeps().createTuiContext({
      env: bootstrapEnv,
      cwd: bootstrapCwd,
      conversationId: runtimeSessionId,
      ...(isYoloAttach
        ? { permissionMode: "bypassPermissions" as const }
        : {}),
    });
    const createDaemonTuiSession = await loadCreateDaemonTuiSession();
    const daemonSession = await createDaemonTuiSession({
      baseSession,
      client: daemonClient,
      sessionId,
      conversationId: runtimeSessionId,
      clientId: args.clientId,
    });
    const preparedDaemonSession = wrapDaemonTuiSessionWithPromptPreparation(
      daemonSession as {
        submit?: (
          message: string,
          opts?: { readonly displayUserMessage?: string | null },
        ) => Promise<void>;
      },
      {
        configStore: configStore as unknown as Pick<ConfigStore, "current">,
        agencHome:
          (configStore as { readonly agencHome?: string }).agencHome ??
          resolveAgencHome(bootstrapEnv),
        cwd: workspaceRoot,
        env: bootstrapEnv,
        stderr: process.stderr,
      },
    );
    const boot = await loadBootTUI();
    const startupImages = args.startupImages ?? [];
    const initialUserMessages =
      startupImages.length > 0
        ? startupImageMessagesFromInputs(
            startupImages,
            workspaceRoot,
            bootstrapEnv.HOME,
          )
        : [];
    try {
      const handle = await boot({
        session: preparedDaemonSession,
        configStore,
        model,
        ...(args.initialComposerText !== undefined &&
        args.initialComposerText.length > 0
          ? { initialComposerText: args.initialComposerText }
          : {}),
        ...(initialUserMessages.length > 0 ? { initialUserMessages } : {}),
      });
      activeInkUnmount = handle.unmount;
      await handle.waitUntilExit();
    } finally {
      activeInkUnmount = null;
      await closeTuiContext();
    }
    // Return a plain exit code here. A pending /resume picker selection is
    // honored by the outer entrypoints (bootTUIEntry / resumeTUIEntry) once
    // this function's finally chain has closed the daemon client and
    // detached the prior session — see exitOrResumeAfterTui at those call
    // sites. Doing the relaunch here would race the daemonClient.close()
    // below and re-resume before teardown completes.
    return 0;
  } catch (error) {
    if (
      error instanceof SessionLockedError ||
      error instanceof SchemaMismatchError
    ) {
      process.stderr.write(`agenc: ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await daemonClient?.close().catch(() => {
      /* best effort */
    });
  }
}

/** Resume a daemon-owned session through the TUI. */
export async function resumeTUIEntry(args: ResumeTUIArgs): Promise<number> {
  const cliCwd = resolveCliCwdForStartup(process.env);
  if (!cliCwd.ok) {
    return writeUnavailableCliCwd();
  }
  const workspaceRoot = cliCwd.cwd;
  const resolved = resolveResumeSessionId(workspaceRoot, args.resumeId);
  switch (resolved.kind) {
    case "ok": {
      const deps = daemonCliDeps();
      await deps.ensureDaemonReady(process.env)();
      const daemonClient = await deps.createConnectedTuiClient();
      let transferred = false;
      try {
        const agent = await deps.findAgentBySessionId(
          daemonClient,
          resolved.sessionId,
        );
        if (agent === null) {
          process.stderr.write(`agenc: session not found: ${args.resumeId}\n`);
          return 1;
        }
        transferred = true;
        const code = await attachAgentTuiEntry({
          agentId: agent.agentId,
          clientId: `agenc-tui-${process.pid}`,
          daemonClient,
        });
        // Chained /resume: if the user picks another session from within a
        // resumed TUI, relaunch into it once teardown is complete.
        return exitOrResumeAfterTui(code);
      } finally {
        if (!transferred) {
          await daemonClient.close().catch(() => {
            /* best effort */
          });
        }
      }
    }
    case "ambiguous":
      process.stderr.write(
        `agenc: ambiguous session id '${resolved.input}' matches: ${resolved.matches.join(", ")}\n`,
      );
      return 1;
    case "none":
    case "not_found":
      process.stderr.write(
        `agenc: session not found in either legacy or hashed project layout: ${args.resumeId}\n`,
      );
      return 1;
  }
}

/** Continue the newest prior session for the current project. */
export async function continueTUIEntry(
  _args: ContinueTUIArgs,
): Promise<number> {
  const cliCwd = resolveCliCwdForStartup(process.env);
  if (!cliCwd.ok) {
    return writeUnavailableCliCwd();
  }
  const workspaceRoot = cliCwd.cwd;
  const resolved = resolveLatestSessionId(workspaceRoot);
  if (resolved.kind !== "ok") {
    process.stderr.write("agenc: no previous session found for this project\n");
    return 1;
  }
  return resumeTUIEntry({ resumeId: resolved.sessionId });
}

/**
 * AgenC-style CLI startup gate: config reads must be enabled before any
 * downstream path can touch global settings (auto-compact, theme, provider
 * profiles, etc.). AgenC routes both the one-shot and Ink console through this
 * same entrypoint, so the gate belongs here rather than in individual phases.
 */
export function initializeCliRuntime(): void {
  // Apply pre-main process hardening before any I/O or subprocess spawn:
  // scrub LD_*/DYLD_* dynamic-loader env vars, drop RLIMIT_CORE to 0, and
  // disable core/ptrace dumping via PR_SET_DUMPABLE on Linux or
  // PT_DENY_ATTACH on macOS. Best-effort — failures are non-fatal so the
  // CLI still starts on platforms where the native binding is unavailable.
  applyBestEffortPreMainProcessHardening();
  enableConfigs();
}

async function loadMcpCliConfig(): Promise<AgenCConfig | undefined> {
  try {
    const store = new ConfigStore({
      home: resolveAgencHome(process.env),
      env: process.env,
      onWarn: (message) => process.stderr.write(`${message}\n`),
    });
    return await store.reload();
  } catch {
    return undefined;
  }
}

export function shouldLoadMcpCliConfig(argv: readonly string[]): boolean {
  if (argv[0] !== "mcp" || argv[1] !== "serve") return false;
  const rest = argv.slice(2);
  if (rest.length === 0) return true;

  let explicitTransport: "stdio" | "sse" | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--help" || arg === "-h") return false;
    if (arg === "--transport") {
      const value = rest[i + 1];
      if (value !== "stdio" && value !== "sse") return false;
      explicitTransport = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--transport=")) {
      const value = arg.slice("--transport=".length);
      if (value !== "stdio" && value !== "sse") return false;
      explicitTransport = value;
      continue;
    }
    return false;
  }

  return explicitTransport === "sse";
}

// ─────────────────────────────────────────────────────────────────────
// main — Wave 5-B routing entrypoint
// ─────────────────────────────────────────────────────────────────────

/**
 * Top-level dispatcher. Branches between the full Ink TUI and the
 * daemon-backed one-shot CLI based on argv + stdio state. See `./route.ts`
 * for the routing table.
 */
export async function main(): Promise<number> {
  initializeCliRuntime();
  const argv = process.argv.slice(2);
  const initCommand = parseAgenCInitCliArgs(argv);
  if (initCommand !== null) {
    return runAgenCInitCli(initCommand);
  }
  const daemonCommand = parseAgenCDaemonCliArgs(argv);
  if (daemonCommand !== null) {
    if (
      daemonCommand.kind === "command" &&
      (daemonCommand.action === "start" ||
        daemonCommand.action === "run" ||
        daemonCommand.action === "restart")
    ) {
      // Warn (never block) when starting the daemon with critical audit
      // findings — exposure misconfigurations matter most at startup.
      try {
        const audit = await buildSecurityAuditReport({ env: process.env });
        if (audit.criticalCount > 0) {
          process.stderr.write(
            `agenc: WARNING — ${formatSecurityAuditSummaryLine(audit)}\n`,
          );
        }
      } catch {
        // Advisory only.
      }
    }
    return runAgenCDaemonCli(daemonCommand);
  }
  const remoteCommand = parseAgenCRemoteCliArgs(argv);
  if (remoteCommand !== null) {
    return runAgenCRemoteCli(remoteCommand);
  }
  const agentCommand = parseAgenCAgentCliArgs(argv);
  if (agentCommand !== null) {
    if (agentCommand.kind === "attach") {
      return runAgenCAgentCli(agentCommand, {
        env: process.env,
        attachTui: (context) => attachAgentTuiEntry(context),
      });
    }
    if (agentCommand.kind === "start") {
      const agentStartCwdResult = resolveCliCwdForStartup(process.env, {
        useEnvWorkspace: false,
      });
      if (!agentStartCwdResult.ok) {
        return writeUnavailableCliCwd();
      }
      const agentStartCwd = agentStartCwdResult.cwd;
      return runAgenCAgentCli(agentCommand, {
        env: process.env,
        cwd: agentStartCwd,
        ensureDaemonReady: async () => {
          if (
            !(await requireProjectTrustForTui({
              env: process.env,
              argv: process.argv,
              cwd: agentStartCwd,
              useEnvWorkspace: false,
            }))
          ) {
            throw new Error("project trust was not accepted");
          }
          await defaultEnsureDaemonReady(process.env)();
        },
        attachTui: (context) => attachAgentTuiEntry(context),
      });
    }
    return runAgenCAgentCli(agentCommand, {
      env: process.env,
      attachTui: (context) => attachAgentTuiEntry(context),
    });
  }
  const authCommand = parseAgenCAuthCliArgs(argv);
  if (authCommand !== null) {
    const code = await runAgenCAuthCli(authCommand);
    if (
      code !== 0 ||
      authCommand.kind !== "login" ||
      !shouldLaunchTuiAfterLogin()
    ) {
      return code;
    }
    return runDefaultAgenCCliRoute(process.argv.slice(0, 2));
  }
  const mcpConfig = shouldLoadMcpCliConfig(argv)
    ? await loadMcpCliConfig()
    : undefined;
  const mcpCommand = parseAgenCMcpCliArgs(argv, mcpConfig);
  if (mcpCommand !== null) {
    return runAgenCMcpCli(mcpCommand);
  }
  const doctorCommand = parseAgenCDoctorCliArgs(argv);
  if (doctorCommand !== null) {
    return runAgenCDoctorCli(doctorCommand);
  }
  const onboardCommand = parseAgenCOnboardCliArgs(argv);
  if (onboardCommand !== null) {
    if (onboardCommand.kind !== "launch") {
      return runAgenCOnboardCli(onboardCommand);
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write(
        "agenc: onboard needs an interactive terminal (use 'agenc onboard --status' in scripts)\n",
      );
      return 1;
    }
    const daemonStatus = await readOnboardDaemonStatus(process.env);
    process.stderr.write(
      daemonStatus.running
        ? `agenc: daemon running (pid ${daemonStatus.pid})\n`
        : "agenc: daemon not running — it starts automatically with the session\n",
    );
    // Onboarding is the moment defaults get set: surface the audit posture
    // up front (read-only; never blocks the wizard).
    try {
      const audit = await buildSecurityAuditReport({ env: process.env });
      process.stderr.write(
        `agenc: ${formatSecurityAuditSummaryLine(audit)}\n`,
      );
    } catch {
      // Audit is advisory here; the wizard must not be blocked by it.
    }
    // Force the first-run wizard for this process only (never persisted);
    // consumed by shouldShowFirstRunOnboarding via the TUI's env snapshot.
    process.env.AGENC_ONBOARDING = "force";
    return runDefaultAgenCCliRoute(process.argv.slice(0, 2));
  }
  const securityCommand = parseAgenCSecurityCliArgs(argv);
  if (securityCommand !== null) {
    return runAgenCSecurityCli(securityCommand);
  }
  const gatewayCommand = parseAgenCGatewayCliArgs(argv);
  if (gatewayCommand !== null) {
    return runAgenCGatewayCli(gatewayCommand);
  }
  const budgetCommand = parseAgenCBudgetCliArgs(argv);
  if (budgetCommand !== null) {
    return runAgenCBudgetCli(budgetCommand);
  }
  const providersCommand = parseAgenCProvidersCliArgs(argv);
  if (providersCommand !== null) {
    return runAgenCProvidersCli(providersCommand);
  }
  const configCommand = parseAgenCConfigCliArgs(argv);
  if (configCommand !== null) {
    return runAgenCConfigCli(configCommand);
  }
  const pluginCommand = parseAgenCPluginCliArgs(argv);
  if (pluginCommand !== null) {
    return runAgenCPluginCli(pluginCommand);
  }
  const permissionsCommand = parseAgenCPermissionsCliArgs(argv);
  if (permissionsCommand !== null) {
    return runAgenCPermissionsCli(permissionsCommand);
  }
  const stateCommand = parseAgenCStateCliArgs(argv);
  if (stateCommand !== null) {
    return runAgenCStateCli(stateCommand);
  }
  const trajectoriesCommand = parseAgenCTrajectoriesCliArgs(argv);
  if (trajectoriesCommand !== null) {
    return runAgenCTrajectoriesCli(trajectoriesCommand);
  }

  const startupShortCircuit = detectStartupShortCircuit(argv);
  if (startupShortCircuit !== null) {
    if (startupShortCircuit.kind === "error") {
      process.stderr.write(`agenc: ${startupShortCircuit.message}\n`);
      return 1;
    }
    process.stdout.write(`${startupShortCircuit.text}\n`);
    return 0;
  }
  return runDefaultAgenCCliRoute(process.argv);
}

function shouldLaunchTuiAfterLogin(): boolean {
  return process.env.AGENC_LOGIN_NO_TUI !== "1" &&
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stdout.isTTY);
}

async function runDefaultAgenCCliRoute(argv: readonly string[]): Promise<number> {
  const routePlan = classifyCLI({
    argv,
    isTTY: Boolean(process.stdin.isTTY),
    isStdoutTTY: Boolean(process.stdout.isTTY),
  });
  const routeNeedsToolTrust =
    routePlan.kind === "oneShotCLI" || isInteractiveTuiRoutePlan(routePlan);
  const routeCwd = routeNeedsToolTrust
    ? resolveCliCwdForStartup(process.env)
    : null;
  if (routeCwd !== null && !routeCwd.ok) {
    return writeUnavailableCliCwd();
  }
  if (routeNeedsToolTrust) {
    if (routeCwd === null) {
      return writeUnavailableCliCwd();
    }
    if (!(await requireProjectTrustForTui({
      env: process.env,
      argv,
      cwd: routeCwd.cwd,
    }))) {
      return 1;
    }
  }
  if (await resolveAgenCDaemonAutostartEnabled(process.env)) {
    try {
      await ensureAgenCDaemonAutostart();
    } catch (error) {
      process.stderr.write(
        `agenc: daemon autostart failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  }
  return routeCLI({
    argv,
    isTTY: Boolean(process.stdin.isTTY),
    isStdoutTTY: Boolean(process.stdout.isTTY),
    bootTUI: (args: BootTUIArgs) => bootTUIEntry(args),
    oneShotCLI: (userMessage: string, startupImages?: readonly string[]) =>
      oneShotCLI(userMessage.length > 0 ? userMessage : null, startupImages ?? []),
    resumeTUI: (args: ResumeTUIArgs) => resumeTUIEntry(args),
    continueTUI: (args: ContinueTUIArgs) => continueTUIEntry(args),
  });
}

/**
 * Detect whether this module is being invoked as the CLI entrypoint
 * (via `node dist/bin/agenc.js` or the `agenc` binary) rather than
 * imported by tests / other code. Only the direct-invocation path
 * drains the main loop and calls `process.exit()`.
 *
 * Tests import `main` explicitly and drive it with their own stubs;
 * they MUST NOT trigger the IIFE.
 *
 * Detection strategy: inspect `process.argv[1]` (Node fills this with
 * the resolved script path when the file is the direct entry point).
 * Works under both CJS and ESM emit from tsup without touching
 * `import.meta`, which is forbidden in the CJS output target.
 */
function isDirectInvocation(): boolean {
  // Env opt-out: tests can force the IIFE off even on odd harnesses.
  if (process.env.AGENC_CLI_ENTRY_DISABLE === "1") return false;
  const argv1 = process.argv[1];
  if (!argv1) return false;
  // The CLI binary resolves to `<prefix>/bin/agenc.js` (or `.mjs`) and
  // the `agenc` shim in `package.json.bin` symlinks to this script.
  // Match the tail of the entry path so both `node .../agenc.js` and
  // the installed `agenc` CLI pass the check.
  return /[\\/]bin[\\/]agenc(?:\.[mc]?js)?$/.test(argv1);
}

if (isDirectInvocation()) {
  void (async () => {
    // Install the process-global error net before anything runs so a stray
    // uncaught exception / unhandled rejection on the daemon or TUI main path
    // is logged instead of vanishing silently or crashing with a raw stack.
    // Only on direct invocation — tests import main() and must keep vitest's
    // own rejection detection intact.
    installGlobalErrorNet();
    try {
      const code = await main();
      process.exit(code);
    } catch (error) {
      process.stderr.write(`agenc: ${cliStartupErrorMessage(error)}\n`);
      process.exit(1);
    }
  })();
}
