import "../bootstrap/node-env.js";
import { resolveCliCwdForStartup } from "./cli-cwd.js";
import { requireProjectTrustForTui } from "./project-trust-preflight.js";
import { cliStartupErrorMessage } from "./cli-process-main.js";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { APPROVAL_DENIED_ABORT_REASON, classifyTurnTerminal, type TurnTerminal } from "../contracts/turn-terminal.js";
import { extractFlagValues, stripRoutingFlags, type OneShotContinueSession, type ResumeTUIArgs } from "./route.js";
import { readPromptStdin } from "./prompt-stdin.js";
import type { LLMMessage } from "../llm/types.js";
import { normalizeUserImageInput, userImageInputsToContentParts } from "../prompts/attachments/user-image-input.js";
import { resolveAgentRuntimeOptions, type AgentRuntimeOptions } from "../session/runtime-options.js";
import { goalKickoffPrompt, goalSetRequestParams } from "../commands/goal.js";
import { parseGoalCommand } from "../goal/intake.js";
import { ConfigStore } from "../config/store.js";
import { resolveAgencHome } from "../config/env.js";
import { resolveHomeContext } from "../config/home.js";
import { collectDaemonClientEnvOverrides, createConnectedAgenCJsonLineDaemonTuiClient, defaultEnsureDaemonReady } from "../app-server/agent-cli.js";
import type { createAgenCDaemonOnlyTuiContext, findAgenCDaemonAgentBySessionId, resumeAgenCDaemonPromptAgent, startAgenCDaemonPromptAgent, stopAgenCDaemonPromptAgent } from "../app-server-client/index.js";
import type { AgentCreateParams, AgentStopParams, JsonObject, MessageContentBlock, MessageStreamResult, SessionGoalSetRequest } from "../app-server/protocol/index.js";
import { USER_ADDRESSABLE_PERMISSION_MODES } from "../permissions/types.js";
import { readRunDeadlineFlags, readStartupCliFlags, resolveCanonicalStartupSelection, resolvedStartupProfileName, startupConfigLayerOptions, type StartupCliFlags } from "./startup-selection.js";
import { resolveStartupSandboxBypass, writeStartupSandboxBypassNotice } from "./bypass-approvals.js";
import { installAgenCShutdownSignalHandlers } from "../lifecycle/signal-handlers.js";
import { registerProcessOutputErrorHandlers } from "../utils/process.js";
import { isRecord } from "../utils/record.js";

const DEFAULT_ONE_SHOT_DEPS: AgenCDaemonCliDeps = {
  createConnectedTuiClient: createConnectedAgenCJsonLineDaemonTuiClient,
  ensureDaemonReady: defaultEnsureDaemonReady,
  startPromptAgent: async (...args) => (await import("../app-server-client/index.js")).startAgenCDaemonPromptAgent(...args),
  resumePromptAgent: async (...args) => (await import("../app-server-client/index.js")).resumeAgenCDaemonPromptAgent(...args),
  stopPromptAgent: async (...args) => (await import("../app-server-client/index.js")).stopAgenCDaemonPromptAgent(...args),
  findAgentBySessionId: async (...args) => (await import("../app-server-client/index.js")).findAgenCDaemonAgentBySessionId(...args),
  createTuiContext: async (...args) => (await import("../app-server-client/index.js")).createAgenCDaemonOnlyTuiContext(...args),
  resumeTui: async (...args) => (await import("./agenc-main.js")).resumeTUIEntry(...args),
};

export type AgenCDaemonCliDeps = {
  readonly startPromptAgent: typeof startAgenCDaemonPromptAgent;
  readonly resumePromptAgent: typeof resumeAgenCDaemonPromptAgent;
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
  readonly resumeTui: (
    args: ResumeTUIArgs,
    startupCliFlags?: StartupCliFlags,
  ) => Promise<number>;
};

// ─────────────────────────────────────────────────────────────────────
// Argv / stdin / env resolution
// ─────────────────────────────────────────────────────────────────────

async function readStdin(signal: AbortSignal): Promise<string> {
  if (process.stdin.isTTY) return "";
  try {
    return await readPromptStdin(process.stdin, signal);
  } catch (error) {
    if (signal.aborted) throw new InitAbortedError("stdin read aborted");
    throw error;
  }
}

export type OneShotOutputFormat = "text" | "json" | "stream-json";

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

export function startupImageMessagesFromInputs(
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

export function startupContentFromInputs(
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
  const text = prompt;
  return [
    ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
    ...imageParts,
  ];
}

// ─────────────────────────────────────────────────────────────────────
// I-51: Init step abort propagates cleanly.
// ─────────────────────────────────────────────────────────────────────

/**
 * Thrown when pre-daemon one-shot setup observes its lifecycle AbortSignal.
 * The one-shot boundary maps it to the shared signal handler's exit code.
 */
class InitAbortedError extends Error {
  constructor(message: string) {
    super(`init_aborted: ${message}`);
    this.name = "InitAbortedError";
  }
}

// ─────────────────────────────────────────────────────────────────────
// I-52: validate AGENC_HOME / $HOME/.agenc writable before anything else.
// ─────────────────────────────────────────────────────────────────────

export function validateAgencHome(
  env: NodeJS.ProcessEnv = process.env,
  mkdir: typeof mkdirSync = mkdirSync,
): string {
  if (!(env.AGENC_HOME?.trim() || env.HOME?.trim())) {
    throw new Error(
      "HOME unset and AGENC_HOME unset — set AGENC_HOME to a writable dir",
    );
  }
  const home = resolveHomeContext(env, {
    ...(env.HOME?.trim() ? { platformHome: env.HOME.trim() } : {}),
  }).path;
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

type ConnectedDaemonTuiClient = Awaited<
  ReturnType<typeof createConnectedAgenCJsonLineDaemonTuiClient>
>;

export async function stopDaemonAgentBestEffort(params: {
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
  /** `turn_failed` code (`compact_failed`, `max_turns`, …); absent for run death. */
  readonly failureCode?: string;
  /** The turn ended because a permission request was denied. */
  readonly approvalDenied?: true;
};

type OneShotJsonResult = {
  readonly type: "result";
  readonly sessionId: string;
  readonly agentId: string;
  readonly exitCode: number;
  /** Continuation turns started after a `compact_failed` stop (#2497). */
  readonly compactFailedRetries?: number;
  readonly finalMessage: string;
  readonly deniedPermissionRequestIds: readonly string[];
  readonly tokenUsage?: unknown;
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

function daemonOneShotCompletionWarning(
  event: unknown,
  sessionId: string,
  turnId: string | undefined,
): { readonly id: string; readonly message: string } | null {
  const params = daemonEventParams(event);
  const transcriptEvent = daemonNestedTranscriptEvent(event);
  if (params?.sessionId !== sessionId || turnId === undefined ||
      transcriptEvent?.type !== "warning" || !isJsonRecord(transcriptEvent.payload)) return null;
  const payload = transcriptEvent.payload;
  if (
    (payload.cause !== "completion_gate_exhausted" &&
      payload.cause !== "completion_gate_partial") ||
    typeof payload.message !== "string"
  ) return null;
  const scopes = [params.turnId, transcriptEvent.turnId, payload.turnId].filter(
    (scope): scope is string => typeof scope === "string",
  );
  if (scopes.length === 0 || scopes.some((scope) => scope !== turnId)) return null;
  const id = params.eventId ?? transcriptEvent.id;
  return typeof id === "string" && id.length > 0 ? { id, message: payload.message } : null;
}

/**
 * Assistant text carried by one daemon event: a streamed delta, or the
 * complete message the daemon emits once the deltas are done. The daemon
 * sends both for the same message, so the caller must reconcile them
 * (see oneShotFinalMessageRemainder) or print mode writes the answer twice.
 */
type OneShotMessageChunk =
  | { readonly kind: "delta"; readonly text: string }
  | { readonly kind: "final"; readonly text: string };

function daemonOneShotMessageChunk(
  event: unknown,
): OneShotMessageChunk | null {
  if (!isJsonRecord(event)) return null;
  const params = daemonEventParams(event);
  if (
    event.method === "event.message_chunk" &&
    params !== null &&
    typeof params.delta === "string"
  ) {
    return { kind: "delta", text: params.delta };
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
    return { kind: "delta", text: payload.delta };
  }
  if (
    transcriptEvent.type === "agent_message" &&
    payload !== null &&
    typeof payload.message === "string"
  ) {
    return { kind: "final", text: payload.message };
  }
  return null;
}

/**
 * What the complete message adds beyond the deltas already written, plus
 * the newline that ends it. With no deltas the whole message is new; when
 * the message extends the deltas only the tail is; when the two disagree
 * both are kept on separate lines, since dropping text is the worse fault.
 */
export function oneShotFinalMessageRemainder(
  streamed: string,
  message: string,
): string {
  if (streamed.length === 0) return `${message}\n`;
  if (message.startsWith(streamed)) return `${message.slice(streamed.length)}\n`;
  return `\n${message}\n`;
}

function writeOneShotJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function oneShotSnapshotFields(
  snapshot: unknown,
): Pick<OneShotJsonResult, "tokenUsage"> {
  if (!isJsonRecord(snapshot)) return {};
  return {
    ...(isJsonRecord(snapshot.tokenUsage)
      ? { tokenUsage: snapshot.tokenUsage }
      : {}),
  };
}

export function oneShotAbortExitCode(signal: AbortSignal): number {
  const reason = signal.reason;
  if (
    isJsonRecord(reason) &&
    typeof reason.exitCode === "number" &&
    Number.isInteger(reason.exitCode) &&
    reason.exitCode >= 0 &&
    reason.exitCode <= 255
  ) {
    return reason.exitCode;
  }
  return 130;
}

function oneShotAbortDescription(signal: AbortSignal): string {
  const reason = signal.reason;
  if (
    isJsonRecord(reason) &&
    reason.reason === "broken_pipe" &&
    (reason.stream === "stdout" || reason.stream === "stderr")
  ) {
    return `${reason.stream} closed`;
  }
  if (isJsonRecord(reason) && typeof reason.signal === "string") {
    return `${reason.signal} during one-shot`;
  }
  return String(reason ?? "aborted");
}

function oneShotAbortedByBrokenPipe(signal: AbortSignal): boolean {
  const reason = signal.reason;
  return isJsonRecord(reason) && reason.reason === "broken_pipe";
}

/**
 * Detect a daemon `event.permission_request` and extract the `requestId` the
 * client must answer.
 *
 * The one-shot `--print` CLI is inherently non-interactive: there is no human
 * attached to answer an "ask"/"pause" permission request. The session runs in
 * the permission mode it was started with (`default` unless overridden), so a
 * read-only tool inside the workspace runs on its own while an edit or a shell
 * command surfaces an "ask", and the runner suspends the turn awaiting a client
 * decision that never arrives — the run hangs until the wrapper SIGTERMs it.
 * (A run created with an unattended allow/deny list pauses on every unlisted
 * tool the same way.) Answering the request
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
 * Exit code for a print-mode run whose turn stopped because a tool effect has
 * an unknown outcome and nobody attached can review it (#2501). Distinct from
 * a task failure (1) and a denied tool (2) so harnesses can classify it and
 * an operator knows to review the journal before re-running.
 */
const ONE_SHOT_EFFECT_REVIEW_EXIT_CODE = 3;

/**
 * Exit code for a print-mode run whose turn ended because the model kept
 * returning empty samples after the unattended retry ladder (#2502). Distinct
 * from a task failure (1) so a harness can retry the run instead of grading
 * it; the work was not wrong, the provider produced nothing.
 */
const ONE_SHOT_EMPTY_RESPONSE_EXIT_CODE = 4;

/**
 * Exit code for a print-mode run stopped by its `--deadline` (#2503). The
 * harness grades whatever the run saved; the run itself did not fail.
 */
const ONE_SHOT_DEADLINE_EXIT_CODE = 5;

const ONE_SHOT_DEADLINE_MARKER =
  "agenc: the run reached its --deadline and was stopped; grade the files it saved.";

const ONE_SHOT_DEADLINE_BACKSTOP_MESSAGE =
  "Run stopped at its deadline by the client: the daemon did not end the turn in time.";

/**
 * How long past the deadline the client waits for the daemon's own
 * `deadline_reached` before interrupting the turn itself, and how long it
 * then waits for a terminal before exiting anyway. Both fit inside the
 * Harbor adapter's default 120 s margin.
 */
const ONE_SHOT_DEADLINE_BACKSTOP_DEFAULTS = { afterDeadlineMs: 20_000, settleMs: 10_000 };

export type OneShotDeadlineBackstopGlobal = typeof globalThis & {
  __agencOneShotDeadlineBackstop?: { afterDeadlineMs: number; settleMs: number } | null;
};

function oneShotDeadlineBackstopTiming(): { afterDeadlineMs: number; settleMs: number } {
  return (
    (globalThis as OneShotDeadlineBackstopGlobal).__agencOneShotDeadlineBackstop ??
    ONE_SHOT_DEADLINE_BACKSTOP_DEFAULTS
  );
}

function scheduleOneShotTimer(delayMs: number, fire: () => void): () => void {
  const timer = setTimeout(fire, Math.max(0, delayMs));
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
}

const ONE_SHOT_EMPTY_RESPONSE_MARKER =
  "agenc: the model returned no assistant output after the retry ladder; " +
  "the provider produced empty samples, so this run is retryable rather " +
  "than a task failure.";

const ONE_SHOT_EFFECT_REVIEW_MARKER =
  "agenc: a tool effect has an unknown outcome and needs operator review; " +
  "run `agenc state resolve-tool-call <session-id> <call-id> " +
  "<confirmed_committed|confirmed_no_effect|remains_unknown> <evidence-ref> " +
  "<evidence-sha256>` (or /resolve in a live session), then re-run.";

/**
 * Stderr marker emitted alongside {@link ONE_SHOT_TOOL_DENIED_EXIT_CODE} so a
 * human reading the run can see why it failed and how to grant the tool.
 */
const ONE_SHOT_TOOL_DENIED_MARKER =
  "agenc: tool denied in non-interactive mode; the run could not complete its " +
  "tool call and gave up. Re-run with --permission-mode or " +
  "--dangerously-bypass-approvals-and-sandbox to allow tools.";

/**
 * Failure codes a print-mode run may re-enter (#2497). A `compact_failed`
 * stop leaves the daemon session promptable with its state synced; the next
 * turn's pre-sampling compaction gets a fresh attempt at the degraded ladder.
 * Operator caps (`max_turns`, `max_budget_usd`) and the no-progress backstop
 * are deliberate stops and stay terminal.
 */
const ONE_SHOT_RETRYABLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "compact_failed",
]);

const ONE_SHOT_COMPACT_RETRIES_ENV = "AGENC_ONE_SHOT_COMPACT_RETRIES";

const DEFAULT_ONE_SHOT_COMPACT_RETRIES = 1;

const MAX_ONE_SHOT_COMPACT_RETRIES = 3;

/** Runtime-authored user turn that re-enters the task after a compact_failed stop. */
const ONE_SHOT_COMPACT_FAILED_CONTINUATION_PROMPT =
  "The previous turn stopped because context compaction failed; it did not " +
  "finish the task. Continue from where it left off using the conversation " +
  "above as your state. Do not restart work that is already done. If the " +
  "task is already complete, give the final answer now.";

function readOneShotCompactRetries(env: NodeJS.ProcessEnv): number {
  const raw = env[ONE_SHOT_COMPACT_RETRIES_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_ONE_SHOT_COMPACT_RETRIES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_ONE_SHOT_COMPACT_RETRIES;
  return Math.min(parsed, MAX_ONE_SHOT_COMPACT_RETRIES);
}

function oneShotCompactRetryNotice(
  attempt: number,
  max: number,
  message: string | undefined,
): string {
  return (
    `agenc: compaction failed mid-turn${message !== undefined && message.length > 0 ? ` (${message})` : ""}; ` +
    `continuing the task in a new turn (retry ${attempt}/${max})`
  );
}

type OneShotContinuation = {
  readonly maxRetries: number;
  readonly startTurn: (streamId: string) => Promise<MessageStreamResult>;
};

function daemonOneShotStartedTurnId(event: unknown): string | undefined {
  if (!isJsonRecord(event)) return undefined;
  const params = daemonEventParams(event);
  if (
    event.method === "event.agent_status" &&
    (params?.status === "running" || params?.runStatus === "running") &&
    typeof params.turnId === "string"
  ) return params.turnId;
  const transcriptEvent = daemonNestedTranscriptEvent(event);
  if (transcriptEvent?.type !== "turn_started" || !isJsonRecord(transcriptEvent.payload)) return undefined;
  return typeof transcriptEvent.payload.turnId === "string" ? transcriptEvent.payload.turnId : undefined;
}

function daemonOneShotFinalStatus(
  event: unknown,
  expectedTurnId?: string,
): DaemonOneShotFinalStatus | null {
  if (!isJsonRecord(event)) return null;
  const params = daemonEventParams(event);
  const notificationTurnId = typeof params?.turnId === "string" ? params.turnId : undefined;
  if (expectedTurnId !== undefined && notificationTurnId !== undefined && notificationTurnId !== expectedTurnId) return null;
  if (event.method === "event.agent_status" && params !== null) {
    // The projected turn terminal is the authority: an idle agent says
    // nothing about whether its turn completed or was stopped.
    const turnEvent = params.turnEvent;
    if (isJsonRecord(turnEvent) && typeof turnEvent.type === "string") {
      const embedded = classifyTurnTerminal({
        type: turnEvent.type,
        payload: turnEvent.payload,
        turnId: notificationTurnId,
      }, {
        expectedTurnId: expectedTurnId ?? notificationTurnId,
      });
      if (embedded !== undefined) return oneShotStatusForTerminal(embedded);
    }
    const runStatus =
      typeof params.runStatus === "string" ? params.runStatus : undefined;
    const status =
      typeof params.status === "string" ? params.status : undefined;
    const message =
      typeof params.message === "string" ? params.message : undefined;
    const code =
      runStatus === "stopped" ? 130
        : runStatus === "errored" ? 1
          : runStatus === "completed" ? 0
            : status === "stopped" ? 130
              : status === "error" ? 1
                : status === "idle" ? 0
                  : undefined;
    if (code !== undefined) {
      return oneShotStatusForRpcTerminal({ code, ...(message !== undefined ? { message } : {}) });
    }
  }
  const transcriptEvent = daemonNestedTranscriptEvent(event);
  if (transcriptEvent === null || typeof transcriptEvent.type !== "string") return null;
  const terminal = classifyTurnTerminal({
    type: transcriptEvent.type,
    payload: transcriptEvent.payload,
    turnId: transcriptEvent.turnId ?? notificationTurnId,
  }, {
    expectedTurnId: expectedTurnId ?? notificationTurnId,
  });
  return terminal === undefined ? null : oneShotStatusForTerminal(terminal);
}

function oneShotStatusForTerminal(terminal: TurnTerminal): DaemonOneShotFinalStatus {
  // A denial ends the turn as an abort, but it is not an interrupt: the run
  // reports it as a denied tool, with no reason code as its message.
  if (terminal.outcome === "aborted" && terminal.message === APPROVAL_DENIED_ABORT_REASON) {
    return { code: terminal.code, approvalDenied: true };
  }
  return {
    code: oneShotExitCodeForTerminal(terminal),
    ...(terminal.message !== undefined ? { message: terminal.message } : {}),
    ...(terminal.outcome === "errored" ? { failureCode: terminal.failureCode } : {}),
  };
}

/**
 * A terminal known only by its exit code and message: the `message.stream`
 * RPC result, or a status without its turn event. The denial is recognized
 * there too, so the run's outcome does not depend on which arrives first.
 */
function oneShotStatusForRpcTerminal(terminal: {
  readonly code: number;
  readonly message?: string;
}): DaemonOneShotFinalStatus {
  if (terminal.code === 130 && terminal.message === APPROVAL_DENIED_ABORT_REASON) {
    return { code: terminal.code, approvalDenied: true };
  }
  return {
    code: terminal.code,
    ...(terminal.message !== undefined ? { message: terminal.message } : {}),
  };
}

/** Bounded stops that a harness should classify apart from a task failure. */
function oneShotExitCodeForTerminal(
  terminal: { readonly outcome: string; readonly code: number; readonly failureCode?: string },
): number {
  if (terminal.outcome !== "errored") return terminal.code;
  switch (terminal.failureCode) {
    case "effect_review_required":
      return ONE_SHOT_EFFECT_REVIEW_EXIT_CODE;
    case "empty_response":
      return ONE_SHOT_EMPTY_RESPONSE_EXIT_CODE;
    case "deadline_reached":
      return ONE_SHOT_DEADLINE_EXIT_CODE;
    default:
      return terminal.code;
  }
}

interface DaemonOneShotRunOutcome {
  readonly code: number;
  readonly cancelled: boolean;
}

/**
 * Stream one daemon turn to the terminal and settle on its outcome.
 *
 * Shared by the fresh one-shot path (the turn was started by `agent.create`)
 * and by headless `-c` / `--resume` (the turn is started here through
 * `message.stream` once the event subscription is live). Output chunks go to
 * stdout as they arrive, unanswerable permission requests are denied so the
 * run cannot hang, and the exit code comes from the classified terminal
 * event, or from the `terminal` the `message.stream` RPC returns.
 */
export async function awaitDaemonOneShotRun(params: {
  readonly daemonClient: Awaited<
    ReturnType<AgenCDaemonCliDeps["createConnectedTuiClient"]>
  >;
  readonly sessionId: string;
  readonly agentId: string;
  readonly outputFormat: OneShotOutputFormat;
  readonly signal: AbortSignal;
  /** Continue mode: submit the prompt as a new turn of the attached session. */
  readonly startTurn?: (streamId: string) => Promise<MessageStreamResult>;
  /** Re-enter the session after a retryable bounded stop (#2497). */
  readonly continuation?: OneShotContinuation;
  /** The run's `--deadline` (epoch ms); arms the client backstop (#2503). */
  readonly deadlineAt?: number;
}): Promise<DaemonOneShotRunOutcome> {
  const { daemonClient, sessionId, outputFormat } = params;
  let unsubscribeEvents: (() => void) | null = null;
  let unsubscribeConnection: (() => void) | null = null;
  let cancelled = false;
  let printedAssistantOutput = false;
  let assistantOutput = "";
  let lastPrintedChar = "";
  // Deltas of the assistant message currently streaming; reset by its
  // complete message so the two are never written twice.
  let streamedMessage = "";
  const collectedEvents: unknown[] = [];
  const printedCompletionWarnings = new Set<string>();
  // In continue mode the stream id we choose is the daemon's turn id, so
  // terminal events of any other turn (a replayed history item, an unrelated
  // client's turn) never settle this run.
  let expectedTurnId: string | undefined =
    params.startTurn !== undefined ? randomUUID() : undefined;
  let activeTurnId: string | undefined = expectedTurnId;
  let retriesUsed = 0;
  // The failure code of the latest classified terminal event, so a terminal
  // arriving through the `message.stream` RPC result can still be retried.
  let lastFailureCode: string | undefined;
  try {
    const deniedPermissionRequestIds = new Set<string>();
    const code = await new Promise<number>((resolve, reject) => {
      let settled = false;
      let finalizing = false;
      let onAbort: (() => void) | null = null;
      let disposeDeadlineBackstop: (() => void) | null = null;
      const settle = (
        next: { readonly code: number } | { readonly error: Error },
      ) => {
        if (settled) return;
        settled = true;
        disposeDeadlineBackstop?.();
        if (onAbort !== null) {
          params.signal.removeEventListener("abort", onAbort);
        }
        unsubscribeEvents?.();
        unsubscribeConnection?.();
        if ("error" in next) {
          reject(next.error);
        } else {
          resolve(next.code);
        }
      };
      onAbort = () => {
        cancelled = true;
        settle({ code: oneShotAbortExitCode(params.signal) });
      };
      params.signal.addEventListener("abort", onAbort, { once: true });
      if (params.signal.aborted) {
        onAbort();
        return;
      }
      const snapshotFieldsForStructuredOutput = async (): Promise<
        Pick<OneShotJsonResult, "tokenUsage">
      > => {
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
        const snapshotFields = await snapshotFieldsForStructuredOutput();
        if (settled) return;
        const jsonResult: OneShotJsonResult = {
          type: "result",
          sessionId,
          agentId: params.agentId,
          exitCode: result.exitCode,
          finalMessage: result.finalMessage,
          ...(retriesUsed > 0 ? { compactFailedRetries: retriesUsed } : {}),
          deniedPermissionRequestIds: [...deniedPermissionRequestIds],
          ...snapshotFields,
          ...(outputFormat === "json" ? { events: collectedEvents } : {}),
        };
        if (outputFormat === "json") {
          process.stdout.write(`${JSON.stringify(jsonResult)}\n`);
        } else if (outputFormat === "stream-json") {
          writeOneShotJsonLine(jsonResult);
        }
      };

      // Shared terminal path for both signals a run can end on: the classified
      // session/agent event, or (continue mode) the `terminal` the daemon
      // returns when the `message.stream` RPC completes.
      const finalize = async (
        finalStatus: DaemonOneShotFinalStatus,
      ): Promise<void> => {
        if (finalizing) return;
        finalizing = true;
        const continuation = params.continuation;
        if (
          continuation !== undefined &&
          finalStatus.failureCode !== undefined &&
          ONE_SHOT_RETRYABLE_FAILURE_CODES.has(finalStatus.failureCode) &&
          retriesUsed < continuation.maxRetries
        ) {
          // A bounded stop the session can recover from: start one more turn
          // on the same attached session instead of ending the run. A new
          // stream id becomes the expected turn id, so late events of the
          // failed turn never settle this run.
          retriesUsed += 1;
          const retryTurnId = randomUUID();
          expectedTurnId = retryTurnId;
          activeTurnId = retryTurnId;
          lastFailureCode = undefined;
          streamedMessage = "";
          finalizing = false;
          if (outputFormat === "text") {
            if (printedAssistantOutput && lastPrintedChar !== "\n") {
              process.stdout.write("\n");
              lastPrintedChar = "\n";
            }
            process.stderr.write(
              `${oneShotCompactRetryNotice(retriesUsed, continuation.maxRetries, finalStatus.message)}\n`,
            );
          }
          dispatchTurn(continuation.startTurn, retryTurnId);
          return;
        }
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
        if (finalStatus.failureCode === "effect_review_required") {
          process.stderr.write(`${ONE_SHOT_EFFECT_REVIEW_MARKER}\n`);
        }
        if (finalStatus.failureCode === "empty_response") {
          process.stderr.write(`${ONE_SHOT_EMPTY_RESPONSE_MARKER}\n`);
        }
        if (finalStatus.failureCode === "deadline_reached") {
          process.stderr.write(`${ONE_SHOT_DEADLINE_MARKER}\n`);
        }
        // A tool-blocked giveup must NOT masquerade as a successful answer.
        // When the run auto-denied a permission request (no human to approve;
        // see daemonOneShotPermissionRequestId) and then "completed", the
        // model gave up after its tool call was rejected. Override the
        // otherwise-zero exit so callers/scripts can distinguish a real answer
        // from a tool-blocked giveup, and surface a clear stderr marker. A run
        // that denied nothing keeps its normal exit code, so genuine no-tool
        // answers still exit 0 and genuine daemon errors still exit non-zero.
        // A turn the denial itself ended is the same tool-blocked outcome.
        if (
          (finalStatus.code === 0 && deniedPermissionRequestIds.size > 0) ||
          finalStatus.approvalDenied === true
        ) {
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
      };

      // Deadline backstop (#2503): the daemon ends the turn at the deadline
      // on its own. If it has not by shortly after, interrupt the turn from
      // here and exit with the deadline code anyway, before the harness
      // that set the deadline kills the process with nothing written.
      if (params.deadlineAt !== undefined) {
        const timing = oneShotDeadlineBackstopTiming();
        const cancelTimers: Array<() => void> = [];
        disposeDeadlineBackstop = () => {
          for (const cancel of cancelTimers.splice(0)) cancel();
        };
        cancelTimers.push(scheduleOneShotTimer(
          params.deadlineAt + timing.afterDeadlineMs - Date.now(),
          () => {
            if (settled || finalizing) return;
            void daemonClient.request("session.cancelTurn", {
              sessionId,
              reason: "deadline_reached",
              ...(activeTurnId !== undefined ? { expectedTurnId: activeTurnId } : {}),
            }).catch(() => {});
            cancelTimers.push(scheduleOneShotTimer(timing.settleMs, () => {
              if (settled || finalizing) return;
              void finalize({
                code: ONE_SHOT_DEADLINE_EXIT_CODE,
                message: ONE_SHOT_DEADLINE_BACKSTOP_MESSAGE,
                failureCode: "deadline_reached",
              });
            }));
          },
        ));
      }

      unsubscribeConnection = daemonClient.subscribeToConnectionState(
        (state) => {
          if (state.status === "disconnected") {
            settle({
              error: new Error(state.message ?? "daemon connection closed"),
            });
          }
        },
      );

      unsubscribeEvents = daemonClient.subscribeToSessionEvents(
        sessionId,
        (event) => {
          if (settled) return;
          if (outputFormat === "json") {
            collectedEvents.push(event);
          } else if (outputFormat === "stream-json") {
            writeOneShotJsonLine({
              type: "event",
              sessionId,
              agentId: params.agentId,
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
          if (chunk !== null) {
            // Deltas stream as they arrive; the complete message that
            // follows them contributes only what was not streamed, so the
            // answer is written once whichever events the daemon sends.
            const text =
              chunk.kind === "delta"
                ? chunk.text
                : oneShotFinalMessageRemainder(streamedMessage, chunk.text);
            streamedMessage =
              chunk.kind === "delta" ? streamedMessage + chunk.text : "";
            if (text.length > 0) {
              assistantOutput += text;
              if (outputFormat === "text") {
                process.stdout.write(text);
              }
              printedAssistantOutput = true;
              lastPrintedChar = text.at(-1) ?? lastPrintedChar;
            }
          }

          activeTurnId ??= daemonOneShotStartedTurnId(event);
          if (outputFormat === "text") {
            const warning = daemonOneShotCompletionWarning(event, sessionId, activeTurnId);
            if (warning !== null && !printedCompletionWarnings.has(warning.id)) {
              printedCompletionWarnings.add(warning.id);
              process.stderr.write(`${warning.message}\n`);
            }
          }
          const finalStatus = daemonOneShotFinalStatus(event, activeTurnId);
          if (finalStatus === null) return;
          lastFailureCode = finalStatus.failureCode;
          void finalize(finalStatus).catch((error: unknown) => {
            settle({
              error: error instanceof Error ? error : new Error(String(error)),
            });
          });
        },
      );

      // Continue mode and compact_failed retries: the session already
      // exists, so the turn is started here, after the event subscription is
      // live. The RPC resolves when the turn ends and carries its terminal
      // outcome; the events above stream the output and may settle first,
      // whichever arrives.
      function dispatchTurn(
        start: (streamId: string) => Promise<MessageStreamResult>,
        streamId: string,
      ): void {
        // A compact_failed retry replaces activeTurnId. From then on this
        // stream's RPC outcome, resolved or rejected, belongs to the superseded
        // turn and must not settle the run while the retry is still working.
        void start(streamId)
          .then(
            (result) => {
              if (
                settled ||
                streamId !== activeTurnId ||
                result.terminal === undefined
              ) {
                return;
              }
              return finalize({
                ...oneShotStatusForRpcTerminal(result.terminal),
                ...(lastFailureCode !== undefined
                  ? { failureCode: lastFailureCode }
                  : {}),
              });
            },
            (error: unknown) => {
              if (streamId !== activeTurnId) return;
              throw error;
            },
          )
          .catch((error: unknown) => {
            settle({
              error: error instanceof Error ? error : new Error(String(error)),
            });
          });
      }
      const startTurn = params.startTurn;
      if (startTurn !== undefined && expectedTurnId !== undefined) {
        dispatchTurn(startTurn, expectedTurnId);
      }
    });
    return { code, cancelled };
  } finally {
    // Assigned inside the executor above; the narrowing to null is stale here.
    const stopEvents = unsubscribeEvents as (() => void) | null;
    const stopConnection = unsubscribeConnection as (() => void) | null;
    stopEvents?.();
    stopConnection?.();
  }
}

/** One continuation turn per retry after a `compact_failed` stop (#2497). */
export function oneShotCompactFailedContinuation(params: {
  readonly daemonClient: Awaited<
    ReturnType<AgenCDaemonCliDeps["createConnectedTuiClient"]>
  >;
  readonly sessionId: string;
  readonly exactOutput: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}): { readonly continuation?: OneShotContinuation } {
  const maxRetries = readOneShotCompactRetries(params.env);
  if (maxRetries === 0) return {};
  return {
    continuation: {
      maxRetries,
      startTurn: (streamId) =>
        params.daemonClient.request(
          "message.stream",
          {
            sessionId: params.sessionId,
            exactOutput: params.exactOutput,
            content: ONE_SHOT_COMPACT_FAILED_CONTINUATION_PROMPT,
            clientMessageId: randomUUID(),
            streamId,
          },
          { signal: params.signal },
        ),
    },
  };
}

/**
 * `agenc -p "/goal <objective> [flags]"`. Print mode has no slash dispatcher,
 * so the one goal action that makes sense without a person attached, starting
 * a goal, is recognized here and parsed by the same intake as the TUI.
 */
export type PrintModeGoal =
  | { readonly kind: "none" }
  | {
      readonly kind: "set";
      readonly request: SessionGoalSetRequest;
      readonly kickoff: string;
    }
  | { readonly kind: "error"; readonly message: string };

export function parsePrintModeGoal(prompt: string): PrintModeGoal {
  const match = /^\s*\/goal(?:\s+([\s\S]*))?$/u.exec(prompt);
  if (match === null) return { kind: "none" };
  const parsed = parseGoalCommand(match[1] ?? "");
  if (parsed.kind === "error") return { kind: "error", message: parsed.message };
  if (parsed.kind !== "set") {
    return {
      kind: "error",
      message: `print mode can only start a goal: /goal <objective> [flags]. Use the TUI for /goal ${parsed.kind}.`,
    };
  }
  return {
    kind: "set",
    request: goalSetRequestParams(parsed.request),
    kickoff: goalKickoffPrompt(parsed.request),
  };
}

export type PrintModeGoalSet = Extract<PrintModeGoal, { kind: "set" }>;

/** Set the goal before the first turn, so no answer can outrun it. */
export async function setPrintModeGoal(
  daemonClient: OneShotContinueDaemonClient,
  sessionId: string,
  goal: PrintModeGoalSet,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await daemonClient.request(
    "session.goal",
    { sessionId, action: "set", request: goal.request },
    { signal },
  );
  if (!result.ok) {
    process.stderr.write(`agenc: ${result.message ?? "the goal was refused"}\n`);
  }
  return result.ok;
}

/**
 * A goal run succeeds only when the goal was met. Budget, stall, impossible
 * and blocked are reported with the reviewer's reason and exit 1, so a script
 * can tell "the agent stopped" from "the goal holds".
 */
export async function printModeGoalExitCode(
  daemonClient: OneShotContinueDaemonClient,
  sessionId: string,
  runCode: number,
  signal: AbortSignal,
): Promise<number> {
  if (runCode !== 0) return runCode;
  const { goal } = await daemonClient.request(
    "session.goal",
    { sessionId, action: "get" },
    { signal },
  );
  if (goal === undefined) {
    process.stderr.write("agenc: the goal's final state is unavailable\n");
    return 1;
  }
  const reason = goal.pauseReason ?? goal.lastVerdict?.reason;
  process.stderr.write(
    `agenc: goal ${goal.status.replace("_", " ")} ${goal.rounds === 0 ? "on the first check" : `after ${goal.rounds} ${goal.rounds === 1 ? "round" : "rounds"}`}${reason !== undefined ? `: ${reason}` : ""}\n`,
  );
  return goal.status === "met" ? 0 : 1;
}

async function runDaemonOneShotPrompt(params: {
  readonly deps: AgenCDaemonCliDeps;
  readonly prompt: string;
  readonly env: NodeJS.ProcessEnv;
  readonly runtimeOptions: AgentRuntimeOptions;
  readonly cwd: string;
  readonly outputFormat?: OneShotOutputFormat;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly configPath?: string;
  readonly addDirs?: readonly string[];
  readonly initialContent?: string | readonly MessageContentBlock[];
  readonly permissionMode?: AgentCreateParams["permissionMode"];
  readonly goal?: PrintModeGoalSet;
  readonly signal: AbortSignal;
}): Promise<number> {
  if (params.signal.aborted) {
    return oneShotAbortExitCode(params.signal);
  }
  await params.deps.ensureDaemonReady(params.env)();
  if (params.signal.aborted) {
    return oneShotAbortExitCode(params.signal);
  }
  const daemonClient = await params.deps.createConnectedTuiClient({
    env: params.env,
  });
  let startedAgentId: string | null = null;
  let completed = false;
  let cancelled = false;
  const outputFormat = params.outputFormat ?? "text";

  try {
    if (params.signal.aborted) {
      cancelled = true;
      return oneShotAbortExitCode(params.signal);
    }
    const envOverrides = collectDaemonClientEnvOverrides(params.env);
    const createParams: AgentCreateParams = {
      objective: params.prompt,
      instructions: params.prompt,
      cwd: params.cwd,
      runtimeOptions: { ...params.runtimeOptions, exactOutput: outputFormat !== "text",
        relaxedOneShot: params.runtimeOptions.relaxedOneShot === true && params.goal === undefined },
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.provider !== undefined ? { provider: params.provider } : {}),
      ...(params.profile !== undefined ? { profile: params.profile } : {}),
      ...(params.configPath !== undefined
        ? { configPath: params.configPath }
        : {}),
      ...(params.addDirs !== undefined
        ? { addDirs: [...params.addDirs] }
        : {}),
      // A goal run provisions the session first: the goal must be set before
      // the kickoff turn can produce an answer.
      ...(params.goal !== undefined
        ? { deferInitialTurn: true }
        : params.initialContent !== undefined
          ? { initialContent: params.initialContent }
          : {}),
      ...(params.permissionMode !== undefined
        ? { permissionMode: params.permissionMode }
        : {}),
      ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
      metadata: {
        source: "agenc.prompt",
        mode: "one-shot",
        ...(params.goal !== undefined ? { goalRun: true } : {}),
      },
    };
    const started = await daemonClient.request("agent.create", createParams, {
      signal: params.signal,
    });
    startedAgentId = started.agentId;
    if (params.signal.aborted) {
      cancelled = true;
      return oneShotAbortExitCode(params.signal);
    }
    const attachment = await daemonClient.request(
      "agent.attach",
      {
        agentId: started.agentId,
        oneShotOutput: true,
        clientId: `agenc-one-shot-${process.pid}`,
      },
      { signal: params.signal },
    );
    if (params.signal.aborted) {
      cancelled = true;
      return oneShotAbortExitCode(params.signal);
    }
    const sessionId =
      attachment.sessionIds[0] ??
      started.sessionId ??
      started.activeSessionIds?.[0];
    if (sessionId === undefined) {
      throw new Error(
        `daemon agent has no attached session: ${started.agentId}`,
      );
    }
    const goal = params.goal;
    if (
      goal !== undefined &&
      !(await setPrintModeGoal(daemonClient, sessionId, goal, params.signal))
    ) {
      return 1;
    }

    const run = await awaitDaemonOneShotRun({
      daemonClient,
      sessionId,
      agentId: started.agentId,
      outputFormat,
      signal: params.signal,
      ...(params.runtimeOptions.deadlineAt !== undefined
        ? { deadlineAt: params.runtimeOptions.deadlineAt }
        : {}),
      ...(goal !== undefined
        ? {
            startTurn: (streamId: string) =>
              daemonClient.request(
                "message.stream",
                {
                  sessionId,
                  content: goal.kickoff,
                  exactOutput: outputFormat !== "text",
                  clientMessageId: randomUUID(),
                  streamId,
                },
                { signal: params.signal },
              ),
          }
        : {}),
      ...oneShotCompactFailedContinuation({
        daemonClient,
        sessionId,
        env: params.env,
        signal: params.signal,
        exactOutput: (params.outputFormat ?? "text") !== "text",
      }),
    });
    cancelled = run.cancelled;
    completed = !cancelled;
    return goal !== undefined && !cancelled
      ? await printModeGoalExitCode(daemonClient, sessionId, run.code, params.signal)
      : run.code;
  } catch (error) {
    if (params.signal.aborted) cancelled = true;
    throw error;
  } finally {
    // One-shot agents are terminal resources, not resumable conversations.
    // Closing the transport alone leaves the daemon-owned runtime, provider,
    // session and rollout references alive indefinitely. Always stop the agent
    // after collecting the terminal snapshot so the daemon can release those
    // resources on both success and failure.
    if (startedAgentId !== null) {
      await stopDaemonAgentBestEffort({
        deps: params.deps,
        daemonClient,
        env: params.env,
        agentId: startedAgentId,
        reason: oneShotStopReason(cancelled, completed),
      });
    }
    await daemonClient.close().catch(() => {
      /* best effort */
    });
  }
}

/** Stop reason a one-shot run reports for the agent it owns. */
export function oneShotStopReason(
  cancelled: boolean,
  completed: boolean,
): "one_shot_cancelled" | "one_shot_complete" | "one_shot_failed" {
  if (cancelled) return "one_shot_cancelled";
  return completed ? "one_shot_complete" : "one_shot_failed";
}

export type OneShotContinueDaemonClient = Awaited<
  ReturnType<AgenCDaemonCliDeps["createConnectedTuiClient"]>
>;

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
  parsedStartupCliFlags?: StartupCliFlags,
  continueSession?: OneShotContinueSession,
  deps: AgenCDaemonCliDeps = DEFAULT_ONE_SHOT_DEPS,
): Promise<number> {
  const lifecycleAbort = new AbortController();
  const shutdownSignal = installAgenCShutdownSignalHandlers((event) => {
    lifecycleAbort.abort(event);
  });
  const outputErrors = registerProcessOutputErrorHandlers(({ stream }) => {
    lifecycleAbort.abort({
      reason: "broken_pipe",
      stream,
      exitCode: 0,
    });
  });

  const throwIfAborted = (step: string) => {
    if (lifecycleAbort.signal.aborted) {
      throw new InitAbortedError(
        `${step}: ${oneShotAbortDescription(lifecycleAbort.signal)}`,
      );
    }
  };

  try {
    const startupCliFlags =
      parsedStartupCliFlags ?? readStartupCliFlags(process.argv);
    const sessionEnv = process.env;
    const sandboxBypass = resolveStartupSandboxBypass(startupCliFlags, {
      cwd: process.cwd(),
      env: sessionEnv,
    });
    writeStartupSandboxBypassNotice(sandboxBypass);
    const oneShotArgv = process.argv.slice(2);
    const outputFormat = readOneShotOutputFormat(oneShotArgv);
    const runtimeOptions = resolveAgentRuntimeOptions(sessionEnv, {
      simpleMode: startupCliFlags.simpleMode === true,
    ...(startupCliFlags.lightMode === true ? { lightMode: true } : {}),
      dangerouslyBypassApprovalsAndSandbox:
        sandboxBypass.dangerouslyBypassApprovalsAndSandbox,
      // Print mode has no human attached: every permission request is
      // auto-denied below, so tools that only exist to ask a person must not
      // be offered in the first place.
      nonInteractive: true,
      relaxedOneShot: startupCliFlags.fullDurability !== true && continueSession === undefined,
      exactOutput: outputFormat !== "text",
      // `--deadline` (#2503): the instant this run must end by.
      ...readRunDeadlineFlags(process.argv, Date.now()),
    });
    validateAgencHome();
    throwIfAborted("validateAgencHome");
    const agencHome = resolveAgencHome(sessionEnv);
    readOneShotInputFormat(oneShotArgv);

    const resolvedUserMessage =
      userMessage !== null && userMessage.length > 0
        ? userMessage
        : await resolveUserMessage(lifecycleAbort.signal);
    throwIfAborted("resolveUserMessage");

    const cliCwd = resolveCliCwdForStartup(sessionEnv);
    if (!cliCwd.ok) {
      process.stderr.write(`agenc: ${cliCwd.message}\n`);
      return 1;
    }
    if (
      !(await requireProjectTrustForTui({
        env: sessionEnv,
        argv: process.argv,
        startupCliFlags,
        cwd: cliCwd.cwd,
      }))
    ) {
      return 1;
    }
    throwIfAborted("requireProjectTrustForTui");

    const daemonCwd = cliCwd.cwd;
    const startupLayers = startupConfigLayerOptions({
      cli: startupCliFlags,
      cwd: daemonCwd,
    });
    const configStore = new ConfigStore({
      home: agencHome,
      env: sessionEnv,
      cwd: daemonCwd,
      ...startupLayers,
      onWarn: (message) => process.stderr.write(`${message}\n`),
    });
    const config = await configStore.reload();
    const profileName = resolvedStartupProfileName(startupCliFlags, sessionEnv);
    const startup = resolveCanonicalStartupSelection({
      config,
      ...(profileName !== undefined ? { profileName } : {}),
    });
    const resolvedStartupImages =
      startupImages.length > 0
        ? startupImages
        : extractFlagValues(process.argv.slice(2), "--image");
    const startupContent = startupContentFromInputs(
      resolvedUserMessage,
      resolvedStartupImages,
      daemonCwd,
      sessionEnv.HOME,
    );
    const daemonPrompt =
      resolvedUserMessage.trim().length > 0
        ? resolvedUserMessage
        : startupContent !== undefined
          ? "Multimodal AgenC startup"
          : resolvedUserMessage;
    // agent.create trims the objective, and without initialContent the daemon
    // sends that trimmed objective as the first user message. A text-only
    // prompt therefore also travels as initialContent, so the model receives
    // it byte for byte: leading indentation and the final newline of a stdin
    // prompt survive. A whitespace-only prompt still meets the daemon's
    // non-empty objective check exactly as before.
    const initialContent =
      startupContent ??
      (resolvedUserMessage.trim().length > 0 ? resolvedUserMessage : undefined);
    // Forward the canonical dangerous-bypass selection to the daemon so the
    // print-mode one-shot agent runs under bypassPermissions, matching
    // the bootTUI path. See GAP-PE-GUARDIAN-YOLO-LEAK.
    // Honor a validated `--permission-mode <value>` in the print path. Without
    // this, only bypassPermissions propagated and acceptEdits/plan/default were
    // silently dropped. readStartupCliFlags already validated the flag (throwing
    // on a typo so a less-restrictive session can't boot silently). A one-shot
    // carries no unattended allow/deny list, so the daemon leaves the forwarded
    // mode alone (a run that does carry one has applyUnattendedPermissionPolicyToContext
    // preserve an explicit acceptEdits/plan and rewrite only default). Explicit bypass still wins:
    // bypassPermissions takes precedence over any other forwarded mode. Narrow
    // to the daemon-accepted subset (agent.create rejects dontAsk/auto); other
    // user-addressable modes fall back to the unattended default as before.
    const oneShotPermissionMode = startupPermissionMode(startupCliFlags);
    const printGoal = parsePrintModeGoal(resolvedUserMessage);
    if (printGoal.kind === "error") {
      process.stderr.write(`agenc: ${printGoal.message}\n`);
      return 2;
    }
    const goalOption = printGoal.kind === "set" ? { goal: printGoal } : {};
    if (continueSession !== undefined) {
      // Headless -c / --resume: the prompt is one more turn of a prior session.
      // Like the TUI resume path, only explicit startup overrides travel; the
      // session keeps the provider and model it was recorded with otherwise.
      return await (await import("./daemon-one-shot-continue.js")).runDaemonOneShotContinue({
        deps,
        prompt: daemonPrompt,
        env: sessionEnv,
        runtimeOptions,
        cwd: daemonCwd,
        agencHome,
        continueSession,
        outputFormat,
        ...(startupCliFlags.model !== undefined
          ? { model: startupCliFlags.model }
          : {}),
        ...(startupCliFlags.provider !== undefined
          ? { provider: startupCliFlags.provider }
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
        ...(initialContent !== undefined ? { initialContent } : {}),
        ...(oneShotPermissionMode !== undefined
          ? { permissionMode: oneShotPermissionMode }
          : {}),
        ...goalOption,
        signal: lifecycleAbort.signal,
      });
    }
    return await runDaemonOneShotPrompt({
      deps,
      prompt: daemonPrompt,
      env: sessionEnv,
      runtimeOptions,
      cwd: daemonCwd,
      outputFormat,
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
      ...(oneShotPermissionMode !== undefined
        ? { permissionMode: oneShotPermissionMode }
        : {}),
      ...goalOption,
      signal: lifecycleAbort.signal,
    });
  } catch (error) {
    if (lifecycleAbort.signal.aborted) {
      if (
        error instanceof InitAbortedError &&
        !oneShotAbortedByBrokenPipe(lifecycleAbort.signal)
      ) {
        process.stderr.write(`agenc: ${error.message}\n`);
      }
      return oneShotAbortExitCode(lifecycleAbort.signal);
    }
    if (error instanceof InitAbortedError) {
      process.stderr.write(`agenc: ${error.message}\n`);
      return oneShotAbortExitCode(lifecycleAbort.signal);
    }
    const { SessionLockedError, SchemaMismatchError } = await import("../session/session-store.js");
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
    outputErrors.dispose();
    shutdownSignal.dispose();
  }
}

export function startupPermissionMode(
  flags: ReturnType<typeof readStartupCliFlags>,
): AgentCreateParams["permissionMode"] {
  if (flags.dangerouslyBypassApprovalsAndSandbox === true) {
    return "bypassPermissions";
  }
  return flags.permissionMode !== undefined &&
    (USER_ADDRESSABLE_PERMISSION_MODES as readonly string[]).includes(
      flags.permissionMode,
    )
    ? (flags.permissionMode as AgentCreateParams["permissionMode"])
    : undefined;
}
