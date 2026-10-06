import "../bootstrap/node-env.js";
import type { OneShotContinueSession } from "./route.js";
import { reproveResumeDescriptor, type ResumeCwdProof, openResumeCwdProof, assertResumeCwdProof, assertLiveAgentMatchesResumeDescriptor, isCanonicalSessionAlreadyActiveError } from "./daemon-one-shot-continue.js";
import { runDefaultCliRoute } from "./default-cli-route.js";
import { readProcessCwdSafely, resolveCliCwdForStartup, writeUnavailableCliCwd } from "./cli-cwd.js";
import { requireProjectTrustForTui } from "./project-trust-preflight.js";
import { prepareCliRuntime } from "./cli-runtime.js";
import { runCliProcessMain } from "./cli-process-main.js";
import { isDirectInvocation, shouldRunDaemonStartupSecurityAudit } from "./daemon-entry-policy.js";
import { selectAgenCCliEntry } from "./cli-entry-policy.js";
import { setCoreOnlyEnvironmentVariable } from "../utils/runtimeEnvironment.js";
import { closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { VERSION } from "../version.js";
import { type BootTUIArgs, type ContinueTUIArgs, type ResumeTUIArgs } from "./route.js";
import { startupShortCircuitFlag } from "./startup-preflight.js";
import type { LLMContentPart, LLMMessage } from "../llm/types.js";
import type { PhaseEvent } from "../phases/events.js";
import { type Session, type IdleInputAdmission, type IdleInputOwnership, type McpSurfaceSnapshot } from "../session/session.js";
import { AUTONOMOUS_SUBMIT_SOURCE, AutonomousKeepaliveScheduler, isAutonomousModeEnabled, type SessionSubmitOptions } from "../session/autonomous-mode.js";
import { resolveAgentRuntimeOptions, runWithAgentRuntimeOptions, validateAgentRuntimeOptions, type AgentRuntimeOptions } from "../session/runtime-options.js";
import type { Terminal } from "../session/turn-state.js";
import { SchemaMismatchError, SessionLockedError } from "../session/session-store.js";
import type { SlashCommandAppStateBridge } from "../commands/types.js";
import type { ResolveDaemonToolCallParams } from "../commands/resolve.js";
import type { ProviderModelSelectionOutcome } from "../contracts/provider-model-selection.js";
import { ConfigStore } from "../config/store.js";
import { resolveAgencHome, resolveWorkspace as resolveWorkspaceFromEnv } from "../config/env.js";
import { snapshotProviderEnvironment } from "../llm/provider-options.js";
import { captureSecureStorageIngress } from "../utils/secureStorage/home.js";
import { logForDebugging } from "../utils/debug.js";
import { recentOomSnapshotNotice, startHeapWatchdog } from "../services/heapWatchdog/heapWatchdog.js";
import type { AgenCConfig } from "../config/schema.js";
import type { PreparedTurnRuntimeInputs, RunSingleTurnOpts } from "./local-turn-runtime.js";
import { clearSystemPromptSections } from "../prompts/sections.js";
import { resolveLatestSessionId, resolveResumeSessionId, reproveResumeSessionAfterDaemonReady, type ResolvedResumeSession } from "./resume-session.js";
import { formatAgenCDaemonCliHelpText, parseAgenCDaemonCliArgs, runAgenCDaemonCli } from "../app-server/daemon-control.js";
import { captureRemoteCliRuntimeContext, formatAgenCRemoteCliHelpText, parseAgenCRemoteCliArgs, runAgenCRemoteCli } from "./remote-cli.js";
import { parseAgenCDaemonProxyCliArgs, runAgenCDaemonProxyCli } from "./daemon-proxy-cli.js";
import { createConnectedAgenCJsonLineDaemonTuiClient, defaultEnsureDaemonReady, formatAgenCAgentCliHelpText, parseAgenCAgentCliArgs, resolveAgenCAgentAttachCwd, resolveAgenCAgentAttachRoleWorkspace, runAgenCAgentCli } from "../app-server/agent-cli.js";
import { applyDaemonTuiRuntimeSettingsAuthority, createAgenCDaemonOnlyTuiContext, findAgenCDaemonAgentBySessionId, listAgenCDaemonAgents, resumeAgenCDaemonPromptAgent, startAgenCDaemonPromptAgent, stopAgenCDaemonPromptAgent, type AgenCDaemonOnlyTuiSession } from "../app-server-client/index.js";
import { emitLocalTuiEvent, emitLocalTuiPhaseEvent, emitLocalTuiSlashResult } from "./tui-local-events.js";
import type { AgentCreateParams, AgentSummary, AgenCDaemonKnownMethod, AgenCDaemonKnownResultByMethod, JsonObject, MessageContentBlock } from "../app-server/protocol/index.js";
import { formatAgenCAuthCliHelpText, parseAgenCAuthCliArgs, runAgenCAuthCli } from "./auth-cli.js";
import { formatOpenAiAuthCliHelpText, parseOpenAiAuthCliArgs, runOpenAiAuthCli } from "./openai-auth-cli.js";
import { formatGrokAuthCliHelpText, parseGrokAuthCliArgs, runGrokAuthCli } from "./grok-auth-cli.js";
import { formatOpenAiModelsCliHelpText, parseOpenAiModelsCliArgs, runOpenAiModelsCli } from "./openai-models-cli.js";
import { formatKimiModelsCliHelpText, parseKimiModelsCliArgs, runKimiModelsCli } from "./kimi-models-cli.js";
import { formatAgenCMcpCliHelpText, parseAgenCMcpCliArgs } from "./mcp-cli-args.js";
import { formatAgenCDoctorCliHelpText, parseAgenCDoctorCliArgs } from "./doctor-cli-args.js";
import { formatAgenCOnboardCliHelpText, parseAgenCOnboardCliArgs, readOnboardDaemonStatus, runAgenCOnboardCli } from "./onboard-cli.js";
import { buildSecurityAuditReport, formatAgenCSecurityCliHelpText, formatSecurityAuditSummaryLine, parseAgenCSecurityCliArgs, runAgenCSecurityCli } from "./security-cli.js";
import { formatAgenCUpdateCliHelpText, parseAgenCUpdateCliArgs, runAgenCUpdateCli } from "./update-cli.js";
import { formatAgenCGatewayCliHelpText, parseAgenCGatewayCliArgs, runAgenCGatewayCli } from "./gateway-cli.js";
import { formatAgenCBudgetCliHelpText, parseAgenCBudgetCliArgs, runAgenCBudgetCli } from "./budget-cli.js";
import { formatAgenCRunCliHelpText, parseAgenCRunCliArgs, runAgenCRunCli } from "./run-cli.js";
import { formatAgenCInitCliHelpText, parseAgenCInitCliArgs, runAgenCInitCli } from "./init-cli.js";
import { formatAgenCProvidersCliHelpText, parseAgenCProvidersCliArgs, runAgenCProvidersCli } from "./providers-cli.js";
import { formatAgenCConfigCliHelpText, parseAgenCConfigCliArgs, runAgenCConfigCli } from "./config-cli.js";
import { formatAgenCPluginCliHelpText, parseAgenCPluginCliArgs, runAgenCPluginCli } from "../plugins/cli/pluginCliCommands.js";
import { formatAgenCSkillsCliHelpText, parseAgenCSkillsCliArgs } from "../skills/skills-cli-args.js";
import { formatAgenCPermissionsCliHelpText, parseAgenCPermissionsCliArgs, runAgenCPermissionsCli } from "../permissions/permission-cli.js";
import { USER_ADDRESSABLE_PERMISSION_MODES } from "../permissions/types.js";
import { formatAgenCStateCliHelpText, parseAgenCStateCliArgs, runAgenCStateCli } from "./state-cli.js";
import { createRecoveryMutationAdapter } from "../state/recovery-mutations.js";
import { formatAgenCTrajectoriesCliHelpText, parseAgenCTrajectoriesCliArgs } from "./trajectories-cli-args.js";
import { prepareUserPromptForTurn } from "../hooks/user-prompt-ingress.js";
import { readStartupCliFlags, resolveCanonicalStartupSelection, resolvedStartupProfileName, startupConfigLayerOptions, type StartupCliFlags } from "./startup-selection.js";
import { resolveStartupSandboxBypass, writeStartupSandboxBypassNotice } from "./bypass-approvals.js";
import { setIsRemoteMode } from "../bootstrap/state.js";
import { isRecord } from "../utils/record.js";
import type { AgenCTuiBridgeSession } from "../tui/daemon-session.js";
import { createWorkflowApprovalControls, type WorkflowApprovalControls } from "../tui/workflow-approval-controls.js";
import { oneShotCLI as runDaemonOneShotCLI, type AgenCDaemonCliDeps, startupImageMessagesFromInputs, startupContentFromInputs, validateAgencHome, stopDaemonAgentBestEffort, type OneShotDeadlineBackstopGlobal, startupPermissionMode } from "./daemon-one-shot-cli.js";
export { parseStreamJsonPrompt, validateAgencHome, oneShotFinalMessageRemainder, type PrintModeGoal, parsePrintModeGoal } from "./daemon-one-shot-cli.js";

export { resolveCliCwdForStartup } from "./cli-cwd.js";

export { runProjectTrustPreflightForTui } from "./project-trust-preflight.js";

export type { ProjectTrustPreflightOptions, ProjectTrustPreflightResult } from "./project-trust-preflight.js";

export { initializeCliRuntime } from "./cli-runtime.js";

export { formatUnavailableCliCwdMessage, isUnavailableCliCwdError } from "./cli-process-main.js";

export { shouldRunDaemonStartupSecurityAudit } from "./daemon-entry-policy.js";


const DEFAULT_DAEMON_CLI_DEPS: AgenCDaemonCliDeps = {
  startPromptAgent: startAgenCDaemonPromptAgent,
  resumePromptAgent: resumeAgenCDaemonPromptAgent,
  stopPromptAgent: stopAgenCDaemonPromptAgent,
  createConnectedTuiClient: createConnectedAgenCJsonLineDaemonTuiClient,
  findAgentBySessionId: findAgenCDaemonAgentBySessionId,
  createTuiContext: createAgenCDaemonOnlyTuiContext,
  ensureDaemonReady: defaultEnsureDaemonReady,
  resumeTui: (args: ResumeTUIArgs, startupCliFlags?: StartupCliFlags) =>
    resumeTUIEntry(args, startupCliFlags),
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


export { sessionConfigurationFromAgenCConfig } from "../session/configuration.js";


export function formatCliHelpText(): string {
  return [
    "Usage: agenc [options] [PROMPT]",
    "       agenc -p|--print [options] [PROMPT]",
    "       agenc help [command]",
    "       agenc onboard [--status [--json] | --reset]",
    "       agenc update [--check] [--json]",
    "       agenc security audit [--json] [--fix]",
    "       agenc gateway <status|pairing> [args]",
    "       agenc budget <status|reset> [args]",
    "       agenc run <start|status|result|replay|evidence|cancel> [<run-id>] [options]",
    "       agenc init [--force]",
    "       agenc <login|logout|whoami>",
    "       agenc account-access --json",
    "       agenc <openai-login|openai-logout|openai-auth-status> [--json]",
    "       agenc <grok-login|grok-logout|grok-auth-status> [--json]",
    "       agenc openai-models [--json]",
    "       agenc kimi-models [--json]",
    "       agenc providers [--json] [--no-local-check]",
    "       agenc config <command> [args]",
    "       agenc plugin <command> [options]",
    "       agenc permissions <command>",
    "       agenc state export <agent-id>",
    "       agenc state import",
    "       agenc trajectories export [--format sft|dpo] [--dir <path>] [--out <file>]",
    "       agenc daemon start [--foreground]",
    "       agenc daemon <stop|status|reload|restart>",
    "       agenc doctor [--json | --apparmor-profile]",
    "       agenc remote <on|status|off>",
    "       agenc agent start <objective>",
    "       agenc agent list",
    "       agenc agent attach <id>",
    "       agenc agent stop <id>",
    "       agenc agent logs <id>",
    "       agenc mcp <serve|add|list|get|remove|add-json|add-from-agenc-desktop|approve-project|reset-project-choices|doctor|xaa>",
    "",
    "Commands:",
    "  onboard                                 Set up AgenC: provider, key, theme, first chat",
    "  update                                  Update the runtime to the latest release",
    "  security                                Audit local exposure; --fix applies safe fixes",
    "  gateway                                 Inspect/operate the channel gateway (pairing)",
    "  budget                                  Inspect/operate cost-bounded autonomy",
    "  run                                     Start, inspect, replay, export, or cancel a durable run",
    "  init                                    Create .agenc/config.toml and AGENC.md",
    "  login | logout | whoami                  Manage the configured auth session",
    "  openai-login | openai-logout              Manage OpenAI ChatGPT sign-in",
    "  openai-auth-status                        Inspect OpenAI ChatGPT sign-in",
    "  grok-login | grok-logout                  Manage X / xAI subscription sign-in",
    "  grok-auth-status                          Inspect X / xAI sign-in",
    "  openai-models                             List models the OpenAI credential can reach",
    "  kimi-models                               List native Kimi models the credential can reach",
    "  providers                               Check provider readiness and local health",
    "  config                                  Show, mutate, validate, or edit config.toml",
    "  plugin                                  Manage local plugins and marketplaces",
    "  permissions                             List/update rules or resolve live requests",
    "  state                                   Export or import project state",
    "  trajectories                            Curate exported trajectories into training JSONL",
    "  daemon                                  Manage the local AgenC daemon",
    "  doctor                                  Diagnose installation and runtime readiness",
    "  remote                                  Manage phone remote-control pairing",
    "  agent                                   Start, attach, inspect, or stop background agents",
    "  mcp                                     Manage MCP servers or serve read-only AgenC tools over MCP",
    "  help [command]                          Show top-level or command help",
    "",
    "Options:",
    "  -h, --help                              Show this help text",
    `  --version                                Show version (${VERSION})`,
    "  -p, --print                             Run in headless one-shot print mode",
    "  --full-durability                       Sync every print-run commit (safe continuation after a crash)",
    "  --output-format <format>                 Print mode output: text, json, or stream-json",
    "  --input-format <format>                  Print mode input: stream-json",
    "  --deadline <+seconds|ISO-8601>           Print mode: stop the run by this time (exit 5)",
    "  --deadline-reserve <seconds>             Print mode: time before the deadline to wrap up",
    "  --no-tui                                 Force one-shot CLI mode",
    "  --bare                                   Run reduced startup and suppress all session hook extensions",
    "  --light                                  Experimental: start with core tools and discover more",
    "  -c, --continue                           Continue the latest project session",
    "  -r, --resume <session-id>                Resume a prior project session in the TUI",
    "  --profile <name>                         Use a named config profile",
    "  --config <path>                          Load an explicit config.toml layer",
    "  --provider <name>                        Override provider for this session",
    "  --model <id|provider:id>                 Override model for this session",
    "  --permission-mode <mode>                 Override the startup permission mode",
    "  --autonomous                             Enable autonomous tick mode",
    "  --bypass-approvals                       Skip approval prompts, sandbox escalation requests",
    "                                           included; commands start in the OS sandbox",
    "  --dangerously-bypass-approvals-and-sandbox",
    "                                           Bypass approvals and sandbox checks",
    "  --image <file|url|data-url>              Attach a startup image",
    "",
    "Examples:",
    "  agenc",
    "  agenc init",
    '  agenc "summarize this repository"',
    '  agenc --no-tui "run the tests and report failures"',
    "  agenc --resume <session-id>",
    '  agenc agent start "fix the failing parser test"',
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
    case "account-access":
      return formatAgenCAuthCliHelpText();
    case "openai-login":
    case "openai-logout":
    case "openai-auth-status":
    case "chatgpt-login":
    case "chatgpt-logout":
    case "chatgpt-auth-status":
      return formatOpenAiAuthCliHelpText();
    case "grok-login":
    case "grok-logout":
    case "grok-auth-status":
    case "xai-login":
    case "xai-logout":
    case "xai-auth-status":
      return formatGrokAuthCliHelpText();
    case "openai-models":
      return formatOpenAiModelsCliHelpText();
    case "kimi-models":
      return formatKimiModelsCliHelpText();
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
    case "update":
      return formatAgenCUpdateCliHelpText();
    case "gateway":
      return formatAgenCGatewayCliHelpText();
    case "budget":
      return formatAgenCBudgetCliHelpText();
    case "run":
      return formatAgenCRunCliHelpText();
    case "permissions":
      return formatAgenCPermissionsCliHelpText();
    case "plugin":
    case "plugins":
      return formatAgenCPluginCliHelpText();
    case "skills":
      return formatAgenCSkillsCliHelpText();
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
  const shortCircuitFlag = startupShortCircuitFlag(argv);
  if (shortCircuitFlag === "help") {
    return { kind: "help", text: formatCliHelpText() };
  }
  if (shortCircuitFlag === "version") {
    return { kind: "version", text: `agenc ${VERSION}` };
  }
  return null;
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
      { mcpManager?: Session["services"]["mcpManager"] } | undefined
  )?.mcpManager?.refreshFromAuthority;
  if (params.session && typeof refreshMcp === "function") {
    try {
      const result = await refreshMcp.call(params.session.services.mcpManager);
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
export type { RunSingleTurnOpts, PreparedTurnRuntimeInputs } from "./local-turn-runtime.js";


/** Compatibility seam: ordinary daemon-backed startup does not load local execution. */
export async function* runSingleTurn(
  opts: RunSingleTurnOpts,
): AsyncGenerator<PhaseEvent, Terminal | undefined> {
  const runtime = await import("./local-turn-runtime.js");
  return yield* runtime.runSingleTurn(opts, maybeReloadConfigBetweenTurns);
}


export async function prepareTurnRuntimeInputs(
  params: Parameters<typeof import("./local-turn-runtime.js").prepareTurnRuntimeInputs>[0],
): Promise<PreparedTurnRuntimeInputs> {
  const runtime = await import("./local-turn-runtime.js");
  return runtime.prepareTurnRuntimeInputs(params);
}


function resolveUserHome(
  env: NodeJS.ProcessEnv = process.env,
  fallback: string = readProcessCwdSafely() ?? ".",
): string {
  return env.HOME ?? env.USERPROFILE ?? fallback;
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
      const userStopGenerationToRelease = submitOpts?.source === "user"
        ? params.session.userStopGeneration
        : undefined;
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
        Extract<PhaseEvent, { type: "turn_complete" }>["stopReason"] | null =
        null;
      const runPromptTurn = async (
        prompt: string | readonly LLMContentPart[],
        opts: {
          readonly displayInput?: string | null;
        } = {},
      ): Promise<void> => {
        const preparedPrompt = await prepareUserPromptForTurn({
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
          userStopGenerationToRelease,
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
        autonomousKeepalive.setContextBlocked(
          lastTurnStopReason === "error" ||
            lastTurnStopReason === "compact_failed",
        );
      };

      const shouldScheduleNextAutonomousTick = (): boolean => {
        if (!completedPromptTurn) return false;
        if (lastTurnStopReason !== "completed") return false;
        if (!autonomousKeepalive.isActive()) return false;
        if (!isAutonomousTick) return true;
        if (lastTurnToolNames.has("Sleep")) return true;
        const activeToolNames = [...lastTurnToolNames].filter(
          (name) => name !== "SendUserMessage",
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
          params.session as Session & {
            appStateBridge?: SlashCommandAppStateBridge;
          }
        ).appStateBridge;
        const { runSlashCommand } = await import("./slash.js");
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


/** Test seam: shorten the one-shot deadline backstop (null restores it). */
export function setOneShotDeadlineBackstopForTests(
  timing: { afterDeadlineMs: number; settleMs: number } | null,
): void {
  (globalThis as OneShotDeadlineBackstopGlobal).__agencOneShotDeadlineBackstop = timing;
}


// ─────────────────────────────────────────────────────────────────────
// TUI entry adapters
// ─────────────────────────────────────────────────────────────────────

/**
 * Load `tui/main.js` via dynamic import so the main `tsconfig.json`
 * (which excludes `src/tui/**`) can still typecheck `bin/agenc.ts`.
 * The TUI module itself is compiled through `tsconfig.tui.json`.
 */
async function loadBootTUI(): Promise<
  (opts: {
    session: unknown;
    model?: string;
    initialPrompt?: string;
    initialComposerText?: string;
    initialUserMessages?: readonly LLMMessage[];
    stdinMode?: "readable" | "data";
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
      model?: string;
      initialPrompt?: string;
      initialComposerText?: string;
      initialUserMessages?: readonly LLMMessage[];
      stdinMode?: "readable" | "data";
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
export async function exitOrResumeAfterTui(
  exitCode: number,
  startupCliFlags?: StartupCliFlags,
): Promise<number> {
  const resumeId = await consumePendingResumeSessionId();
  if (resumeId === null) return exitCode;
  return daemonCliDeps().resumeTui({ resumeId }, startupCliFlags);
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
    agentId?: string;
    conversationId?: string;
    transcriptSnapshot?: import("../app-server/protocol/index.js").SessionTranscriptV2Result;
    clientId: string;
    runtimeSettingsCursor: { readonly eventId: string; readonly cwd: string };
  }) => Promise<unknown>
> {
  const mod = (await import("../tui/daemon-session.js")) as {
    readonly createDaemonTuiSession: (opts: {
      baseSession: unknown;
      client: unknown;
      sessionId: string;
      agentId?: string;
      conversationId?: string;
      transcriptSnapshot?: import("../app-server/protocol/index.js").SessionTranscriptV2Result;
      clientId: string;
      runtimeSettingsCursor: {
        readonly eventId: string;
        readonly cwd: string;
      };
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
    const mod = (await import("../utils/earlyInput.js")) as EarlyInputCapture;
    mod.startCapturingEarlyInput?.();
    return () => mod.consumeEarlyInput?.({ restoreRawMode: true }) ?? "";
  } catch {
    return () => "";
  }
}


function messageContentBlocksFromUnknown(
  input: unknown,
): MessageContentBlock[] {
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


type TuiSessionShape = Pick<
  AgenCTuiBridgeSession,
  "listDaemonSessionProcesses" | "stopDaemonSessionProcess" | "updateDaemonSessionGoal"
> & {
  readonly workflowApprovalControls?: WorkflowApprovalControls;
  executeShellCommand?: AgenCTuiBridgeSession["executeShellCommand"];
  executeDaemonStatusLine?: AgenCTuiBridgeSession["executeDaemonStatusLine"];
  readonly services?: {
    readonly mcpManager?: NonNullable<Session["services"]["mcpManager"]>;
    readonly [key: string]: unknown;
  };
  submit?: (message: string, opts?: SessionSubmitOptions) => Promise<void>;
  enqueueIdleInput?: (input: unknown, ownership?: IdleInputOwnership) => number;
  enqueueIdleInputBatch?: (
    inputs: readonly unknown[],
    ownership?: IdleInputOwnership,
  ) => number;
  enqueueIdleInputBatchOwned?: (
    inputs: readonly unknown[],
    ownership?: IdleInputOwnership,
  ) => IdleInputAdmission;
  rollbackIdleInputAdmission?: (token: string) => boolean;
  commitIdleInputAdmission?: (token: string) => boolean;
  subscribeToEvents?: (cb: (event: unknown) => void) => () => void;
  emit?: (event: unknown) => void;
  emitPhaseEvent?: (event: PhaseEvent) => void;
  cancelActiveTurn?: (reason?: string) => Promise<void>;
  clearDaemonSession?: () => Promise<void>;
  resolveDaemonToolCall?: (
    params: ResolveDaemonToolCallParams,
  ) => Promise<unknown>;
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
  applyProviderModelSelection?: (selection: {
    readonly provider: string;
    readonly model: string;
  }) => Promise<ProviderModelSelectionOutcome>;
  setDaemonPermissionMode?: (mode: string) => Promise<unknown>;
  getDaemonHooksStatus?: () => Promise<unknown>;
  setDaemonHooksDisabled?: (disabled: boolean) => Promise<unknown>;
  applyDaemonConfig?: (params: {
    profile?: string;
    reload?: boolean;
  }) => Promise<unknown>;
  getInitialTranscriptEvents?: () => readonly unknown[];
  listMcpClients?: () => readonly unknown[];
  listMcpTools?: () => readonly unknown[];
  mcpSurfaceSnapshot?: () => McpSurfaceSnapshot;
  refreshMcpSurface?: () => Promise<McpSurfaceSnapshot>;
  subscribeToMcpSurface?: (
    cb: (snapshot: McpSurfaceSnapshot) => void,
  ) => () => void;
  activeTurn?: {
    unsafePeek?: () => { readonly turnId: string } | null;
  } | null;
};


function requireTuiSessionConfigStore(session: unknown): ConfigStore {
  if (!isRecord(session) || !isRecord(session.services)) {
    throw new Error("TUI session is missing its canonical ConfigStore");
  }
  const configStore = session.services.configStore;
  if (!(configStore instanceof ConfigStore)) {
    throw new Error("TUI session is missing its canonical ConfigStore");
  }
  return configStore;
}


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
  const { runSlashCommand } = await import("./slash.js");
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
  readonly deps: AgenCDaemonCliDeps;
  readonly agencHome: string;
  readonly env: NodeJS.ProcessEnv;
  readonly runtimeOptions: AgentRuntimeOptions;
  readonly cwd: string;
  readonly clientId: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly configPath?: string;
  readonly addDirs?: readonly string[];
  readonly preparePrompt?: typeof prepareDaemonTuiPrompt;
  readonly permissionMode?: AgentCreateParams["permissionMode"];
}): Promise<{
  readonly session: unknown;
  readonly close: () => Promise<void>;
}> {
  const configStore = requireTuiSessionConfigStore(params.baseSession);
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
  let liveAgentId: string | null = null;
  // Awaiting-first-turn tracks whether a turn-free prediction startup still
  // needs its first submission. Startup-deferred lasts longer: Editor turns
  // consume that first-submission slot without activating ordinary Agent
  // lifecycle hooks, so the TUI must continue owning daemon teardown.
  let liveSessionAwaitingFirstTurn = false;
  let liveSessionStartupDeferred = false;
  let daemonClient: Awaited<
    ReturnType<typeof createConnectedAgenCJsonLineDaemonTuiClient>
  > | null = null;
  type ConnectedDaemonTuiClient = Awaited<
    ReturnType<typeof createConnectedAgenCJsonLineDaemonTuiClient>
  >;
  type DaemonControlClient = Omit<
    ConnectedDaemonTuiClient,
    "request"
  > & {
    request<Method extends AgenCDaemonKnownMethod>(
      method: Method,
      params?: JsonObject,
      options?: { readonly signal?: AbortSignal },
    ): Promise<AgenCDaemonKnownResultByMethod[Method]>;
  };
  let daemonControlClient: DaemonControlClient | null = null;
  let daemonControlClientPromise: Promise<DaemonControlClient> | null =
    null;
  let deferredSessionClosed = false;
  const MAX_DEFERRED_QUEUED_INPUTS = 512;
  const MAX_DEFERRED_QUEUED_INPUT_BYTES = 16 * 1_024 * 1_024;
  type DeferredQueuedInput = {
    readonly blocks: readonly MessageContentBlock[];
    readonly bytes: number;
    readonly ownership?: IdleInputOwnership;
  };
  const queuedInputs: DeferredQueuedInput[] = [];
  let queuedInputCount = 0;
  let queuedInputBytes = 0;
  let nextQueuedInputSequence = 0;
  let inFlightQueuedInputs: ReadonlySet<DeferredQueuedInput> | null = null;
  const idleInputAdmissions = new Map<
    string,
    {
      readonly entries: readonly DeferredQueuedInput[];
      readonly inputCount: number;
      readonly bytes: number;
    }
  >();
  const liveInputAdmissions = new Map<
    string,
    | {
        readonly state: "pending";
        readonly origin: TuiSessionShape;
        readonly originToken: string;
      }
    | {
        readonly state: "settled";
        readonly rollbackResult: boolean;
      }
  >();
  const subscribers = new Set<(event: unknown) => void>();
  const liveUnsubscribers = new Map<(event: unknown) => void, () => void>();
  const mcpSurfaceSubscribers = new Set<
    (snapshot: McpSurfaceSnapshot) => void
  >();
  const liveMcpSurfaceUnsubscribers = new Map<
    (snapshot: McpSurfaceSnapshot) => void,
    () => void
  >();
  const lastMcpSurfaceSignatures = new Map<
    (snapshot: McpSurfaceSnapshot) => void,
    string
  >();
  const emptyMcpSurface: McpSurfaceSnapshot = Object.freeze({
    revision: 0,
    servers: Object.freeze([]),
    tools: Object.freeze([]),
  });

  type DeferredMcpManager = NonNullable<Session["services"]["mcpManager"]>;

  const currentLiveMcpManager = (): DeferredMcpManager | undefined =>
    liveSession?.services?.mcpManager;

  const noLiveMcpSession = (action: string): Error =>
    new Error(
      `Cannot ${action}: no live daemon session. Send a message first.`,
    );

  const requireLiveMcpManager = (action: string): DeferredMcpManager => {
    if (liveSession === null) throw noLiveMcpSession(action);
    const manager = currentLiveMcpManager();
    if (manager === undefined) {
      throw new Error(
        `Cannot ${action}: the live daemon session has no MCP authority.`,
      );
    }
    return manager;
  };

  const currentMcpSurfaceSnapshot = (): McpSurfaceSnapshot =>
    liveSession?.mcpSurfaceSnapshot?.() ?? emptyMcpSurface;

  const deliverMcpSurfaceSnapshot = (
    subscriber: (snapshot: McpSurfaceSnapshot) => void,
    snapshot: McpSurfaceSnapshot,
  ): void => {
    const signature = JSON.stringify([
      snapshot.revision,
      snapshot.servers,
      snapshot.tools,
    ]);
    if (lastMcpSurfaceSignatures.get(subscriber) === signature) return;
    lastMcpSurfaceSignatures.set(subscriber, signature);
    try {
      subscriber(snapshot);
    } catch {
      // A passive observer cannot interfere with daemon event delivery.
    }
  };

  const refreshCurrentMcpSurface = async (): Promise<McpSurfaceSnapshot> => {
    const live = liveSession;
    if (live === null) return emptyMcpSurface;
    const snapshot =
      (await live.refreshMcpSurface?.()) ??
      live.mcpSurfaceSnapshot?.() ??
      emptyMcpSurface;
    return liveSession === live ? snapshot : currentMcpSurfaceSnapshot();
  };

  const clearLiveMcpSurfaceSubscriptions = (): void => {
    for (const unsubscribe of liveMcpSurfaceUnsubscribers.values()) {
      try {
        unsubscribe();
      } catch {
        // Subscription cleanup is observational and must stay fail-soft.
      }
    }
    liveMcpSurfaceUnsubscribers.clear();
    lastMcpSurfaceSignatures.clear();
  };

  const attachLiveMcpSurfaceSubscriber = (
    live: TuiSessionShape,
    subscriber: (snapshot: McpSurfaceSnapshot) => void,
    emitCurrent: boolean,
  ): void => {
    try {
      const unsubscribe = live.subscribeToMcpSurface?.((snapshot) => {
        if (liveSession !== live || !mcpSurfaceSubscribers.has(subscriber)) {
          return;
        }
        deliverMcpSurfaceSnapshot(subscriber, snapshot);
      });
      if (unsubscribe !== undefined) {
        liveMcpSurfaceUnsubscribers.set(subscriber, unsubscribe);
      }
    } catch {
      // A passive subscription cannot make an otherwise healthy attach fail.
    }
    if (!emitCurrent || liveSession !== live) return;
    deliverMcpSurfaceSnapshot(
      subscriber,
      live.mcpSurfaceSnapshot?.() ?? emptyMcpSurface,
    );
  };

  const attachLiveMcpSurfaceSubscribers = (live: TuiSessionShape): void => {
    clearLiveMcpSurfaceSubscriptions();
    for (const subscriber of mcpSurfaceSubscribers) {
      attachLiveMcpSurfaceSubscriber(live, subscriber, true);
    }
    void (async () => {
      const refreshed =
        (await live.refreshMcpSurface?.()) ??
        live.mcpSurfaceSnapshot?.() ??
        emptyMcpSurface;
      if (liveSession !== live) return;
      for (const subscriber of mcpSurfaceSubscribers) {
        deliverMcpSurfaceSnapshot(subscriber, refreshed);
      }
    })().catch((error: unknown) => {
      logForDebugging(
        `Deferred daemon MCP status refresh failed after attach: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { level: "warn" },
      );
    });
  };

  const coldMcpManager: DeferredMcpManager = {
    effectiveServers: async () => {
      throw noLiveMcpSession("read MCP server status");
    },
    toolPluginProvenance: async () => undefined,
    refreshFromAuthority: async () => {
      const manager = requireLiveMcpManager("refresh MCP authority");
      if (manager.refreshFromAuthority === undefined) {
        throw new Error(
          "Cannot refresh MCP authority: the live daemon session does not support it.",
        );
      }
      return manager.refreshFromAuthority();
    },
    reconnectServer: async (name) => {
      const manager = requireLiveMcpManager(`reconnect MCP server "${name}"`);
      if (manager.reconnectServer === undefined) {
        throw new Error("MCP reconnect is not supported by this session.");
      }
      return manager.reconnectServer(name);
    },
    enableServer: async (name) => {
      const manager = requireLiveMcpManager(`enable MCP server "${name}"`);
      if (manager.enableServer === undefined) {
        throw new Error("MCP enable is not supported by this session.");
      }
      return manager.enableServer(name);
    },
    disableServer: async (name) => {
      const manager = requireLiveMcpManager(`disable MCP server "${name}"`);
      if (manager.disableServer === undefined) {
        throw new Error("MCP disable is not supported by this session.");
      }
      return manager.disableServer(name);
    },
    addServer: async (config) => {
      const manager = requireLiveMcpManager(`add MCP server "${config.name}"`);
      if (manager.addServer === undefined) {
        throw new Error("MCP add is not supported by this session.");
      }
      return manager.addServer(config);
    },
    getTools: () => [],
    getToolsByServer: () => [],
    getConfiguredServers: () => [],
    getConnectionState: () => undefined,
    getConnectedConnection: () => undefined,
    getResources: async () => [],
    getResourcesByServer: async () => [],
    readResource: async () => null,
    isConnected: () => false,
    getConnectedServers: () => [],
    mcpSurfaceSnapshot: currentMcpSurfaceSnapshot,
    subscribeMcpSurfaceInvalidations: (listener) => {
      const subscriber = (snapshot: McpSurfaceSnapshot): void =>
        listener(snapshot.revision);
      mcpSurfaceSubscribers.add(subscriber);
      const live = liveSession;
      if (live !== null) {
        attachLiveMcpSurfaceSubscriber(live, subscriber, false);
      }
      return () => {
        mcpSurfaceSubscribers.delete(subscriber);
        lastMcpSurfaceSignatures.delete(subscriber);
        try {
          liveMcpSurfaceUnsubscribers.get(subscriber)?.();
        } catch {
          // Subscription cleanup is observational and must stay fail-soft.
        }
        liveMcpSurfaceUnsubscribers.delete(subscriber);
      };
    },
  };
  const deferredMcpManager = new Proxy(coldMcpManager, {
    get: (target, property, receiver) => {
      // These two seams belong to the outer wrapper because their listeners
      // must survive live-session replacement. Every other manager member is
      // resolved dynamically from the current daemon-backed facade, which
      // prevents this wrapper from mirroring the MCP API as it evolves.
      if (
        property === "mcpSurfaceSnapshot" ||
        property === "subscribeMcpSurfaceInvalidations"
      ) {
        return Reflect.get(target, property, receiver);
      }
      const manager = currentLiveMcpManager();
      if (manager !== undefined) {
        const value = Reflect.get(manager, property, manager);
        if (value !== undefined) {
          return typeof value === "function" ? value.bind(manager) : value;
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const base = params.baseSession as Record<string, unknown>;
  const daemonSessionBase = { ...base };
  delete daemonSessionBase.listMcpClients;
  delete daemonSessionBase.listMcpTools;
  const baseServices = isRecord(base.services) ? base.services : {};
  const deferredServices = {
    ...baseServices,
    mcpManager: deferredMcpManager,
  };
  const liveBridgeBaseSession = {
    ...base,
    services: deferredServices,
  };

  const queuedBlocksBytes = (
    blocks: readonly MessageContentBlock[],
  ): number => {
    try {
      return Buffer.byteLength(JSON.stringify(blocks), "utf8");
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };

  const admitQueuedInputs = (
    inputs: readonly unknown[],
    owned: boolean,
    ownership?: IdleInputOwnership,
  ): IdleInputAdmission => {
    if (inFlightQueuedInputs !== null) {
      throw new Error(
        "Deferred session startup is in progress; queued input was not accepted.",
      );
    }
    const entries = inputs
      .map((input) => messageContentBlocksFromUnknown(input))
      .filter((blocks) => blocks.length > 0)
      .map((blocks): DeferredQueuedInput => ({
        blocks,
        bytes: queuedBlocksBytes(blocks),
        ...(ownership !== undefined
          ? {
              ownership: { workspaceView: ownership.workspaceView },
            }
          : {}),
      }));
    const inputCount = entries.length;
    const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (
      queuedInputCount + inputCount > MAX_DEFERRED_QUEUED_INPUTS ||
      queuedInputBytes + bytes > MAX_DEFERRED_QUEUED_INPUT_BYTES ||
      (owned &&
        inputCount > 0 &&
        idleInputAdmissions.size >= MAX_DEFERRED_QUEUED_INPUTS)
    ) {
      throw new Error(
        "Session mailbox is full; queued input was not accepted.",
      );
    }
    const firstSequence = inputCount === 0 ? 0 : nextQueuedInputSequence + 1;
    nextQueuedInputSequence += inputCount;
    const lastSequence = inputCount === 0 ? 0 : nextQueuedInputSequence;
    queuedInputs.push(...entries);
    queuedInputCount += inputCount;
    queuedInputBytes += bytes;
    const token =
      inputCount === 0
        ? "deferred-idle:empty"
        : `deferred-idle:${randomUUID()}`;
    if (owned && inputCount > 0) {
      idleInputAdmissions.set(token, {
        entries,
        inputCount,
        bytes,
      });
    }
    return {
      token,
      firstSequence,
      lastSequence,
      count: inputCount,
    };
  };

  const rollbackQueuedInputAdmission = (token: string): boolean => {
    if (token === "deferred-idle:empty") return true;
    const admission = idleInputAdmissions.get(token);
    if (admission === undefined) return false;
    if (
      inFlightQueuedInputs !== null &&
      admission.entries.some((entry) => inFlightQueuedInputs?.has(entry))
    ) {
      return false;
    }
    const indexes = admission.entries.map((entry) =>
      queuedInputs.indexOf(entry),
    );
    if (
      indexes.some((index) => index < 0) ||
      new Set(indexes).size !== indexes.length
    ) {
      idleInputAdmissions.delete(token);
      return false;
    }
    for (const index of [...indexes].sort((left, right) => right - left)) {
      queuedInputs.splice(index, 1);
    }
    queuedInputCount -= admission.inputCount;
    queuedInputBytes -= admission.bytes;
    idleInputAdmissions.delete(token);
    return true;
  };

  const commitQueuedInputAdmission = (token: string): boolean => {
    if (token === "deferred-idle:empty") return true;
    const admission = idleInputAdmissions.get(token);
    if (admission === undefined) return false;
    if (
      inFlightQueuedInputs !== null &&
      admission.entries.some((entry) => inFlightQueuedInputs?.has(entry))
    ) {
      return false;
    }
    idleInputAdmissions.delete(token);
    return true;
  };

  const queuedInputsForSubmission = (): DeferredQueuedInput[] => [
    ...queuedInputs,
  ];

  const ensureDaemonControlClient =
    (): Promise<DaemonControlClient> => {
      if (deferredSessionClosed) {
        return Promise.reject(
          new Error("Deferred TUI session is already closed."),
        );
      }
      if (daemonControlClient !== null) {
        return Promise.resolve(daemonControlClient);
      }
      if (daemonControlClientPromise !== null) {
        return daemonControlClientPromise;
      }
      const pending = (async () => {
        const client = (await params.deps.createConnectedTuiClient({
          env: params.env,
        })) as unknown as DaemonControlClient;
        if (deferredSessionClosed) {
          await client.close().catch(() => {
            /* best effort */
          });
          throw new Error("Deferred TUI session is already closed.");
        }
        daemonControlClient = client;
        return client;
      })();
      daemonControlClientPromise = pending;
      void pending.catch(() => {
        if (daemonControlClientPromise === pending) {
          daemonControlClientPromise = null;
        }
      });
      return pending;
    };

  const detachLiveSession = async (): Promise<void> => {
    for (const unsubscribe of liveUnsubscribers.values()) unsubscribe();
    liveUnsubscribers.clear();
    const hadLiveSession = liveSession !== null;
    clearLiveMcpSurfaceSubscriptions();
    liveSession = null;
    liveAgentId = null;
    liveSessionAwaitingFirstTurn = false;
    liveSessionStartupDeferred = false;
    if (hadLiveSession && !deferredSessionClosed) {
      for (const subscriber of mcpSurfaceSubscribers) {
        try {
          subscriber(emptyMcpSurface);
        } catch {
          // A passive status observer cannot interfere with detach/recovery.
        }
      }
    }
    const client = daemonClient;
    daemonClient = null;
    await client?.close().catch(() => {
      /* best effort */
    });
  };

  const ensureLiveSession = async (
    firstMessage: string,
    firstSubmitOptions?: SessionSubmitOptions,
    deferInitialTurn = false,
  ): Promise<TuiSessionShape | null> => {
    if (deferredSessionClosed) {
      throw new Error("Deferred TUI session is already closed.");
    }
    if (liveSession !== null) return liveSession;
    if (liveSessionPromise !== null) return liveSessionPromise;
    const startupPromise = (async () => {
      const submittedQueuedInputs = deferInitialTurn
        ? []
        : queuedInputsForSubmission();
      const submittedInputCount = submittedQueuedInputs.length;
      const submittedInputBytes = submittedQueuedInputs.reduce(
        (sum, entry) => sum + entry.bytes,
        0,
      );
      inFlightQueuedInputs =
        submittedQueuedInputs.length > 0
          ? new Set(submittedQueuedInputs)
          : null;
      let preparedFirstMessage: string | null;
      try {
        preparedFirstMessage = deferInitialTurn
          ? ""
          : firstMessage.length > 0
            ? await (params.preparePrompt ?? prepareDaemonTuiPrompt)({
                  message: firstMessage,
                  configStore,
                  agencHome: params.agencHome,
                  cwd: params.cwd,
                  env: params.env,
                  stderr: process.stderr,
                })
            : firstMessage;
      } catch (error) {
        inFlightQueuedInputs = null;
        throw error;
      }
      if (deferredSessionClosed) {
        inFlightQueuedInputs = null;
        throw new Error("Deferred TUI session is already closed.");
      }
      if (preparedFirstMessage === null) {
        inFlightQueuedInputs = null;
        throw new Error(
          "Prompt preparation did not produce a model submission; pending input was not consumed.",
        );
      }
      const content: MessageContentBlock[] = [
        ...submittedQueuedInputs.flatMap((entry) => entry.blocks),
        ...(preparedFirstMessage.length > 0
          ? [{ type: "text" as const, text: preparedFirstMessage }]
          : []),
      ];
      if (!deferInitialTurn && content.length === 0) {
        inFlightQueuedInputs = null;
        return null;
      }
      const prompt = deferInitialTurn
        ? "AgenC Editor workspace"
        : preparedFirstMessage.trim().length > 0
          ? preparedFirstMessage
          : "Multimodal AgenC startup";
      let startedAgentId: string | null = null;
      // Propagate --dangerously-bypass-approvals-and-sandbox from the user's argv into the daemon-spawned
      // agent's session config so the deferred TUI mirrors the bootTUI
      // path. See GAP-PE-GUARDIAN-YOLO-LEAK.
      const isBypassDeferred = params.permissionMode === "bypassPermissions";
      let startupClient: ConnectedDaemonTuiClient | null = null;
      try {
        const started = await params.deps.startPromptAgent({
          prompt,
          env: params.env,
          runtimeOptions: params.runtimeOptions,
          cwd: params.cwd,
          ...(pendingModel !== undefined ? { model: pendingModel } : {}),
          ...(pendingProvider !== undefined
            ? { provider: pendingProvider }
            : {}),
          ...(pendingProfile !== undefined ? { profile: pendingProfile } : {}),
          ...(params.configPath !== undefined
            ? { configPath: params.configPath }
            : {}),
          ...(params.addDirs !== undefined
            ? { addDirs: params.addDirs }
            : {}),
          ...(deferInitialTurn
            ? { deferInitialTurn: true }
            : {
                initialContent:
                  content.length === 1 && content[0]?.type === "text"
                    ? content[0].text
                    : content,
              }),
          ...(firstSubmitOptions?.displayUserMessage !== undefined
            ? {
                initialDisplayUserMessage:
                  firstSubmitOptions.displayUserMessage,
              }
            : {}),
          // Pre-first-turn `/permissions mode` / `/plan` stage their choice in
          // `pendingPermissionMode`; an explicit `--dangerously-bypass-approvals-and-sandbox` argv still wins so the
          // bootTUI-parity bypass behavior is preserved.
          ...(isBypassDeferred
            ? { permissionMode: "bypassPermissions" as const }
            : pendingPermissionMode !== undefined
              ? { permissionMode: pendingPermissionMode }
              : {}),
          metadata: { mode: "tui" },
        });
        startedAgentId = started.agentId;
        if (deferredSessionClosed) {
          throw new Error("Deferred TUI session is already closed.");
        }
        startupClient = await params.deps.createConnectedTuiClient({
          env: params.env,
        });
        daemonClient = startupClient;
        if (deferredSessionClosed) {
          throw new Error("Deferred TUI session is already closed.");
        }
        const attachment = await startupClient.request("agent.attach", {
          agentId: started.agentId,
          clientId: params.clientId,
        });
        if (deferredSessionClosed) {
          throw new Error("Deferred TUI session is already closed.");
        }
        const sessionId = attachment.sessionIds[0];
        if (sessionId === undefined) {
          throw new Error(
            `daemon agent has no attached session: ${started.agentId}`,
          );
        }
        const createDaemonTuiSession = await loadCreateDaemonTuiSession();
        if (deferredSessionClosed) {
          throw new Error("Deferred TUI session is already closed.");
        }
        await applyDaemonTuiRuntimeSettingsAuthority(
          liveBridgeBaseSession as unknown as AgenCDaemonOnlyTuiSession,
          params.cwd,
          attachment.runtimeSettings,
        );
        liveSession = wrapDaemonTuiSessionWithPromptPreparation(
          (await createDaemonTuiSession({
            baseSession: liveBridgeBaseSession,
            client: startupClient,
            sessionId,
            agentId: started.agentId,
            conversationId:
              attachment.runtimeSessionId ?? attachment.agentId ?? sessionId,
            clientId: params.clientId,
            runtimeSettingsCursor: {
              eventId: attachment.runtimeSettingsEventId,
              cwd: params.cwd,
            },
          })) as TuiSessionShape,
          {
            agencHome: params.agencHome,
            cwd: params.cwd,
            env: params.env,
            stderr: process.stderr,
          },
        );
        liveAgentId = started.agentId;
        liveSessionAwaitingFirstTurn = deferInitialTurn;
        liveSessionStartupDeferred = deferInitialTurn;
        if (deferredSessionClosed) {
          throw new Error("Deferred TUI session is already closed.");
        }
        const submittedIndexes = submittedQueuedInputs.map((entry) =>
          queuedInputs.indexOf(entry),
        );
        if (
          submittedIndexes.some((index) => index < 0) ||
          new Set(submittedIndexes).size !== submittedIndexes.length
        ) {
          throw new Error(
            "Deferred queued-input ownership changed during session startup.",
          );
        }
        for (const index of [...submittedIndexes].sort(
          (left, right) => right - left,
        )) {
          queuedInputs.splice(index, 1);
        }
        queuedInputCount -= submittedInputCount;
        queuedInputBytes -= submittedInputBytes;
        inFlightQueuedInputs = null;
        for (const subscriber of subscribers) {
          const unsubscribe = liveSession.subscribeToEvents?.(subscriber);
          if (unsubscribe !== undefined) {
            liveUnsubscribers.set(subscriber, unsubscribe);
          }
        }
        attachLiveMcpSurfaceSubscribers(liveSession);
        return liveSession;
      } catch (error) {
        inFlightQueuedInputs = null;
        for (const unsubscribe of liveUnsubscribers.values()) unsubscribe();
        liveUnsubscribers.clear();
        clearLiveMcpSurfaceSubscriptions();
        liveSession = null;
        liveAgentId = null;
        liveSessionAwaitingFirstTurn = false;
        liveSessionStartupDeferred = false;
        if (daemonClient === startupClient) daemonClient = null;
        if (startedAgentId !== null) {
          await stopDaemonAgentBestEffort({
            deps: params.deps,
            daemonClient: startupClient,
            env: params.env,
            agentId: startedAgentId,
            reason: "tui_startup_failed",
          });
        }
        await startupClient?.close().catch(() => {
          /* best effort */
        });
        throw error;
      }
    })();
    liveSessionPromise = startupPromise;
    try {
      return await startupPromise;
    } finally {
      if (liveSessionPromise === startupPromise) liveSessionPromise = null;
    }
  };

  const submitToDeferredFirstTurn = async (
    message: string,
    opts?: SessionSubmitOptions,
    activatesAgentStartup = false,
  ): Promise<void> => {
    const submissionSession = liveSession;
    if (
      submissionSession === null ||
      typeof submissionSession.submit !== "function"
    ) {
      throw new Error("Deferred daemon session is not ready for submission.");
    }
    const completesDeferredFirstTurn = liveSessionAwaitingFirstTurn;
    const submittedQueuedInputs = queuedInputsForSubmission();
    const submittedInputCount = submittedQueuedInputs.length;
    const submittedInputBytes = submittedQueuedInputs.reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    );
    const migratedAdmissionTokens: string[] = [];
    if (submittedQueuedInputs.length > 0) {
      const admit = submissionSession.enqueueIdleInputBatchOwned;
      if (typeof admit !== "function") {
        throw new Error(
          "The live daemon session cannot safely accept deferred input.",
        );
      }
      inFlightQueuedInputs = new Set(submittedQueuedInputs);
      try {
        for (const entry of submittedQueuedInputs) {
          const admission = admit.call(
            submissionSession,
            [
              {
                role: "user",
                content: entry.blocks,
              },
            ],
            entry.ownership,
          );
          migratedAdmissionTokens.push(admission.token);
        }
      } catch (error) {
        for (const token of migratedAdmissionTokens.reverse()) {
          submissionSession.rollbackIdleInputAdmission?.(token);
        }
        inFlightQueuedInputs = null;
        throw error;
      }
    }
    try {
      await submissionSession.submit(message, opts);
      const submittedIndexes = submittedQueuedInputs.map((entry) =>
        queuedInputs.indexOf(entry),
      );
      if (
        submittedIndexes.some((index) => index < 0) ||
        new Set(submittedIndexes).size !== submittedIndexes.length
      ) {
        throw new Error(
          "Deferred queued-input ownership changed during first submission.",
        );
      }
      for (const index of [...submittedIndexes].sort(
        (left, right) => right - left,
      )) {
        queuedInputs.splice(index, 1);
      }
      queuedInputCount -= submittedInputCount;
      queuedInputBytes -= submittedInputBytes;
      if (completesDeferredFirstTurn) {
        liveSessionAwaitingFirstTurn = false;
      }
      if (activatesAgentStartup && liveSession === submissionSession) {
        liveSessionStartupDeferred = false;
      }
    } catch (error) {
      for (const token of migratedAdmissionTokens.reverse()) {
        submissionSession.rollbackIdleInputAdmission?.(token);
      }
      throw error;
    } finally {
      inFlightQueuedInputs = null;
    }
  };

  const originalEmit =
    typeof base.emit === "function"
      ? (base.emit as (event: unknown) => void).bind(base)
      : undefined;
  const stageDeferredProviderModel = (selection: {
    readonly provider: string;
    readonly model: string;
    readonly profile?: string;
  }): void => {
    pendingProvider = selection.provider;
    pendingModel = selection.model;
    if (selection.profile !== undefined) pendingProfile = selection.profile;
    const sessionConfiguration = (
      base as {
        sessionConfiguration?: {
          provider?: { slug?: string };
          collaborationMode?: { model?: string };
        };
      }
    ).sessionConfiguration;
    if (sessionConfiguration === undefined) return;
    sessionConfiguration.provider = {
      ...(sessionConfiguration.provider ?? {}),
      slug: selection.provider,
    };
    sessionConfiguration.collaborationMode = {
      ...(sessionConfiguration.collaborationMode ?? {}),
      model: selection.model,
    };
  };
  const session: TuiSessionShape & Record<string, unknown> = {
    ...daemonSessionBase,
    // The base carries the synthetic `agenc-tui-idle-<pid>` id until the
    // first turn; the daemon then vends the real `conv-*` id to the live
    // session. `/status` and anything else reading the outer wrapper must see
    // that id, not the placeholder the spread copied at construction.
    get conversationId(): string {
      const live = liveSession as { conversationId?: unknown } | null;
      return live !== null && typeof live.conversationId === "string"
        ? live.conversationId
        : (base.conversationId as string);
    },
    workflowApprovalControls: createWorkflowApprovalControls({
      async request(method, requestParams, options) {
        options.signal.throwIfAborted();
        const client = await ensureDaemonControlClient();
        options.signal.throwIfAborted();
        if (deferredSessionClosed) throw new Error("Deferred TUI session is already closed.");
        return client.request(method, requestParams, options);
      },
    }),
    // The deferred TUI never owns an MCP runtime. This stable facade forwards
    // to the daemon-backed session after attach and exposes only empty passive
    // state before then; it intentionally replaces any bootstrap manager.
    services: deferredServices,
    mcpSurfaceSnapshot: currentMcpSurfaceSnapshot,
    refreshMcpSurface: refreshCurrentMcpSurface,
    // Process polling is observational: opening /tasks must not provision an
    // agent or consume the first model-turn slot in an idle deferred TUI.
    listDaemonSessionProcesses: async () =>
      deferredSessionClosed ? undefined : liveSession?.listDaemonSessionProcesses?.(),
    // `/goal`: reading or dropping a goal never provisions a session (a cold
    // TUI simply has none). Setting one does, turn-deferred like a composer
    // shell command, because the goal must exist before its first turn runs.
    updateDaemonSessionGoal: async (goalParams) => {
      if (deferredSessionClosed) throw new Error("Deferred TUI session is already closed.");
      const live =
        liveSession ??
        (goalParams.action === "set"
          ? await ensureLiveSession("", undefined, true)
          : null);
      if (live === null) return { ok: false, message: "No goal is set." };
      if (typeof live.updateDaemonSessionGoal !== "function") {
        throw new Error("This daemon session does not support /goal.");
      }
      return live.updateDaemonSessionGoal(goalParams);
    },
    stopDaemonSessionProcess: async (taskId) => {
      const live = liveSession;
      if (deferredSessionClosed || typeof live?.stopDaemonSessionProcess !== "function") {
        throw new Error("No live daemon session is available to stop this process.");
      }
      return live.stopDaemonSessionProcess(taskId);
    },
    subscribeToMcpSurface: (cb) => {
      mcpSurfaceSubscribers.add(cb);
      const live = liveSession;
      if (live !== null) {
        attachLiveMcpSurfaceSubscriber(live, cb, false);
      }
      return () => {
        mcpSurfaceSubscribers.delete(cb);
        lastMcpSurfaceSignatures.delete(cb);
        try {
          liveMcpSurfaceUnsubscribers.get(cb)?.();
        } catch {
          // Subscription cleanup is observational and must stay fail-soft.
        }
        liveMcpSurfaceUnsubscribers.delete(cb);
      };
    },
    // Workspace-scoped controls (workflow approvals, daemon reload) use one
    // auxiliary daemon connection that survives live agent replacement.
    // Direct composer shell commands are session-scoped side effects. A cold
    // TUI provisions one turn-deferred live session, then forwards exactly
    // once. The command does not consume the first model-turn slot, and an
    // ambiguous transport failure is never replayed against a new session.
    executeShellCommand: async (shellParams) => {
      shellParams.signal?.throwIfAborted();
      const live =
        liveSession ?? (await ensureLiveSession("", undefined, true));
      const execute = live?.executeShellCommand;
      if (live === null || typeof execute !== "function") {
        throw new Error(
          "Shell execution is not supported by this daemon session.",
        );
      }
      return execute.call(live, shellParams);
    },
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
    // Same forwarder for /resolve: the command must reach the live daemon's
    // session.resolveToolCall RPC. The deferred session attaches LAZILY on
    // the first real turn, so before that there is nothing to resolve —
    // report a clean empty result instead of throwing.
    resolveDaemonToolCall: async (params: ResolveDaemonToolCallParams) => {
      if (liveSession === null) {
        return {
          sessionId: "pending",
          resolved: [],
          remaining: 0,
        };
      }
      const target = liveSession as TuiSessionShape;
      if (typeof target.resolveDaemonToolCall !== "function") {
        throw new Error("daemon session does not support tool-call resolution");
      }
      return target.resolveDaemonToolCall(params);
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
    // Same forwarder pattern as clearDaemonSession: /status and /usage
    // call `session.getDaemonSessionSnapshot()`
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
          "Nothing to compact yet. No conversation has started. Send a message first.",
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
    applyProviderModelSelection: async (selection) => {
      const live = liveSession as TuiSessionShape | null;
      if (live !== null) {
        if (typeof live.applyProviderModelSelection !== "function") {
          throw new Error(
            "Provider/model switching is not supported by this daemon session.",
          );
        }
        return live.applyProviderModelSelection(selection);
      }
      stageDeferredProviderModel(selection);
      return {
        applied: true,
        provider: selection.provider,
        model: selection.model,
        summary:
          `Provider/model selection staged: ${selection.provider}/${selection.model}; ` +
          "the first conversation will use it.",
      };
    },
    // The synchronous mutator exists only for pre-session bootstrap staging.
    // Once a live daemon session exists every caller must use the awaited
    // authority above so rejection and disconnects cannot be hidden.
    setPendingProviderSwitch: (pending) => {
      const live = liveSession as TuiSessionShape | null;
      if (live !== null) {
        throw new Error(
          "Live daemon provider/model changes require applyProviderModelSelection().",
        );
      }
      if (pending === null) return;
      stageDeferredProviderModel(pending);
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
          | "bypassPermissions"
          | "dontAsk"
          | "auto";
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
    executeDaemonStatusLine: async (presentation, signal) => {
      signal?.throwIfAborted();
      if (liveSession?.executeDaemonStatusLine === undefined) {
        return { status: "unavailable", reason: "session_not_ready" };
      }
      return liveSession.executeDaemonStatusLine(presentation, signal);
    },
    getDaemonHooksStatus: async () => {
      if (liveSession === null) {
        throw new Error(
          "Cannot inspect hooks yet: no live daemon session. Send a message first.",
        );
      }
      const live = liveSession as TuiSessionShape;
      if (typeof live.getDaemonHooksStatus !== "function") {
        throw new Error("Hooks inspection is not supported by this session.");
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
        throw new Error("Hooks toggling is not supported by this session.");
      }
      return live.setDaemonHooksDisabled(disabled);
    },
    // `/config profile` and `/config reload` re-apply config to a live
    // session. Before the first turn, stage the profile and reload only the
    // daemon-global snapshot used by Editor prediction.
    applyDaemonConfig: async (configParams) => {
      if (liveSession === null) {
        if (configParams.profile !== undefined) {
          pendingProfile = configParams.profile;
        }
        if (configParams.reload === true) {
          // Reload the daemon-global config snapshot without manufacturing a
          // session.applyConfig call or starting an agent.
          await (
            await ensureDaemonControlClient()
          ).request("daemon.reload", {});
        }
        const staged = [
          ...(configParams.reload === true ? ["daemon config reloaded"] : []),
          ...(configParams.profile !== undefined
            ? [`profile "${configParams.profile}" staged`]
            : []),
        ];
        return {
          sessionId: "pending",
          applied: false,
          summary:
            staged.length > 0
              ? `${staged.join("; ")}; the first conversation will use it.`
              : "No live session exists; the first conversation will use the current config.",
        };
      }
      const live = liveSession as TuiSessionShape;
      if (typeof live.applyDaemonConfig !== "function") {
        throw new Error("Config apply is not supported by this session.");
      }
      return live.applyDaemonConfig(configParams);
    },
    activeTurn: {
      unsafePeek: () =>
        liveSession?.activeTurn?.unsafePeek?.() ??
        (typeof (
          base.activeTurn as
            | { readonly unsafePeek?: () => { readonly turnId: string } | null }
            | undefined
        )?.unsafePeek === "function"
          ? (
              base.activeTurn as {
                readonly unsafePeek: () => { readonly turnId: string } | null;
              }
            ).unsafePeek()
          : null),
    },
    submit: async (message, opts) => {
      if (deferredSessionClosed) {
        throw new Error("Deferred TUI session is already closed.");
      }
      const activatesAgentStartup =
        opts?.source !== AUTONOMOUS_SUBMIT_SOURCE &&
        !isLocalSlashCommandInput(message);
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
      if (liveSession !== null && liveSessionAwaitingFirstTurn) {
        const firstMessage =
          isLocalSlashCommandInput(message)
            ? await handleLocalTuiSlashCommand({
                message,
                session,
                subscribers,
                configStore,
                agencHome: params.agencHome,
                cwd: params.cwd,
                env: params.env,
              })
            : { kind: "prompt" as const, content: message };
        if (firstMessage.kind === "handled") return;
        const submissionSession = liveSession;
        try {
          await submitToDeferredFirstTurn(
            firstMessage.content,
            opts,
            activatesAgentStartup,
          );
          return;
        } catch (error) {
          if (!isDaemonSessionGoneError(error)) throw error;
          const ownedInputTokens = [...liveInputAdmissions.entries()].filter(
            (
              entry,
            ): entry is [
              string,
              {
                readonly state: "pending";
                readonly origin: TuiSessionShape;
                readonly originToken: string;
              },
            ] =>
              entry[1].state === "pending" &&
              entry[1].origin === submissionSession,
          );
          for (const [token, admission] of ownedInputTokens) {
            const rollbackResult =
              admission.origin.rollbackIdleInputAdmission?.(
                admission.originToken,
              ) ?? false;
            liveInputAdmissions.set(token, {
              state: "settled",
              rollbackResult,
            });
          }
          await detachLiveSession();
          if (ownedInputTokens.length > 0) throw error;
        }
      }
      if (liveSession !== null) {
        const submissionSession = liveSession;
        try {
          await submitToDeferredFirstTurn(message, opts, activatesAgentStartup);
          if (activatesAgentStartup && liveSession === submissionSession) {
            liveSessionStartupDeferred = false;
          }
          return;
        } catch (error) {
          if (
            isLocalSlashCommandInput(message) ||
            !isDaemonSessionGoneError(error)
          ) {
            throw error;
          }
          const ownedInputTokens = [...liveInputAdmissions.entries()].filter(
            (
              entry,
            ): entry is [
              string,
              {
                readonly state: "pending";
                readonly origin: TuiSessionShape;
                readonly originToken: string;
              },
            ] =>
              entry[1].state === "pending" &&
              entry[1].origin === submissionSession,
          );
          for (const [token, admission] of ownedInputTokens) {
            const rollbackResult =
              admission.origin.rollbackIdleInputAdmission?.(
                admission.originToken,
              ) ?? false;
            // Retain only the tiny terminal result for App's imminent
            // rollback call. Do not pin a detached wrapper (and its bounded
            // queued content) if a caller abandons the proxy token.
            liveInputAdmissions.set(token, {
              state: "settled",
              rollbackResult,
            });
          }
          await detachLiveSession();
          if (ownedInputTokens.length > 0) {
            // The failed live session re-queues its owned blocks before
            // surfacing AGENT_NOT_FOUND. We already rolled back that exact
            // bundle and released the origin; reject so App can consume the
            // saved terminal result and restore the composer. Retrying only
            // `message` against a fresh agent would silently drop context.
            throw error;
          }
        }
      }
      const firstMessage =
        isLocalSlashCommandInput(message)
          ? await handleLocalTuiSlashCommand({
              message,
              session,
              subscribers,
              configStore,
              agencHome: params.agencHome,
              cwd: params.cwd,
              env: params.env,
            })
          : { kind: "prompt" as const, content: message };
      if (firstMessage.kind === "handled") return;
      const pendingStartup = liveSessionPromise;
      if (pendingStartup !== null) {
        const pendingLive = await pendingStartup;
        if (pendingLive === null) return;
        if (liveSessionAwaitingFirstTurn) {
          await submitToDeferredFirstTurn(
            firstMessage.content,
            opts,
            activatesAgentStartup,
          );
        } else {
          await submitToDeferredFirstTurn(
            firstMessage.content,
            opts,
            activatesAgentStartup,
          );
          if (activatesAgentStartup && liveSession === pendingLive) {
            liveSessionStartupDeferred = false;
          }
        }
        return;
      }
      if (liveSession !== null) {
        if (liveSessionAwaitingFirstTurn) {
          await submitToDeferredFirstTurn(
            firstMessage.content,
            opts,
            activatesAgentStartup,
          );
        } else {
          const submissionSession = liveSession;
          await submitToDeferredFirstTurn(
            firstMessage.content,
            opts,
            activatesAgentStartup,
          );
          if (activatesAgentStartup && liveSession === submissionSession) {
            liveSessionStartupDeferred = false;
          }
        }
        return;
      }
      await ensureLiveSession(firstMessage.content, opts);
    },
    enqueueIdleInput: (input, ownership) => {
      if (liveSession !== null) {
        return liveSession.enqueueIdleInput?.(input, ownership) ?? 0;
      }
      try {
        return admitQueuedInputs([input], false, ownership).lastSequence;
      } catch {
        return -1;
      }
    },
    enqueueIdleInputBatch: (inputs, ownership) => {
      if (liveSession !== null) {
        const batch = liveSession.enqueueIdleInputBatch;
        if (typeof batch === "function") {
          return batch.call(liveSession, inputs, ownership);
        }
        let sequence = 0;
        for (const input of inputs) {
          sequence =
            liveSession.enqueueIdleInput?.(input, ownership) ?? sequence;
        }
        return sequence;
      }
      try {
        return admitQueuedInputs(inputs, false, ownership).lastSequence;
      } catch {
        return -1;
      }
    },
    enqueueIdleInputBatchOwned: (inputs, ownership) => {
      if (liveSession !== null) {
        // App submits one owned bundle at a time. Retaining more than one
        // proxy could pin multiple detached 16-MiB origin queues after
        // repeated daemon loss, so fail closed until the current token is
        // committed or rolled back.
        if (liveInputAdmissions.size > 0) {
          throw new Error("A queued-input submission is already pending.");
        }
        const origin = liveSession;
        const owned = liveSession.enqueueIdleInputBatchOwned;
        if (typeof owned !== "function") {
          throw new Error(
            "This session cannot safely own queued input for submission.",
          );
        }
        const admission = owned.call(origin, inputs, ownership);
        if (admission.count === 0) {
          return {
            ...admission,
            token: "deferred-live:empty",
          };
        }
        const token = `deferred-live:${randomUUID()}`;
        liveInputAdmissions.set(token, {
          state: "pending",
          origin,
          originToken: admission.token,
        });
        return { ...admission, token };
      }
      return admitQueuedInputs(inputs, true, ownership);
    },
    rollbackIdleInputAdmission: (token) => {
      if (
        token === "deferred-idle:empty" ||
        token.startsWith("deferred-idle:")
      ) {
        return rollbackQueuedInputAdmission(token);
      }
      if (token === "deferred-live:empty") return true;
      const admission = liveInputAdmissions.get(token);
      if (admission !== undefined) {
        const rolledBack =
          admission.state === "settled"
            ? admission.rollbackResult
            : (admission.origin.rollbackIdleInputAdmission?.(
                admission.originToken,
              ) ?? false);
        liveInputAdmissions.delete(token);
        return rolledBack;
      }
      if (token.startsWith("deferred-live:")) return false;
      return liveSession?.rollbackIdleInputAdmission?.(token) ?? false;
    },
    commitIdleInputAdmission: (token) => {
      if (
        token === "deferred-idle:empty" ||
        token.startsWith("deferred-idle:")
      ) {
        return commitQueuedInputAdmission(token);
      }
      if (token === "deferred-live:empty") return true;
      const admission = liveInputAdmissions.get(token);
      if (admission !== undefined) {
        const committed =
          admission.state === "settled"
            ? false
            : (admission.origin.commitIdleInputAdmission?.(
                admission.originToken,
              ) ?? false);
        // A successful daemon submit consumes its internal admission before
        // App commits the outer transaction, so `false` can mean "already
        // consumed." The outer proxy has completed either way.
        liveInputAdmissions.delete(token);
        return committed;
      }
      if (token.startsWith("deferred-live:")) return false;
      return liveSession?.commitIdleInputAdmission?.(token) ?? false;
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
      const alreadySubscribed = subscribers.has(cb);
      subscribers.add(cb);
      try {
        if (liveSession !== null) {
          const unsubscribe = liveSession.subscribeToEvents?.(cb);
          if (unsubscribe !== undefined) liveUnsubscribers.set(cb, unsubscribe);
        }
      } catch (error) {
        if (!alreadySubscribed) subscribers.delete(cb);
        throw error;
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
      deferredSessionClosed = true;
      const pendingLiveSession = liveSessionPromise;
      if (pendingLiveSession !== null) {
        await pendingLiveSession.catch(() => {
          /* late startup performs its own agent/client cleanup */
        });
      }
      if (liveSessionStartupDeferred && liveAgentId !== null) {
        await stopDaemonAgentBestEffort({
          deps: params.deps,
          daemonClient,
          env: params.env,
          agentId: liveAgentId,
          reason: liveSessionAwaitingFirstTurn
            ? "tui_closed_before_submit"
            : "tui_closed_editor_only",
        });
      }
      await detachLiveSession();
      const pendingControlClient = daemonControlClientPromise;
      if (pendingControlClient !== null) {
        await pendingControlClient.catch(() => {
          /* connection failure or close-during-connect */
        });
      }
      const controlClient = daemonControlClient;
      daemonControlClient = null;
      daemonControlClientPromise = null;
      await controlClient?.close().catch(() => {
        /* best effort */
      });
      mcpSurfaceSubscribers.clear();
      idleInputAdmissions.clear();
      liveInputAdmissions.clear();
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


async function prepareDaemonTuiPrompt(params: {
  readonly message: string;
  readonly configStore: Pick<ConfigStore, "current" | "authoritySnapshot">;
  readonly agencHome: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}): Promise<string | null> {
  if (isLocalSlashCommandInput(params.message)) return null;
  return params.message;
}


function wrapDaemonTuiSessionWithPromptPreparation<
  Session extends {
    submit?: (message: string, opts?: SessionSubmitOptions) => Promise<void>;
    subscribeToEvents?: (cb: (event: unknown) => void) => () => void;
    emit?: (event: unknown) => void;
    emitPhaseEvent?: (event: PhaseEvent) => void;
  },
>(
  session: Session,
  params: {
    readonly agencHome: string;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly stderr: Pick<NodeJS.WriteStream, "write">;
    readonly preparePrompt?: typeof prepareDaemonTuiPrompt;
  },
): Session {
  const configStore = requireTuiSessionConfigStore(session);
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
            configStore,
            agencHome: params.agencHome,
            cwd: params.cwd,
            env: params.env,
          })
        : { kind: "prompt" as const, content: message };
      if (nextMessage.kind === "handled") return;
      const prepared = await (params.preparePrompt ?? prepareDaemonTuiPrompt)({
        message: nextMessage.content,
        ...params,
        configStore,
      });
      if (prepared === null) {
        throw new Error(
          "Prompt preparation did not produce a model submission; pending input was not consumed.",
        );
      }
      await originalSubmit(prepared, opts);
    },
    subscribeToEvents: ((cb: (event: unknown) => void) => {
      const alreadySubscribed = localSubscribers.has(cb);
      localSubscribers.add(cb);
      try {
        const unsubscribeOriginal = originalSubscribe?.(cb);
        return () => {
          localSubscribers.delete(cb);
          unsubscribeOriginal?.();
        };
      } catch (error) {
        if (!alreadySubscribed) localSubscribers.delete(cb);
        throw error;
      }
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


/** Test-only handle for prompt-preparation rejection and ownership regressions. */
export const __wrapDaemonTuiSessionWithPromptPreparationForTest =
  wrapDaemonTuiSessionWithPromptPreparation;


type BootTUIEntryArgs = BootTUIArgs & { readonly resumeId?: string };


async function resumeColdDaemonSession(params: {
  readonly deps: AgenCDaemonCliDeps;
  readonly descriptor: ResolvedResumeSession;
  readonly startupCliFlags: StartupCliFlags;
}): Promise<AgentSummary> {
  const startupFlags = params.startupCliFlags;
  const sessionEnv = process.env;
  const sandboxBypass = resolveStartupSandboxBypass(startupFlags, {
    cwd: params.descriptor.cwd,
    env: sessionEnv,
  });
  writeStartupSandboxBypassNotice(sandboxBypass);
  const runtimeOptions = resolveAgentRuntimeOptions(sessionEnv, {
    simpleMode: startupFlags.simpleMode === true,
    ...(startupFlags.lightMode === true ? { lightMode: true } : {}),
    dangerouslyBypassApprovalsAndSandbox:
      sandboxBypass.dangerouslyBypassApprovalsAndSandbox,
  });
  const startupLayers = startupConfigLayerOptions({
    cli: startupFlags,
    cwd: params.descriptor.cwd,
  });
  const permissionMode = startupPermissionMode(startupFlags);
  return params.deps.resumePromptAgent({
    sessionId: params.descriptor.sessionId,
    rolloutPath: params.descriptor.rolloutPath,
    sourceProof: {
      dev: params.descriptor.sourceDev,
      ino: params.descriptor.sourceIno,
      size: params.descriptor.sourceSize,
      sha256: params.descriptor.sourceSha256,
      cwdDev: params.descriptor.cwdDev,
      cwdIno: params.descriptor.cwdIno,
    },
    cwd: params.descriptor.cwd,
    env: sessionEnv,
    runtimeOptions,
    ...(startupFlags.model !== undefined ? { model: startupFlags.model } : {}),
    ...(startupFlags.provider !== undefined
      ? { provider: startupFlags.provider }
      : {}),
    ...(startupFlags.profile !== undefined
      ? { profile: startupFlags.profile }
      : {}),
    ...(startupLayers.flagConfigPath !== undefined
      ? { configPath: startupLayers.flagConfigPath }
      : {}),
    ...(startupFlags.addDirs !== undefined
      ? { addDirs: startupFlags.addDirs }
      : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  });
}


/** Boot the TUI, preserving argv prompts and any pre-Ink typed draft text. */
export async function bootTUIEntry(
  args: BootTUIEntryArgs,
  parsedStartupCliFlags?: StartupCliFlags,
): Promise<number> {
  const startupCliFlags =
    parsedStartupCliFlags ?? readStartupCliFlags(process.argv);
  const sessionEnv = process.env;
  const sandboxBypass = resolveStartupSandboxBypass(startupCliFlags, {
    cwd: process.cwd(),
    env: sessionEnv,
  });
  writeStartupSandboxBypassNotice(sandboxBypass);
  const runtimeOptions = resolveAgentRuntimeOptions(sessionEnv, {
    simpleMode: startupCliFlags.simpleMode === true,
    ...(startupCliFlags.lightMode === true ? { lightMode: true } : {}),
    dangerouslyBypassApprovalsAndSandbox:
      sandboxBypass.dangerouslyBypassApprovalsAndSandbox,
  });
  return runWithAgentRuntimeOptions(runtimeOptions, async () => {
    setIsRemoteMode(runtimeOptions.remoteMode);
    const cliCwd = resolveCliCwdForStartup(sessionEnv);
    if (!cliCwd.ok) {
      return writeUnavailableCliCwd();
    }
    if (
      args.resumeId === undefined &&
      !(await requireProjectTrustForTui({
        env: sessionEnv,
        argv: process.argv,
        startupCliFlags,
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
      const startupAgencHome = resolveAgencHome(sessionEnv);
      // OOM self-diagnosis: sample heap pressure and auto-capture a snapshot
      // near the limit; point at a fresh capture from a previous crash.
      startHeapWatchdog({ agencHome: startupAgencHome });
      const oomNotice = recentOomSnapshotNotice(startupAgencHome);
      if (oomNotice !== null) {
        process.stderr.write(`${oomNotice}\n`);
      }
      if (args.resumeId !== undefined) {
        const resolved = resolveResumeSessionId(
          cliCwd.cwd,
          args.resumeId,
          startupAgencHome,
        );
        if (resolved.kind === "ok") {
          return resumeResolvedTUIEntry(resolved, args.resumeId, {
            agencHome: startupAgencHome,
            startupCliFlags,
            initialComposerText: consumeEarlyInput(),
            ...(args.startupImages !== undefined
              ? { startupImages: args.startupImages }
              : {}),
          });
        }
        if (resolved.kind === "ambiguous") {
          process.stderr.write(
            `agenc: ambiguous session id '${resolved.input}' matches: ${resolved.matches.join(", ")}\n`,
          );
        } else if (resolved.kind === "search_incomplete") {
          process.stderr.write(
            `agenc: session search stopped at its ${resolved.reason.replaceAll("_", " ")} safety limit\n`,
          );
        } else {
          process.stderr.write(`agenc: session not found: ${args.resumeId}\n`);
        }
        return 1;
      }
      const capturedEarlyInput = consumeEarlyInput();
      const initialPrompt = args.initialPrompt?.trim();
      const daemonCwd = cliCwd.cwd;
      const startupLayers = startupConfigLayerOptions({
        cli: startupCliFlags,
        cwd: daemonCwd,
      });
      const startupImages = args.startupImages ?? [];
      if (
        (initialPrompt === undefined || initialPrompt.length === 0) &&
        startupImages.length === 0
      ) {
        const deps = daemonCliDeps();
        const idlePermissionMode = startupPermissionMode(startupCliFlags);
        const {
          workspaceRoot,
          baseSession,
          model,
          close: closeTuiContext = async () => undefined,
        } = await deps.createTuiContext({
          env: sessionEnv,
          runtimeOptions,
          cwd: daemonCwd,
          conversationId: `agenc-tui-idle-${process.pid}`,
          ...(startupCliFlags.provider !== undefined
            ? { provider: startupCliFlags.provider }
            : {}),
          ...(startupCliFlags.model !== undefined
            ? { model: startupCliFlags.model }
            : {}),
          ...(startupCliFlags.profile !== undefined
            ? { profile: startupCliFlags.profile }
            : {}),
          ...(startupLayers.flagConfigPath !== undefined
            ? { configPath: startupLayers.flagConfigPath }
            : {}),
          ...(idlePermissionMode !== undefined
            ? { permissionMode: idlePermissionMode }
            : {}),
        });
        const configStore = baseSession.services.configStore;
        const deferred = await createDeferredDaemonPromptTuiSession({
          baseSession,
          deps,
          agencHome: configStore.agencHome,
          env: sessionEnv,
          runtimeOptions,
          cwd: workspaceRoot,
          clientId: `agenc-tui-${process.pid}`,
          ...(startupCliFlags.provider !== undefined
            ? { provider: startupCliFlags.provider }
            : {}),
          ...(startupCliFlags.model !== undefined
            ? { model: startupCliFlags.model }
            : {}),
          ...(startupCliFlags.profile !== undefined
            ? { profile: startupCliFlags.profile }
            : {}),
          ...(startupLayers.flagConfigPath !== undefined
            ? { configPath: startupLayers.flagConfigPath }
            : {}),
          ...(startupCliFlags.addDirs !== undefined
            ? { addDirs: startupCliFlags.addDirs }
            : {}),
          // Seed the deferred bootstrap permission mode the same way the daemon
          // createTuiContext above does: an explicit `--dangerously-bypass-approvals-and-sandbox` forces bypass,
          // otherwise honor the startup `--permission-mode` flag. Pre-first-turn
          // `/permissions mode` / `/plan` then overwrite this staged value.
          ...(idlePermissionMode !== undefined
            ? { permissionMode: idlePermissionMode }
            : {}),
        });
        const boot = await loadBootTUI();
        try {
          const handle = await boot({
            session: deferred.session,
            model,
            stdinMode:
              runtimeOptions.stdinDataMode === true ? "data" : "readable",
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
        return exitOrResumeAfterTui(0, startupCliFlags);
      }
      const objective =
        initialPrompt !== undefined && initialPrompt.length > 0
          ? initialPrompt
          : "Multimodal AgenC startup";
      const agencHome = resolveAgencHome(sessionEnv);
      const configStore = new ConfigStore({
        home: agencHome,
        env: sessionEnv,
        cwd: daemonCwd,
        ...startupLayers,
        onWarn: (message) => process.stderr.write(`${message}\n`),
      });
      const config = await configStore.reload();
      const profileName = resolvedStartupProfileName(
        startupCliFlags,
        sessionEnv,
      );
      const startup = resolveCanonicalStartupSelection({
        config,
        ...(profileName !== undefined ? { profileName } : {}),
      });
      const initialContent = startupContentFromInputs(
        objective,
        startupImages,
        daemonCwd,
        sessionEnv.HOME,
      );
      const deps = daemonCliDeps();
      // Propagate the canonical dangerous-bypass selection to the daemon so the
      // spawned agent's session resolves approvalPolicy correctly. Without
      // this, bypass only affected the local CLI bootstrap and dropped on
      // the wire — see GAP-PE-GUARDIAN-YOLO-LEAK and the daemon-side
      // forwarding in background-agent-runner.buildBootstrapArgv.
      const promptPermissionMode = startupPermissionMode(startupCliFlags);
      const started = await deps.startPromptAgent({
        prompt: objective,
        env: sessionEnv,
        runtimeOptions,
        cwd: daemonCwd,
        model: startup.model,
        provider: startup.provider,
        ...(startup.profileName !== undefined
          ? { profile: startup.profileName }
          : {}),
        ...(startupLayers.flagConfigPath !== undefined
          ? { configPath: startupLayers.flagConfigPath }
          : {}),
        ...(startupCliFlags.addDirs !== undefined
          ? { addDirs: startupCliFlags.addDirs }
          : {}),
        ...(initialContent !== undefined ? { initialContent } : {}),
        ...(promptPermissionMode !== undefined
          ? { permissionMode: promptPermissionMode }
          : {}),
        metadata: { mode: "tui" },
      });
      try {
        const exitCode = await attachAgentTuiEntry({
          agentId: started.agentId,
          clientId: `agenc-tui-${process.pid}`,
          startupCliFlags,
          runtimeOptions,
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
        return exitOrResumeAfterTui(exitCode, startupCliFlags);
      } catch (error) {
        await stopDaemonAgentBestEffort({
          deps,
          env: sessionEnv,
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
  });
}


export interface AttachAgentTuiEntryArgs {
  readonly agentId: string;
  readonly clientId: string;
  readonly initialComposerText?: string;
  readonly startupImages?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly runtimeOptions?: AgentRuntimeOptions;
  /** Startup selection parsed once by the owning CLI route. */
  readonly startupCliFlags?: StartupCliFlags;
  readonly daemonClient?: Awaited<
    ReturnType<typeof createConnectedAgenCJsonLineDaemonTuiClient>
  >;
}


/** Attach the Ink TUI to a daemon-owned background agent session. */
export async function attachAgentTuiEntry(
  args: AttachAgentTuiEntryArgs,
): Promise<number> {
  const env = args.env ?? process.env;
  const startupCliFlags =
    args.startupCliFlags ?? readStartupCliFlags(process.argv);
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
        startupCliFlags,
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
    const runtimeOptions = validateAgentRuntimeOptions(
      attachment.runtimeOptions,
    );
    const expectedRuntimeOptions =
      args.runtimeOptions === undefined
        ? undefined
        : validateAgentRuntimeOptions(args.runtimeOptions);
    if (
      expectedRuntimeOptions !== undefined &&
      (!isDeepStrictEqual(
        {
          ...expectedRuntimeOptions,
          dangerouslyBypassApprovalsAndSandbox:
            runtimeOptions.dangerouslyBypassApprovalsAndSandbox,
        },
        runtimeOptions,
      ) ||
        (expectedRuntimeOptions.dangerouslyBypassApprovalsAndSandbox &&
          !runtimeOptions.dangerouslyBypassApprovalsAndSandbox))
    ) {
      throw new Error(
        `daemon agent runtime options disagree with the attaching client: ${args.agentId}`,
      );
    }
    const attachedClient = daemonClient;
    return await runWithAgentRuntimeOptions(runtimeOptions, async () => {
      setIsRemoteMode(runtimeOptions.remoteMode);
      const sessionId = attachment.sessionIds[0];
      if (sessionId === undefined) {
        throw new Error(
          `daemon agent has no attached session: ${args.agentId}`,
        );
      }
      const runtimeSessionId =
        attachment.runtimeSessionId ?? attachment.agentId ?? sessionId;
      const bootstrapCwd = resolveAgenCAgentAttachCwd(attachment);
      const roleWorkspace = resolveAgenCAgentAttachRoleWorkspace(
        attachment,
        targetCwd,
      );
      if (
        roleWorkspace.cwd !== targetCwd &&
        !(await requireProjectTrustForTui({
          env,
          argv: process.argv,
          startupCliFlags,
          cwd: roleWorkspace.cwd,
          useEnvWorkspace: false,
        }))
      ) {
        return 1;
      }
      const bootstrapEnv = envForAttachBootstrap(env, bootstrapCwd);
      const startupLayers = startupConfigLayerOptions({
        cli: startupCliFlags,
        cwd: bootstrapCwd,
      });
      const attachedMetadata = attachment.sessions.find(
        (attachedSession) => attachedSession.sessionId === sessionId,
      )?.metadata;
      const metadataString = (key: string): string | undefined => {
        const value = attachedMetadata?.[key];
        return typeof value === "string" && value.trim().length > 0
          ? value.trim()
          : undefined;
      };
      const retainedConfigPath = metadataString("configPath");
      if (retainedConfigPath !== undefined && !isAbsolute(retainedConfigPath)) {
        throw new Error("daemon session metadata configPath must be absolute");
      }
      const liveSettings = attachment.runtimeSettings;
      const requestedPermissionMode = startupPermissionMode(startupCliFlags);
      if (
        startupCliFlags.provider !== undefined &&
        startupCliFlags.provider !== liveSettings.provider
      ) {
        throw new Error(
          `attach-time provider ${startupCliFlags.provider} disagrees with live daemon provider ${liveSettings.provider}`,
        );
      }
      if (
        startupCliFlags.model !== undefined &&
        startupCliFlags.model !== liveSettings.model
      ) {
        throw new Error(
          `attach-time model ${startupCliFlags.model} disagrees with live daemon model ${liveSettings.model}`,
        );
      }
      if (
        requestedPermissionMode !== undefined &&
        requestedPermissionMode !== liveSettings.permissionMode
      ) {
        throw new Error(
          `attach-time permission mode ${requestedPermissionMode} disagrees with live daemon mode ${liveSettings.permissionMode}`,
        );
      }
      if (
        startupCliFlags.profile !== undefined &&
        startupCliFlags.profile !== liveSettings.profile
      ) {
        throw new Error(
          `attach-time profile ${startupCliFlags.profile} disagrees with live daemon profile ${liveSettings.profile ?? "(none)"}`,
        );
      }
      const attachProvider = liveSettings.provider;
      const attachModel = liveSettings.model;
      const attachProfile = liveSettings.profile ?? undefined;
      const attachConfigPath =
        startupLayers.flagConfigPath ?? retainedConfigPath;
      const rawTranscriptSnapshot = await attachedClient.request("session.transcript.v2", {
        sessionId,
      });
      const { daemonTranscriptSnapshotEvents, resolveDaemonTranscriptTextArtifacts } = await import("../tui/daemon-transcript-snapshot.js");
      const transcriptSnapshot = await resolveDaemonTranscriptTextArtifacts(
        rawTranscriptSnapshot,
        (params) => attachedClient.request("session.artifact.read", params),
      );
      daemonTranscriptSnapshotEvents(transcriptSnapshot, sessionId);
      const {
        workspaceRoot,
        baseSession,
        model,
        close: closeTuiContext = async () => undefined,
      } = await daemonCliDeps().createTuiContext({
        env: bootstrapEnv,
        runtimeOptions,
        cwd: bootstrapCwd,
        roleWorkspace,
        conversationId: runtimeSessionId,
        runtimeSettings: liveSettings,
        ...(attachProvider !== undefined ? { provider: attachProvider } : {}),
        ...(attachModel !== undefined ? { model: attachModel } : {}),
        ...(attachProfile !== undefined ? { profile: attachProfile } : {}),
        ...(attachConfigPath !== undefined
          ? { configPath: attachConfigPath }
          : {}),
      });
      const configStore = baseSession.services.configStore;
      const createDaemonTuiSession = await loadCreateDaemonTuiSession();
      const daemonSession = await createDaemonTuiSession({
        baseSession,
        client: daemonClient,
        sessionId,
        agentId: args.agentId,
        conversationId: runtimeSessionId,
        clientId: args.clientId,
        transcriptSnapshot,
        runtimeSettingsCursor: {
          eventId: attachment.runtimeSettingsEventId,
          cwd: bootstrapCwd,
        },
      });
      const preparedDaemonSession = wrapDaemonTuiSessionWithPromptPreparation(
        daemonSession as {
          submit?: (
            message: string,
            opts?: { readonly displayUserMessage?: string | null },
          ) => Promise<void>;
        },
        {
          agencHome: configStore.agencHome,
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
          model,
          stdinMode:
            runtimeOptions.stdinDataMode === true ? "data" : "readable",
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
    });
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
export async function resumeTUIEntry(
  args: ResumeTUIArgs,
  startupCliFlags: StartupCliFlags = readStartupCliFlags(process.argv),
): Promise<number> {
  const cliCwd = resolveCliCwdForStartup(process.env);
  if (!cliCwd.ok) {
    return writeUnavailableCliCwd();
  }
  const workspaceRoot = cliCwd.cwd;
  const agencHome = resolveAgencHome(process.env);
  const resolved = resolveResumeSessionId(
    workspaceRoot,
    args.resumeId,
    agencHome,
  );
  switch (resolved.kind) {
    case "ok":
      return resumeResolvedTUIEntry(resolved, args.resumeId, {
        agencHome,
        startupCliFlags,
      });
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
    case "search_incomplete":
      process.stderr.write(
        `agenc: session search stopped at its ${resolved.reason.replaceAll("_", " ")} safety limit; narrow the session id and retry\n`,
      );
      return 1;
  }
}


async function resumeResolvedTUIEntry(
  descriptor: ResolvedResumeSession,
  displayId: string,
  options: {
    readonly agencHome: string;
    readonly startupCliFlags?: StartupCliFlags;
    readonly initialComposerText?: string;
    readonly startupImages?: readonly string[];
  },
): Promise<number> {
  const startupCliFlags =
    options.startupCliFlags ?? readStartupCliFlags(process.argv);
  let cwdProof: ResumeCwdProof;
  try {
    cwdProof = openResumeCwdProof(descriptor.cwd);
  } catch (error) {
    process.stderr.write(
      `agenc: unable to resume session '${displayId}': ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
  try {
    if (
      !(await requireProjectTrustForTui({
        env: process.env,
        argv: process.argv,
        startupCliFlags,
        cwd: descriptor.cwd,
        useEnvWorkspace: false,
      }))
    ) {
      return 1;
    }
    let authoritative: ResolvedResumeSession;
    try {
      assertResumeCwdProof(descriptor.cwd, cwdProof);
      authoritative = reproveResumeDescriptor(descriptor, options.agencHome);
    } catch (error) {
      process.stderr.write(
        `agenc: unable to resume session '${displayId}': ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return 1;
    }
    const deps = daemonCliDeps();
    try {
      await deps.ensureDaemonReady(process.env)();
      assertResumeCwdProof(authoritative.cwd, cwdProof);
      authoritative = reproveResumeSessionAfterDaemonReady(
        authoritative,
        options.agencHome,
      );
    } catch (error) {
      process.stderr.write(
        `agenc: unable to resume session '${displayId}': ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return 1;
    }
    const daemonClient = await deps.createConnectedTuiClient();
    let transferred = false;
    try {
      let agent: AgentSummary;
      try {
        const live = await deps.findAgentBySessionId(
          daemonClient,
          authoritative.sessionId,
        );
        if (live === null) {
          authoritative = reproveResumeDescriptor(
            authoritative,
            options.agencHome,
          );
          assertResumeCwdProof(authoritative.cwd, cwdProof);
          try {
            agent = await resumeColdDaemonSession({
              deps,
              descriptor: authoritative,
              startupCliFlags,
            });
          } catch (resumeError) {
            if (!isCanonicalSessionAlreadyActiveError(resumeError)) {
              throw resumeError;
            }
            const raced = await deps.findAgentBySessionId(
              daemonClient,
              authoritative.sessionId,
            );
            if (raced === null) throw resumeError;
            agent = raced;
          }
        } else {
          agent = live;
        }
        assertResumeCwdProof(authoritative.cwd, cwdProof);
        assertLiveAgentMatchesResumeDescriptor(agent, authoritative);
      } catch (error) {
        process.stderr.write(
          `agenc: unable to resume session '${displayId}': ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        return 1;
      }
      transferred = true;
      const code = await attachAgentTuiEntry({
        agentId: agent.agentId,
        clientId: `agenc-tui-${process.pid}`,
        daemonClient,
        startupCliFlags,
        ...(options.initialComposerText !== undefined
          ? { initialComposerText: options.initialComposerText }
          : {}),
        ...(options.startupImages !== undefined
          ? { startupImages: options.startupImages }
          : {}),
      });
      return exitOrResumeAfterTui(code, startupCliFlags);
    } finally {
      if (!transferred) {
        await daemonClient.close().catch(() => {
          /* best effort */
        });
      }
    }
  } finally {
    closeSync(cwdProof.fd);
  }
}


/** Continue the newest prior session for the current project. */
export async function continueTUIEntry(
  _args: ContinueTUIArgs,
  startupCliFlags: StartupCliFlags = readStartupCliFlags(process.argv),
): Promise<number> {
  const cliCwd = resolveCliCwdForStartup(process.env);
  if (!cliCwd.ok) {
    return writeUnavailableCliCwd();
  }
  const workspaceRoot = cliCwd.cwd;
  const agencHome = resolveAgencHome(process.env);
  const resolved = resolveLatestSessionId(workspaceRoot, agencHome);
  if (resolved.kind === "search_incomplete") {
    process.stderr.write(
      `agenc: session search stopped at its ${resolved.reason.replaceAll("_", " ")} safety limit; retry with an exact session id\n`,
    );
    return 1;
  }
  if (resolved.kind !== "ok") {
    process.stderr.write("agenc: no previous session found for this project\n");
    return 1;
  }
  return resumeResolvedTUIEntry(resolved, resolved.sessionId, {
    agencHome,
    startupCliFlags,
  });
}



async function loadMcpCliConfig(): Promise<AgenCConfig | undefined> {
  try {
    const store = new ConfigStore({
      home: resolveAgencHome(process.env),
      env: process.env,
      cwd: resolveWorkspaceFromEnv(process.env) ?? process.cwd(),
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
// main routing entrypoint
// ─────────────────────────────────────────────────────────────────────

/**
 * The operator-facing process owns the advisory startup audit. A detached
 * daemon re-enters this dispatcher as `start --foreground`, but repeating the
 * audit there would duplicate config and native secure-storage reads before the child
 * can publish readiness. Direct foreground launches still run the audit.
 */

/**
 * Top-level dispatcher. Branches between the full Ink TUI and the
 * daemon-backed one-shot CLI based on argv + stdio state. See `./route.ts`
 * for the routing table.
 */
export async function main(): Promise<number> {
  const ingressExitCode = prepareCliRuntime();
  if (ingressExitCode !== null) return ingressExitCode;
  const argv = process.argv.slice(2);
  const initCommand = parseAgenCInitCliArgs(argv);
  if (initCommand !== null) {
    return runAgenCInitCli(initCommand);
  }
  const proxyCommand = parseAgenCDaemonProxyCliArgs(argv);
  if (proxyCommand !== null) return runAgenCDaemonProxyCli(proxyCommand);
  const daemonCommand = parseAgenCDaemonCliArgs(argv);
  if (daemonCommand !== null) {
    if (
      daemonCommand.kind === "command" &&
      shouldRunDaemonStartupSecurityAudit(daemonCommand.action, process.env)
    ) {
      // Warn (never block) when starting the daemon with critical audit
      // findings — exposure misconfigurations matter most at startup.
      try {
        const audit = await buildSecurityAuditReport({
          env: process.env,
          inspectNativeCredentials: false,
        });
        if (audit.criticalCount > 0) {
          process.stderr.write(
            `agenc: WARNING. ${formatSecurityAuditSummaryLine(audit)}\n`,
          );
        }
      } catch {
        // Advisory only.
      }
    }
    // The real daemon process must not keep the caller's working directory;
    // library callers (and tests running the daemon in-process) leave it.
    return runAgenCDaemonCli(daemonCommand, { enterDaemonHome: true });
  }
  const remoteCommand = parseAgenCRemoteCliArgs(argv);
  if (remoteCommand !== null) {
    return runAgenCRemoteCli(
      remoteCommand,
      captureRemoteCliRuntimeContext(process.env),
    );
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
  // Headless ChatGPT sign-in, ahead of the TUI routes: programs need a
  // result on stdout, not an Ink screen to scrape.
  const openAiAuthCommand = parseOpenAiAuthCliArgs(argv);
  if (openAiAuthCommand !== null) {
    const ingress = captureSecureStorageIngress(process.env);
    return runOpenAiAuthCli(openAiAuthCommand, {
      home: ingress.home,
      environment: snapshotProviderEnvironment(ingress.environment),
    });
  }
  const grokAuthCommand = parseGrokAuthCliArgs(argv);
  if (grokAuthCommand !== null) {
    const ingress = captureSecureStorageIngress(process.env);
    return runGrokAuthCli(grokAuthCommand, {
      home: ingress.home,
      environment: snapshotProviderEnvironment(ingress.environment),
    });
  }
  const openAiModelsCommand = parseOpenAiModelsCliArgs(argv);
  if (openAiModelsCommand !== null) {
    const ingress = captureSecureStorageIngress(process.env);
    return runOpenAiModelsCli(openAiModelsCommand, {
      home: ingress.home,
      environment: snapshotProviderEnvironment(ingress.environment),
    });
  }
  const kimiModelsCommand = parseKimiModelsCliArgs(argv);
  if (kimiModelsCommand !== null) {
    const ingress = captureSecureStorageIngress(process.env);
    const moonshotApiKey = ingress.environment.MOONSHOT_API_KEY;
    return runKimiModelsCli(kimiModelsCommand, {
      environment: snapshotProviderEnvironment(
        moonshotApiKey === undefined
          ? {}
          : { MOONSHOT_API_KEY: moonshotApiKey },
      ),
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
    const { runAgenCMcpCli } = await import("./mcp-cli.js");
    return runAgenCMcpCli(mcpCommand);
  }
  const doctorCommand = parseAgenCDoctorCliArgs(argv);
  if (doctorCommand !== null) {
    const { runAgenCDoctorCli } = await import("./doctor-cli.js");
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
        : "agenc: daemon not running. It starts automatically with the session.\n",
    );
    // Onboarding is the moment defaults get set: surface the audit posture
    // up front (read-only; never blocks the wizard).
    try {
      const audit = await buildSecurityAuditReport({ env: process.env });
      process.stderr.write(`agenc: ${formatSecurityAuditSummaryLine(audit)}\n`);
    } catch {
      // Audit is advisory here; the wizard must not be blocked by it.
    }
    // Force the first-run wizard for this process only (never persisted);
    // consumed by shouldShowFirstRunOnboarding via the TUI's env snapshot.
    setCoreOnlyEnvironmentVariable("AGENC_ONBOARDING", "force");
    return runDefaultAgenCCliRoute(process.argv.slice(0, 2));
  }
  const securityCommand = parseAgenCSecurityCliArgs(argv);
  if (securityCommand !== null) {
    return runAgenCSecurityCli(securityCommand);
  }
  const updateCommand = parseAgenCUpdateCliArgs(argv);
  if (updateCommand !== null) {
    return runAgenCUpdateCli(updateCommand);
  }
  const gatewayCommand = parseAgenCGatewayCliArgs(argv);
  if (gatewayCommand !== null) {
    return runAgenCGatewayCli(gatewayCommand);
  }
  const budgetCommand = parseAgenCBudgetCliArgs(argv);
  if (budgetCommand !== null) {
    return runAgenCBudgetCli(budgetCommand);
  }
  const runCommand = parseAgenCRunCliArgs(argv);
  if (runCommand !== null) {
    return runAgenCRunCli(runCommand);
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
    const pluginEnvironment = Object.freeze({ ...process.env });
    const pluginRuntimeOptions = resolveAgentRuntimeOptions(pluginEnvironment);
    return runAgenCPluginCli(pluginCommand, {
      agencHome: resolveAgencHome(pluginEnvironment),
      env: pluginEnvironment,
      pluginStorageRoot: pluginRuntimeOptions.pluginStorageRoot,
      sessionTempRoot: pluginRuntimeOptions.sessionTempRoot,
      workspaceRoot: process.cwd(),
    });
  }
  const skillsCommand = parseAgenCSkillsCliArgs(argv);
  if (skillsCommand !== null) {
    const skillsEnvironment = Object.freeze({ ...process.env });
    const skillsRuntimeOptions = resolveAgentRuntimeOptions(skillsEnvironment);
    const { runAgenCSkillsCli } = await import("../skills/skills-cli.js");
    return runAgenCSkillsCli(skillsCommand, {
      agencHome: resolveAgencHome(skillsEnvironment),
      env: skillsEnvironment,
      pluginStorageRoot: skillsRuntimeOptions.pluginStorageRoot,
      workspaceRoot: process.cwd(),
    });
  }
  const permissionsCommand = parseAgenCPermissionsCliArgs(argv);
  if (permissionsCommand !== null) {
    return runAgenCPermissionsCli(permissionsCommand);
  }
  const stateCommand = parseAgenCStateCliArgs(argv);
  if (stateCommand !== null) {
    return runAgenCStateCli(stateCommand, {
      recoveryMutations: createRecoveryMutationAdapter(),
    });
  }
  const trajectoriesCommand = parseAgenCTrajectoriesCliArgs(argv);
  if (trajectoriesCommand !== null) {
    const { runAgenCTrajectoriesCli } = await import("./trajectories-cli.js");
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
  return (
    process.env.AGENC_LOGIN_NO_TUI !== "1" &&
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stdout.isTTY)
  );
}


function runDefaultAgenCCliRoute(argv: readonly string[]): Promise<number> {
  return runDefaultCliRoute(argv, { bootTUIEntry, resumeTUIEntry, continueTUIEntry, oneShotCLI });
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

if (isDirectInvocation() && selectAgenCCliEntry() === "main") {
  void runCliProcessMain(main);
}
/** Compatibility entry retains the existing dependency-injection seam. */
export function oneShotCLI(userMessage: string | null = null, startupImages: readonly string[] = [],
  parsedStartupCliFlags?: StartupCliFlags, continueSession?: OneShotContinueSession): Promise<number> {
  return runDaemonOneShotCLI(userMessage, startupImages, parsedStartupCliFlags, continueSession, daemonCliDeps());
}
