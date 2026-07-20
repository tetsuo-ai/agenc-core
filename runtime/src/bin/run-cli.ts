/** Read and control durable M3 run state through the daemon protocol. */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
  RunReplayResult,
  RunStartParams,
  RunStartResult,
  RunStatusResult,
  RunWorkflowStatus,
} from "../app-server/protocol/index.js";
import {
  createAgenCJsonLineDaemonRequestClient,
  defaultEnsureDaemonReady,
  type AgenCJsonLineDaemonRequestClient,
} from "../app-server/agent-cli.js";

const MAX_RUN_PAGE_LIMIT = 200;
const FOLLOW_POLL_INTERVAL_MS = 1_000;

const RUN_START_PERMISSION_MODES = [
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
] as const;
type RunStartPermissionMode = (typeof RUN_START_PERMISSION_MODES)[number];

export interface AgenCRunStartCliCommand {
  readonly kind: "start";
  readonly goal?: string;
  readonly goalFile?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly reviewerModel?: string;
  readonly maxCostUsd?: number;
  readonly permissionMode?: RunStartPermissionMode;
  readonly verify: readonly { readonly label: string; readonly script: string }[];
  readonly json?: true;
  readonly follow?: true;
}

export type AgenCRunCliCommand =
  | { readonly kind: "status"; readonly runId: string; readonly json?: true }
  | { readonly kind: "result"; readonly runId: string }
  | {
      readonly kind: "replay" | "evidence";
      readonly runId: string;
      readonly afterSequence?: number;
      readonly limit?: number;
    }
  | { readonly kind: "cancel"; readonly runId: string; readonly reason?: string }
  | AgenCRunStartCliCommand
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface AgenCRunCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface AgenCRunCliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly io?: AgenCRunCliIo;
  readonly ensureDaemonReady?: () => Promise<void>;
  readonly client?: AgenCJsonLineDaemonRequestClient;
  /** Follow-loop pacing seam (tests replace the real timer). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export function formatAgenCRunCliHelpText(): string {
  return [
    "Usage: agenc run <command> [<run-id>] [options]",
    "",
    "Commands:",
    "  start                           Start a verified-change workflow run",
    "  status <run-id>                 Show durable run and admission state",
    "  result <run-id>                 Fetch a terminal result",
    "  replay <run-id>                 Page the admission journal",
    "  evidence <run-id>               Export hashed admission evidence",
    "  cancel <run-id>                 Cancel the run and its descendants",
    "",
    "Start options:",
    "  --goal <text>                   The engineering goal (or --goal-file)",
    "  --goal-file <path>              Read the goal from a file",
    "  --cwd <dir>                     Target repository directory (default: .)",
    "  --model <model>                 Implementer model",
    "  --reviewer-model <model>        Pinned independent reviewer model",
    "  --max-cost <usd>                Hard run cost cap",
    "  --permission-mode <mode>        default | plan | acceptEdits | bypassPermissions",
    '  --verify "label=script"         Required verification command (repeatable)',
    "  --json                          Print the raw daemon result as JSON",
    "  --follow                        Follow the run journal until terminal",
    "",
    "Status options:",
    "  --json                          Always print JSON (skip the step table)",
    "",
    "Replay/evidence options:",
    "  --after <sequence>              Exclusive journal cursor (default: 0)",
    `  --limit <count>                 Page size, 1-${MAX_RUN_PAGE_LIMIT}`,
    "",
    "Cancel options:",
    "  --reason <text>                 Journaled cancellation reason",
    "",
    "All other successful commands print canonical JSON.",
  ].join("\n");
}

export function parseAgenCRunCliArgs(
  argv: readonly string[],
): AgenCRunCliCommand | null {
  if (argv[0] !== "run") return null;
  const action = argv[1];
  if (action === undefined || action === "--help" || action === "-h") {
    return { kind: "help", text: formatAgenCRunCliHelpText() };
  }
  if (action === "start") {
    return parseRunStartArgs(argv.slice(2));
  }
  if (!isRunAction(action)) {
    // `agenc --no-tui run tools` is also a valid one-shot prompt. Only claim
    // the `run` namespace when the second token is one of this command's
    // structural verbs; otherwise leave routing to the ordinary prompt path.
    return null;
  }
  const runId = argv[2]?.trim();
  if (runId === undefined || runId.length === 0 || runId.startsWith("-")) {
    return { kind: "error", message: `run ${action} requires a run id` };
  }
  const rest = argv.slice(3);
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    return { kind: "help", text: formatAgenCRunCliHelpText() };
  }
  if (action === "status") {
    const flags = rest.filter((token) => token !== "--json");
    if (flags.length > 0) {
      return {
        kind: "error",
        message: `run status accepts exactly one run id (and --json)`,
      };
    }
    return {
      kind: "status",
      runId,
      ...(rest.includes("--json") ? { json: true as const } : {}),
    };
  }
  if (action === "result") {
    if (rest.length > 0) {
      return {
        kind: "error",
        message: `run ${action} accepts exactly one run id`,
      };
    }
    return { kind: action, runId };
  }
  if (action === "cancel") {
    const parsed = parseRunOptions(rest, new Set(["reason"]));
    if (!parsed.ok) return { kind: "error", message: parsed.message };
    return {
      kind: "cancel",
      runId,
      ...(parsed.values.reason !== undefined
        ? { reason: parsed.values.reason }
        : {}),
    };
  }
  const parsed = parseRunOptions(rest, new Set(["after", "limit"]));
  if (!parsed.ok) return { kind: "error", message: parsed.message };
  const afterSequence = parseBoundedInteger(
    parsed.values.after,
    "--after",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (!afterSequence.ok) return { kind: "error", message: afterSequence.message };
  const limit = parseBoundedInteger(
    parsed.values.limit,
    "--limit",
    1,
    MAX_RUN_PAGE_LIMIT,
  );
  if (!limit.ok) return { kind: "error", message: limit.message };
  return {
    kind: action,
    runId,
    ...(afterSequence.value !== undefined
      ? { afterSequence: afterSequence.value }
      : {}),
    ...(limit.value !== undefined ? { limit: limit.value } : {}),
  };
}

const RUN_START_VALUE_OPTIONS = new Set([
  "goal",
  "goal-file",
  "cwd",
  "model",
  "reviewer-model",
  "max-cost",
  "permission-mode",
  "verify",
]);
const RUN_START_BOOLEAN_OPTIONS = new Set(["json", "follow"]);

function parseRunStartArgs(
  args: readonly string[],
): AgenCRunCliCommand {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { kind: "help", text: formatAgenCRunCliHelpText() };
  }
  const values: Record<string, string> = {};
  const verify: { label: string; script: string }[] = [];
  let json = false;
  let follow = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      return { kind: "error", message: `unexpected run start argument: ${token}` };
    }
    const equals = token.indexOf("=");
    const key = token.slice(2, equals < 0 ? undefined : equals);
    if (RUN_START_BOOLEAN_OPTIONS.has(key)) {
      if (equals >= 0) {
        return {
          kind: "error",
          message: `run start option --${key} does not take a value`,
        };
      }
      if (key === "json") json = true;
      else follow = true;
      continue;
    }
    if (!RUN_START_VALUE_OPTIONS.has(key)) {
      return { kind: "error", message: `unknown run start option: --${key}` };
    }
    const value = equals < 0 ? args[index + 1] : token.slice(equals + 1);
    if (value === undefined || value.trim().length === 0 || value.startsWith("--")) {
      return { kind: "error", message: `run start option --${key} requires a value` };
    }
    if (equals < 0) index += 1;
    if (key === "verify") {
      const separator = value.indexOf("=");
      const label = separator < 0 ? "" : value.slice(0, separator).trim();
      const script = separator < 0 ? "" : value.slice(separator + 1).trim();
      if (label.length === 0 || script.length === 0) {
        return {
          kind: "error",
          message: 'run start option --verify requires "label=script"',
        };
      }
      verify.push({ label, script });
      continue;
    }
    if (values[key] !== undefined) {
      return {
        kind: "error",
        message: `run start option --${key} was provided twice`,
      };
    }
    values[key] = value;
  }
  const goal = values.goal;
  const goalFile = values["goal-file"];
  if ((goal === undefined) === (goalFile === undefined)) {
    return {
      kind: "error",
      message: "run start requires exactly one of --goal or --goal-file",
    };
  }
  let maxCostUsd: number | undefined;
  if (values["max-cost"] !== undefined) {
    maxCostUsd = Number(values["max-cost"]);
    if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
      return {
        kind: "error",
        message: "--max-cost must be a positive number of USD",
      };
    }
  }
  const permissionMode = values["permission-mode"];
  if (
    permissionMode !== undefined &&
    !(RUN_START_PERMISSION_MODES as readonly string[]).includes(permissionMode)
  ) {
    return {
      kind: "error",
      message: `--permission-mode must be one of: ${RUN_START_PERMISSION_MODES.join(", ")}`,
    };
  }
  return {
    kind: "start",
    ...(goal !== undefined ? { goal } : {}),
    ...(goalFile !== undefined ? { goalFile } : {}),
    ...(values.cwd !== undefined ? { cwd: values.cwd } : {}),
    ...(values.model !== undefined ? { model: values.model } : {}),
    ...(values["reviewer-model"] !== undefined
      ? { reviewerModel: values["reviewer-model"] }
      : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(permissionMode !== undefined
      ? { permissionMode: permissionMode as RunStartPermissionMode }
      : {}),
    verify,
    ...(json ? { json: true as const } : {}),
    ...(follow ? { follow: true as const } : {}),
  };
}

export async function runAgenCRunCli(
  command: AgenCRunCliCommand,
  options: AgenCRunCliOptions = {},
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  if (command.kind === "help") {
    io.stdout.write(`${command.text}\n`);
    return 0;
  }
  if (command.kind === "error") {
    io.stderr.write(`agenc: ${command.message}\n`);
    io.stderr.write(`${formatAgenCRunCliHelpText()}\n`);
    return 1;
  }

  try {
    await (options.ensureDaemonReady ??
      defaultEnsureDaemonReady(options.env ?? process.env))();
    const client =
      options.client ?? createAgenCJsonLineDaemonRequestClient({ env: options.env });
    if (command.kind === "start") {
      return await runStartCommand(client, command, io, options);
    }
    const result = await requestForCommand(client, command);
    if (
      command.kind === "status" &&
      command.json !== true &&
      hasWorkflowStatus(result)
    ) {
      io.stdout.write(formatWorkflowStatusTable(result));
      return 0;
    }
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function runStartCommand(
  client: AgenCJsonLineDaemonRequestClient,
  command: AgenCRunStartCliCommand,
  io: AgenCRunCliIo,
  options: AgenCRunCliOptions,
): Promise<number> {
  let goal = command.goal;
  if (goal === undefined) {
    goal = (await readFile(command.goalFile!, "utf8")).trim();
    if (goal.length === 0) {
      io.stderr.write(`agenc: goal file is empty: ${command.goalFile}\n`);
      return 1;
    }
  }
  const params: RunStartParams = {
    goal,
    cwd: resolve(command.cwd ?? "."),
    ...(command.model !== undefined ? { model: command.model } : {}),
    ...(command.reviewerModel !== undefined
      ? { reviewerModel: command.reviewerModel }
      : {}),
    ...(command.maxCostUsd !== undefined
      ? { maxCostUsd: command.maxCostUsd }
      : {}),
    ...(command.permissionMode !== undefined
      ? { permissionMode: command.permissionMode }
      : {}),
    // Pass through exactly what the user gave: no invented defaults. The
    // daemon controller owns the at-least-one-command policy and its error.
    ...(command.verify.length > 0
      ? { requiredVerification: command.verify }
      : {}),
  };
  const result: RunStartResult = await client.request("run.start", params);
  if (command.json === true) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    io.stdout.write(
      [
        `run ${result.runId}`,
        `spec ${result.specDigest}`,
        `base ${result.baseCommit}` +
          (result.baseDirty.dirty
            ? ` (checkout dirty: ${result.baseDirty.fileCount} file(s); recorded, never touched)`
            : " (checkout clean)"),
        "",
      ].join("\n"),
    );
  }
  if (command.follow !== true) return 0;
  return followRun(client, result.runId, io, options);
}

/** Replay-cursor follow loop: page journal events until the run is terminal. */
async function followRun(
  client: AgenCJsonLineDaemonRequestClient,
  runId: string,
  io: AgenCRunCliIo,
  options: AgenCRunCliOptions,
): Promise<number> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let afterSequence = 0;
  for (;;) {
    const replay: RunReplayResult = await client.request("run.replay", {
      runId,
      afterSequence,
      limit: MAX_RUN_PAGE_LIMIT,
    });
    for (const event of replay.events) {
      io.stdout.write(
        `${event.sequence} ${event.category} ${event.event}` +
          (event.stepId !== undefined ? ` ${event.stepId}` : "") +
          "\n",
      );
    }
    afterSequence = replay.nextAfterSequence;
    if (replay.hasMore) continue;
    const status: RunStatusResult = await client.request("run.status", {
      runId,
    });
    if (status.terminal) {
      if (hasWorkflowStatus(status)) {
        io.stdout.write(formatWorkflowStatusTable(status));
      }
      io.stdout.write(`run ${runId} terminal: ${status.status}\n`);
      return status.status === "completed" ? 0 : 1;
    }
    await sleep(FOLLOW_POLL_INTERVAL_MS);
  }
}

function hasWorkflowStatus(
  result: unknown,
): result is RunStatusResult & { readonly workflow: RunWorkflowStatus } {
  return (
    typeof result === "object" &&
    result !== null &&
    typeof (result as { workflow?: unknown }).workflow === "object" &&
    (result as { workflow?: unknown }).workflow !== null
  );
}

export function formatWorkflowStatusTable(
  result: RunStatusResult & { readonly workflow: RunWorkflowStatus },
): string {
  const lines = [
    `run ${result.runId} — ${result.status}${result.terminal ? " (terminal)" : ""}`,
    "STAGE                 STATUS           ATTEMPTS  VERDICT",
  ];
  for (const step of result.workflow.steps) {
    lines.push(
      `${step.stage.padEnd(22)}${step.status.padEnd(17)}${String(step.attempts).padEnd(10)}${step.verdict ?? ""}`.trimEnd(),
    );
  }
  if (result.workflow.stopReason !== undefined) {
    lines.push(`stop reason: ${result.workflow.stopReason}`);
  }
  return `${lines.join("\n")}\n`;
}

async function requestForCommand(
  client: AgenCJsonLineDaemonRequestClient,
  command: Exclude<
    AgenCRunCliCommand,
    { readonly kind: "help" | "error" | "start" }
  >,
): Promise<AgenCDaemonResultByMethod[AgenCDaemonMethod]> {
  switch (command.kind) {
    case "status":
      return client.request("run.status", { runId: command.runId });
    case "result":
      return client.request("run.result", { runId: command.runId });
    case "replay":
      return client.request("run.replay", pageParams(command));
    case "evidence":
      return client.request("run.evidence", pageParams(command));
    case "cancel":
      return client.request("run.cancel", {
        runId: command.runId,
        ...(command.reason !== undefined ? { reason: command.reason } : {}),
      });
  }
}

function pageParams(command: {
  readonly runId: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}): JsonObject {
  return {
    runId: command.runId,
    ...(command.afterSequence !== undefined
      ? { afterSequence: command.afterSequence }
      : {}),
    ...(command.limit !== undefined ? { limit: command.limit } : {}),
  };
}

function isRunAction(
  value: string,
): value is "status" | "result" | "replay" | "evidence" | "cancel" {
  return ["status", "result", "replay", "evidence", "cancel"].includes(value);
}

function parseRunOptions(
  args: readonly string[],
  allowed: ReadonlySet<string>,
):
  | { readonly ok: true; readonly values: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly message: string } {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      return { ok: false, message: `unexpected run argument: ${token}` };
    }
    const equals = token.indexOf("=");
    const key = token.slice(2, equals < 0 ? undefined : equals);
    if (!allowed.has(key)) {
      return { ok: false, message: `unknown run option: --${key}` };
    }
    if (values[key] !== undefined) {
      return { ok: false, message: `run option --${key} was provided twice` };
    }
    const value = equals < 0 ? args[index + 1] : token.slice(equals + 1);
    if (value === undefined || value.trim().length === 0 || value.startsWith("--")) {
      return { ok: false, message: `run option --${key} requires a value` };
    }
    values[key] = value;
    if (equals < 0) index += 1;
  }
  return { ok: true, values };
}

function parseBoundedInteger(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
):
  | { readonly ok: true; readonly value?: number }
  | { readonly ok: false; readonly message: string } {
  if (raw === undefined) return { ok: true };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return {
      ok: false,
      message: `${name} must be an integer from ${min} through ${max}`,
    };
  }
  return { ok: true, value };
}
