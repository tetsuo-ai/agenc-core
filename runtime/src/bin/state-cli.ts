/**
 * Debug and migration CLI for project-scoped AgenC state.
 *
 * `agenc state export <agent-id>` prints a portable JSON payload for one
 * daemon agent run and its current session rows. `agenc state import` reads
 * that payload from stdin and upserts it into the current project database.
 */

import { cwd as processCwd } from "node:process";
import {
  exportAgentState,
  importAgentState,
  parseAgenCStateExportPayload,
} from "../state/export-import.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../state/sqlite-driver.js";
import {
  listUnresolvedUnknownOutcomeEffects,
} from "../state/unknown-outcome-gate.js";
import {
  createOperatorEffectReviewResolution,
  resolveDurableEffectReview,
} from "../state/effect-review.js";
import type { EffectReviewDisposition } from "../contracts/run-contracts.js";
import {
  StateRecoveryIncidentRepository,
  type RecoveryDeferredBlock,
  type RecoveryQuarantineIncident,
} from "../state/recovery-incidents.js";
import {
  MAX_RECOVERY_HISTORY_PAGE_SIZE,
  assertRecoverySha256,
} from "../state/recovery-contract.js";

export type RecoveryCollection = "quarantine" | "deferred";

interface RecoveryListCommand {
  readonly kind: "recovery-list";
  readonly collection: RecoveryCollection;
  readonly limit: number;
  readonly cursor?: string;
  readonly state: "active" | "repaired" | "resolved" | "abandoned" | "all";
  readonly json: boolean;
}

interface RecoveryShowCommand {
  readonly kind: "recovery-show";
  readonly collection: RecoveryCollection;
  readonly id: string;
  readonly json: boolean;
}

export interface RecoveryMutationCommand {
  readonly kind: "recovery-mutation";
  readonly collection: RecoveryCollection;
  readonly action: "rescan" | "retry" | "abandon";
  readonly id: string;
  readonly confirmedRunId?: string;
  readonly confirmedSourceSha256?: string;
  readonly reason?: string;
  readonly actor?: string;
}

export type AgenCStateCliCommand =
  | { readonly kind: "export"; readonly agentId: string }
  | { readonly kind: "import" }
  | {
      readonly kind: "resolve-tool-call";
      readonly sessionId: string;
      readonly toolCallId: string;
      readonly disposition: EffectReviewDisposition;
      readonly evidenceRef: string;
      readonly evidenceSha256: string;
    }
  | RecoveryListCommand
  | RecoveryShowCommand
  | RecoveryMutationCommand
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface AgenCStateCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface AgenCStateCliOptions {
  readonly agencHome?: string;
  readonly cwd?: string;
  readonly driver?: StateSqliteDriver;
  readonly env?: NodeJS.ProcessEnv;
  readonly io?: AgenCStateCliIo;
  readonly now?: () => string;
  readonly readInput?: () => Promise<string>;
  /** Installed by E1a/A2b only after strict replay and selector cutover land. */
  readonly recoveryMutations?: AgenCRecoveryMutationAdapter;
}

export interface AgenCRecoveryMutationAdapter {
  rescan(
    driver: StateSqliteDriver,
    command: RecoveryMutationCommand,
    context: RecoveryMutationContext,
  ): void;
  retry(
    driver: StateSqliteDriver,
    command: RecoveryMutationCommand,
    context: RecoveryMutationContext,
  ): void;
  abandon(
    driver: StateSqliteDriver,
    command: RecoveryMutationCommand,
    context: RecoveryMutationContext,
  ): void;
}

export interface RecoveryMutationContext {
  readonly actor: string;
  readonly operatedAt: string;
}

export function formatAgenCStateCliHelpText(): string {
  return [
    "Usage: agenc state export <agent-id>",
    "       agenc state import",
    "       agenc state resolve-tool-call <session-id> <tool-call-id> <disposition> <evidence-ref> <evidence-sha256>",
    "       agenc state recovery quarantine list [--limit N] [--cursor C] [--state S] [--json]",
    "       agenc state recovery quarantine show <quarantine-id> [--json]",
    "       agenc state recovery quarantine rescan <quarantine-id> --confirm-source-sha256 SHA256",
    "       agenc state recovery quarantine abandon <quarantine-id> --confirm-run-id RUN --confirm-source-sha256 SHA256 --reason TEXT",
    "       agenc state recovery deferred list [--limit N] [--cursor C] [--state S] [--json]",
    "       agenc state recovery deferred show <block-id> [--json]",
    "       agenc state recovery deferred retry <block-id>",
    "       agenc state recovery deferred abandon <block-id> --confirm-run-id RUN --confirm-source-sha256 SHA256 --reason TEXT",
    "",
    "Commands:",
    "  export <agent-id>    Print a JSON state export for one agent",
    "  import               Read a JSON state export from stdin and import it",
    "  resolve-tool-call <session-id> <tool-call-id> <disposition> <evidence-ref> <evidence-sha256>",
    "                       Record a typed, evidence-bound review disposition.",
    "                       Dispositions: confirmed_committed, confirmed_no_effect, remains_unknown.",
    "  recovery ...         Inspect bounded quarantine/deferred evidence offline.",
    "                       Mutations fail closed until authoritative strict",
    "                       replay and executable-selector cutover are installed.",
    "",
    "Examples:",
    "  agenc state export agent_123 > state.json",
    "  agenc state import < state.json",
    "  agenc state resolve-tool-call session_abc call_42 confirmed_no_effect receipt:42 <sha256>",
    "  agenc state recovery quarantine list --state active --json",
    "  agenc state recovery deferred show 01234567-89ab-cdef-0123-456789abcdef",
  ].join("\n");
}

export function parseAgenCStateCliArgs(
  argv: readonly string[],
): AgenCStateCliCommand | null {
  if (argv[0] !== "state") return null;
  const action = argv[1];
  if (action === undefined || action === "--help" || action === "-h") {
    return { kind: "help", text: formatAgenCStateCliHelpText() };
  }
  const rest = argv.slice(2);
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    return { kind: "help", text: formatAgenCStateCliHelpText() };
  }
  if (action === "export") {
    const agentId = argv[2]?.trim();
    if (agentId === undefined || agentId.length === 0) {
      return { kind: "error", message: "state export requires an agent id" };
    }
    if (argv.length > 3) {
      return {
        kind: "error",
        message: "state export accepts exactly one agent id",
      };
    }
    return { kind: "export", agentId };
  }
  if (action === "import") {
    if (argv.length > 2) {
      return {
        kind: "error",
        message: "state import reads from stdin and accepts no arguments",
      };
    }
    return { kind: "import" };
  }
  if (action === "resolve-tool-call") {
    const sessionId = argv[2]?.trim();
    const toolCallId = argv[3]?.trim();
    const disposition = argv[4]?.trim();
    const evidenceRef = argv[5]?.trim();
    const evidenceSha256 = argv[6]?.trim();
    if (
      sessionId === undefined ||
      sessionId.length === 0 ||
      toolCallId === undefined ||
      toolCallId.length === 0 ||
      disposition === undefined ||
      evidenceRef === undefined ||
      evidenceRef.length === 0 ||
      evidenceSha256 === undefined
    ) {
      return {
        kind: "error",
        message:
          "state resolve-tool-call requires <session-id> <tool-call-id> <disposition> <evidence-ref> <evidence-sha256>",
      };
    }
    if (
      disposition !== "confirmed_committed" &&
      disposition !== "confirmed_no_effect" &&
      disposition !== "remains_unknown"
    ) {
      return {
        kind: "error",
        message: "state resolve-tool-call disposition must be confirmed_committed, confirmed_no_effect, or remains_unknown",
      };
    }
    if (!/^[0-9a-f]{64}$/u.test(evidenceSha256)) {
      return {
        kind: "error",
        message: "state resolve-tool-call evidence-sha256 must be 64 lowercase hexadecimal characters",
      };
    }
    if (argv.length > 7) {
      return {
        kind: "error",
        message:
          "state resolve-tool-call accepts exactly five arguments after the action",
      };
    }
    return {
      kind: "resolve-tool-call",
      sessionId,
      toolCallId,
      disposition,
      evidenceRef,
      evidenceSha256,
    };
  }
  if (action === "recovery") {
    return parseRecoveryCommand(argv.slice(2));
  }
  return {
    kind: "error",
    message: `unknown state command: ${action}`,
  };
}

export async function runAgenCStateCli(
  command: AgenCStateCliCommand,
  options: AgenCStateCliOptions = {},
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  switch (command.kind) {
    case "help":
      io.stdout.write(`${command.text}\n`);
      return 0;
    case "error":
      io.stderr.write(`agenc: ${command.message}\n`);
      io.stderr.write(`${formatAgenCStateCliHelpText()}\n`);
      return 1;
    case "export":
      return runStateExport(command.agentId, io, options);
    case "import":
      return runStateImport(io, options);
    case "resolve-tool-call":
      return runStateResolveToolCall(command, io, options);
    case "recovery-list":
      return runRecoveryList(command, io, options);
    case "recovery-show":
      return runRecoveryShow(command, io, options);
    case "recovery-mutation":
      return runRecoveryMutation(command, io, options);
  }
}

function parseRecoveryCommand(
  argv: readonly string[],
): AgenCStateCliCommand {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { kind: "help", text: formatAgenCStateCliHelpText() };
  }
  const collection = argv[0];
  if (collection !== "quarantine" && collection !== "deferred") {
    return {
      kind: "error",
      message: "state recovery requires quarantine or deferred",
    };
  }
  const action = argv[1];
  if (action === undefined || action === "--help" || action === "-h") {
    return { kind: "help", text: formatAgenCStateCliHelpText() };
  }
  if (action === "list") return parseRecoveryList(collection, argv.slice(2));
  if (action === "show") {
    const id = argv[2]?.trim();
    const tail = argv.slice(3);
    if (id === undefined || id.length === 0) {
      return { kind: "error", message: `state recovery ${collection} show requires an id` };
    }
    if (tail.some((token) => token !== "--json")) {
      return { kind: "error", message: `state recovery ${collection} show accepts only --json after its id` };
    }
    return { kind: "recovery-show", collection, id, json: tail.includes("--json") };
  }
  if (action === "rescan" && collection !== "quarantine") {
    return { kind: "error", message: "rescan applies only to recovery quarantine" };
  }
  if (action === "retry" && collection !== "deferred") {
    return { kind: "error", message: "retry applies only to recovery deferred blocks" };
  }
  if (action === "rescan" || action === "retry" || action === "abandon") {
    return parseRecoveryMutation(collection, action, argv.slice(2));
  }
  return {
    kind: "error",
    message: `unknown state recovery ${collection} command: ${action}`,
  };
}

function parseRecoveryList(
  collection: RecoveryCollection,
  argv: readonly string[],
): AgenCStateCliCommand {
  let limit = MAX_RECOVERY_HISTORY_PAGE_SIZE;
  let cursor: string | undefined;
  let state: RecoveryListCommand["state"] = "active";
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--json") {
      json = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) {
      return { kind: "error", message: `${option} requires a value` };
    }
    if (option === "--limit") {
      limit = Number(value);
    } else if (option === "--cursor") {
      cursor = value;
    } else if (option === "--state") {
      if (!isRecoveryListState(value)) {
        return { kind: "error", message: `invalid recovery state: ${value}` };
      }
      state = value;
    } else {
      return { kind: "error", message: `unknown recovery list option: ${option}` };
    }
    index += 1;
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_RECOVERY_HISTORY_PAGE_SIZE) {
    return {
      kind: "error",
      message: `recovery list limit must be between 1 and ${MAX_RECOVERY_HISTORY_PAGE_SIZE}`,
    };
  }
  if (
    (collection === "quarantine" && state === "resolved") ||
    (collection === "deferred" && state === "repaired")
  ) {
    return { kind: "error", message: `state ${state} is not valid for ${collection}` };
  }
  return {
    kind: "recovery-list",
    collection,
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
    state,
    json,
  };
}

function parseRecoveryMutation(
  collection: RecoveryCollection,
  action: RecoveryMutationCommand["action"],
  argv: readonly string[],
): AgenCStateCliCommand {
  const id = argv[0]?.trim();
  if (id === undefined || id.length === 0) {
    return { kind: "error", message: `state recovery ${collection} ${action} requires an id` };
  }
  const options = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === undefined || value === undefined || !option.startsWith("--")) {
      return { kind: "error", message: `state recovery ${action} options require name/value pairs` };
    }
    if (options.has(option)) {
      return { kind: "error", message: `duplicate recovery option: ${option}` };
    }
    options.set(option, value);
  }
  const allowed = new Set(
    action === "abandon"
      ? ["--confirm-run-id", "--confirm-source-sha256", "--reason", "--actor"]
      : action === "rescan"
        ? ["--confirm-source-sha256", "--actor"]
        : ["--actor"],
  );
  const unknown = [...options.keys()].find((option) => !allowed.has(option));
  if (unknown !== undefined) {
    return { kind: "error", message: `unknown recovery ${action} option: ${unknown}` };
  }
  if (action === "rescan" && options.get("--confirm-source-sha256") === undefined) {
    return { kind: "error", message: "recovery rescan requires --confirm-source-sha256" };
  }
  if (
    action === "abandon" &&
    (options.get("--confirm-run-id") === undefined ||
      options.get("--confirm-source-sha256") === undefined ||
      options.get("--reason") === undefined)
  ) {
    return {
      kind: "error",
      message: "recovery abandon requires --confirm-run-id, --confirm-source-sha256, and --reason",
    };
  }
  const digest = options.get("--confirm-source-sha256");
  if (digest !== undefined) {
    try {
      assertRecoverySha256(digest, "confirmed source digest");
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }
  return {
    kind: "recovery-mutation",
    collection,
    action,
    id,
    ...(options.get("--confirm-run-id") !== undefined
      ? { confirmedRunId: options.get("--confirm-run-id")! }
      : {}),
    ...(digest !== undefined ? { confirmedSourceSha256: digest } : {}),
    ...(options.get("--reason") !== undefined ? { reason: options.get("--reason")! } : {}),
    ...(options.get("--actor") !== undefined ? { actor: options.get("--actor")! } : {}),
  };
}

function isRecoveryListState(value: string): value is RecoveryListCommand["state"] {
  return value === "active" || value === "repaired" || value === "resolved" || value === "abandoned" || value === "all";
}

function runRecoveryList(
  command: RecoveryListCommand,
  io: AgenCStateCliIo,
  options: AgenCStateCliOptions,
): number {
  try {
    return withStateDriver(options, (driver) => {
      const repository = new StateRecoveryIncidentRepository(driver);
      const page =
        command.collection === "quarantine"
          ? repository.listQuarantines({
              state: command.state as "active" | "repaired" | "abandoned" | "all",
              limit: command.limit,
              ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
            })
          : repository.listDeferred({
              state: command.state as "active" | "resolved" | "abandoned" | "all",
              limit: command.limit,
              ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
            });
      if (command.json) {
        io.stdout.write(`${JSON.stringify({ collection: command.collection, ...page }, null, 2)}\n`);
      } else {
        for (const item of page.items) io.stdout.write(`${formatRecoveryItem(item)}\n`);
        if (page.nextCursor !== undefined) io.stdout.write(`next-cursor\t${page.nextCursor}\n`);
      }
      return 0;
    });
  } catch (error) {
    io.stderr.write(`agenc: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function runRecoveryShow(
  command: RecoveryShowCommand,
  io: AgenCStateCliIo,
  options: AgenCStateCliOptions,
): number {
  try {
    return withStateDriver(options, (driver) => {
      const repository = new StateRecoveryIncidentRepository(driver);
      const item = command.collection === "quarantine"
        ? repository.getQuarantine(command.id)
        : repository.getDeferred(command.id);
      if (item === undefined) {
        io.stderr.write(`agenc: recovery ${command.collection} evidence not found: ${command.id}\n`);
        return 1;
      }
      io.stdout.write(command.json ? `${JSON.stringify(item, null, 2)}\n` : `${formatRecoveryItem(item)}\n`);
      return 0;
    });
  } catch (error) {
    io.stderr.write(`agenc: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function runRecoveryMutation(
  command: RecoveryMutationCommand,
  io: AgenCStateCliIo,
  options: AgenCStateCliOptions,
): number {
  const adapter = options.recoveryMutations;
  if (adapter === undefined) {
    io.stderr.write(
      "agenc: recovery mutation is unavailable until descriptor-pinned strict replay and executable-selector cutover are installed; evidence remains active\n",
    );
    return 1;
  }
  try {
    return withStateDriver(options, (driver) => {
      const context = {
        actor: command.actor?.trim() || recoveryActor(options.env),
        operatedAt: options.now?.() ?? new Date().toISOString(),
      };
      adapter[command.action](driver, command, context);
      io.stdout.write(`Recovery ${command.collection} ${command.action} completed for ${command.id}.\n`);
      return 0;
    });
  } catch (error) {
    io.stderr.write(`agenc: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function formatRecoveryItem(
  item: RecoveryQuarantineIncident | RecoveryDeferredBlock,
): string {
  return "quarantineId" in item
    ? [item.quarantineId, item.state, item.runId, item.reasonCode, item.sourceSha256, item.sourcePath].join("\t")
    : [item.blockId, item.state, item.runId, item.reasonCode, item.nextRetryMs, item.sourcePath].join("\t");
}

function recoveryActor(env: NodeJS.ProcessEnv | undefined): string {
  return env?.AGENC_REVIEWER_ID?.trim() || env?.USER?.trim() || env?.USERNAME?.trim() || "local_operator";
}

function runStateResolveToolCall(
  command: Extract<AgenCStateCliCommand, { readonly kind: "resolve-tool-call" }>,
  io: AgenCStateCliIo,
  options: AgenCStateCliOptions,
): number {
  try {
    return withStateDriver(options, (driver) => {
      const resolved = resolveDurableEffectReview(driver, {
        sessionId: command.sessionId,
        toolCallId: command.toolCallId,
        resolution: createOperatorEffectReviewResolution({
          disposition: command.disposition,
          evidenceRef: command.evidenceRef,
          evidenceSha256: command.evidenceSha256,
          reviewedAt: options.now?.() ?? new Date().toISOString(),
          actorId:
            options.env?.AGENC_REVIEWER_ID?.trim() ||
            options.env?.USER?.trim() ||
            options.env?.USERNAME?.trim() ||
            "local_operator",
        }),
      });
      if (resolved.kind === "not_found") {
        const unresolved = listUnresolvedUnknownOutcomeEffects(
          driver,
          command.sessionId,
        );
        io.stderr.write(
          `agenc: no unresolved unknown-outcome tool call ${command.toolCallId} in session ${command.sessionId}` +
            (unresolved.length > 0
              ? `; unresolved: ${unresolved
                  .map((effect) => `${effect.toolCallId} (${effect.toolName})`)
                  .join(", ")}\n`
              : ` (state databases are project-scoped — run this from the session's project directory)\n`),
        );
        return 1;
      }
      io.stdout.write(
        `Resolved unknown-outcome tool call ${command.toolCallId} in session ${command.sessionId}` +
          (resolved.durable
            ? ` with canonical review event ${resolved.eventId} at sequence ${resolved.sequence}`
            : "") +
          `; the non-idempotent mutation gate lifts once no unresolved effects remain.\n`,
      );
      return 0;
    });
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function runStateExport(
  agentId: string,
  io: AgenCStateCliIo,
  options: AgenCStateCliOptions,
): Promise<number> {
  try {
    return await withStateDriver(options, (driver) => {
      const payload = exportAgentState(driver, agentId, {
        now: options.now,
      });
      io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return 0;
    });
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function runStateImport(
  io: AgenCStateCliIo,
  options: AgenCStateCliOptions,
): Promise<number> {
  try {
    const input = (await (options.readInput ?? readStdin)()).trim();
    if (input.length === 0) {
      throw new Error("state import requires a JSON payload on stdin");
    }
    const payload = parseAgenCStateExportPayload(input);
    return await withStateDriver(options, (driver) => {
      const result = importAgentState(driver, payload, {
        agencHome: options.agencHome ?? options.env?.AGENC_HOME,
      });
      io.stdout.write(
        `Imported state for ${result.agentId}: ${result.snapshotCount} snapshot(s), ${result.toolCallCount} tool call(s)\n`,
      );
      return 0;
    });
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

function withStateDriver<T>(
  options: AgenCStateCliOptions,
  fn: (driver: StateSqliteDriver) => T,
): T {
  if (options.driver !== undefined) return fn(options.driver);
  const driver = openStateDatabases({
    cwd: options.cwd ?? processCwd(),
    agencHome: options.agencHome ?? options.env?.AGENC_HOME,
  });
  try {
    return fn(driver);
  } finally {
    driver.close();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
