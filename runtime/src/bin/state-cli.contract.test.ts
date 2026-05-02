import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatAgenCStateCliHelpText,
  parseAgenCStateCliArgs,
  runAgenCStateCli,
  type AgenCStateCliIo,
} from "./state-cli.js";
import { openStateDatabases, type StateSqliteDriver } from "../state/sqlite-driver.js";

function createIo(): AgenCStateCliIo & {
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

let home = "";
let cwd = "";
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-state-cli-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-state-cli-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("AgenC state CLI", () => {
  it("parses state export and import commands", () => {
    expect(parseAgenCStateCliArgs(["hello"])).toBeNull();
    expect(parseAgenCStateCliArgs(["state"])).toEqual({
      kind: "help",
      text: formatAgenCStateCliHelpText(),
    });
    expect(parseAgenCStateCliArgs(["state", "export", "agent-1"])).toEqual({
      kind: "export",
      agentId: "agent-1",
    });
    expect(parseAgenCStateCliArgs(["state", "export"])).toEqual({
      kind: "error",
      message: "state export requires an agent id",
    });
    expect(parseAgenCStateCliArgs(["state", "import"])).toEqual({
      kind: "import",
    });
    expect(parseAgenCStateCliArgs(["state", "import", "extra"])).toEqual({
      kind: "error",
      message: "state import reads from stdin and accepts no arguments",
    });
    expect(formatAgenCStateCliHelpText()).toContain("agenc state export");
    expect(formatAgenCStateCliHelpText()).toContain("agenc state import");
  });

  it("prints exported state JSON and imports it from stdin", async () => {
    seedAgentState(driver);
    const exportIo = createIo();

    await expect(
      runAgenCStateCli(
        { kind: "export", agentId: "agent-cli" },
        {
          driver,
          io: exportIo,
          now: () => "2026-05-02T00:00:00.000Z",
        },
      ),
    ).resolves.toBe(0);
    expect(exportIo.stderrText()).toBe("");
    const exported = JSON.parse(exportIo.stdoutText()) as {
      readonly format: string;
      readonly agentRun: { readonly id: string };
    };
    expect(exported).toMatchObject({
      format: "agenc.state.export",
      agentRun: { id: "agent-cli" },
    });

    driver
      .prepareState<[string]>("DELETE FROM agent_runs WHERE id = ?")
      .run("agent-cli");
    expect(agentExists(driver, "agent-cli")).toBe(false);

    const importIo = createIo();
    await expect(
      runAgenCStateCli(
        { kind: "import" },
        {
          driver,
          io: importIo,
          readInput: async () => exportIo.stdoutText(),
        },
      ),
    ).resolves.toBe(0);
    expect(importIo.stdoutText()).toBe(
      "Imported state for agent-cli: 1 snapshot(s), 1 tool call(s)\n",
    );
    expect(importIo.stderrText()).toBe("");
    expect(agentExists(driver, "agent-cli")).toBe(true);
  });

  it("reports import and export errors to stderr", async () => {
    const missingIo = createIo();
    await expect(
      runAgenCStateCli(
        { kind: "export", agentId: "missing" },
        { driver, io: missingIo },
      ),
    ).resolves.toBe(1);
    expect(missingIo.stderrText()).toContain(
      "agent state not found for agent id: missing",
    );

    const malformedIo = createIo();
    await expect(
      runAgenCStateCli(
        { kind: "import" },
        {
          driver,
          io: malformedIo,
          readInput: async () => "{",
        },
      ),
    ).resolves.toBe(1);
    expect(malformedIo.stderrText()).toContain(
      "state import payload is not valid JSON",
    );
  });
});

function seedAgentState(stateDriver: StateSqliteDriver): void {
  stateDriver
    .prepareState(
      `INSERT INTO agent_runs (
        id,
        objective,
        status,
        started_at,
        last_active_at,
        current_session_id
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-cli",
      "state cli",
      "running",
      "2026-05-01T00:00:00.000Z",
      "2026-05-01T00:01:00.000Z",
      "session-cli",
    );
  stateDriver
    .prepareState(
      `INSERT INTO session_state_snapshots (
        session_id,
        snapshot_at,
        conversation_json,
        tool_state_json,
        mcp_connection_state_json
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run("session-cli", "2026-05-01T00:01:00.000Z", "[]", "{}", "{}");
  stateDriver
    .prepareState(
      `INSERT INTO in_flight_tool_calls (
        session_id,
        tool_call_id,
        tool_name,
        args_json,
        status,
        started_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "session-cli",
      "tool-cli",
      "FileRead",
      "{}",
      "running",
      "2026-05-01T00:01:00.000Z",
    );
}

function agentExists(
  stateDriver: StateSqliteDriver,
  agentId: string,
): boolean {
  return (
    stateDriver
      .prepareState<[string], { count: number }>(
        "SELECT COUNT(*) AS count FROM agent_runs WHERE id = ?",
      )
      .get(agentId)?.count === 1
  );
}
