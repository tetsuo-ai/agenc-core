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
  resolveUnknownOutcomeEffect,
} from "../state/unknown-outcome-gate.js";

export type AgenCStateCliCommand =
  | { readonly kind: "export"; readonly agentId: string }
  | { readonly kind: "import" }
  | {
      readonly kind: "resolve-tool-call";
      readonly sessionId: string;
      readonly toolCallId: string;
    }
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
}

export function formatAgenCStateCliHelpText(): string {
  return [
    "Usage: agenc state export <agent-id>",
    "       agenc state import",
    "       agenc state resolve-tool-call <session-id> <tool-call-id>",
    "",
    "Commands:",
    "  export <agent-id>    Print a JSON state export for one agent",
    "  import               Read a JSON state export from stdin and import it",
    "  resolve-tool-call <session-id> <tool-call-id>",
    "                       Review-resolve one unknown-outcome (poisoned) tool",
    "                       call so the session's side-effecting mutation gate",
    "                       lifts. Resolution asserts a human verified whether",
    "                       the effect happened; it never re-runs the tool.",
    "",
    "Examples:",
    "  agenc state export agent_123 > state.json",
    "  agenc state import < state.json",
    "  agenc state resolve-tool-call session_abc call_42",
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
    if (
      sessionId === undefined ||
      sessionId.length === 0 ||
      toolCallId === undefined ||
      toolCallId.length === 0
    ) {
      return {
        kind: "error",
        message:
          "state resolve-tool-call requires <session-id> and <tool-call-id>",
      };
    }
    if (argv.length > 4) {
      return {
        kind: "error",
        message:
          "state resolve-tool-call accepts exactly <session-id> <tool-call-id>",
      };
    }
    return { kind: "resolve-tool-call", sessionId, toolCallId };
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
  }
}

function runStateResolveToolCall(
  command: { readonly sessionId: string; readonly toolCallId: string },
  io: AgenCStateCliIo,
  options: AgenCStateCliOptions,
): number {
  try {
    return withStateDriver(options, (driver) => {
      const resolved = resolveUnknownOutcomeEffect(driver, {
        sessionId: command.sessionId,
        toolCallId: command.toolCallId,
      });
      if (!resolved) {
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
        `Resolved unknown-outcome tool call ${command.toolCallId} in session ${command.sessionId}; the side-effecting mutation gate lifts once no unresolved effects remain.\n`,
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
