/** Read and control durable M3 run state through the daemon protocol. */

import type {
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
} from "../app-server/protocol/index.js";
import {
  createAgenCJsonLineDaemonRequestClient,
  defaultEnsureDaemonReady,
  type AgenCJsonLineDaemonRequestClient,
} from "../app-server/agent-cli.js";

const MAX_RUN_PAGE_LIMIT = 200;

export type AgenCRunCliCommand =
  | { readonly kind: "status"; readonly runId: string }
  | { readonly kind: "result"; readonly runId: string }
  | {
      readonly kind: "replay" | "evidence";
      readonly runId: string;
      readonly afterSequence?: number;
      readonly limit?: number;
    }
  | { readonly kind: "cancel"; readonly runId: string; readonly reason?: string }
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
}

export function formatAgenCRunCliHelpText(): string {
  return [
    "Usage: agenc run <command> <run-id> [options]",
    "",
    "Commands:",
    "  status <run-id>                 Show durable run and admission state",
    "  result <run-id>                 Fetch a terminal result",
    "  replay <run-id>                 Page the admission journal",
    "  evidence <run-id>               Export hashed admission evidence",
    "  cancel <run-id>                 Cancel the run and its descendants",
    "",
    "Replay/evidence options:",
    "  --after <sequence>              Exclusive journal cursor (default: 0)",
    `  --limit <count>                 Page size, 1-${MAX_RUN_PAGE_LIMIT}`,
    "",
    "Cancel options:",
    "  --reason <text>                 Journaled cancellation reason",
    "",
    "All successful commands print canonical JSON.",
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
  if (action === "status" || action === "result") {
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
    const result = await requestForCommand(client, command);
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function requestForCommand(
  client: AgenCJsonLineDaemonRequestClient,
  command: Exclude<AgenCRunCliCommand, { readonly kind: "help" | "error" }>,
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
