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
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../state/sqlite-driver.js";
import { StateRecoveryIncidentRepository } from "../state/recovery-incidents.js";

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
    expect(parseAgenCStateCliArgs(["state", "export", "--help"])).toEqual({
      kind: "help",
      text: formatAgenCStateCliHelpText(),
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
    expect(formatAgenCStateCliHelpText()).toContain("Examples:");
  });

  it("parses the bounded recovery inspection and confirmation grammar", () => {
    expect(
      parseAgenCStateCliArgs([
        "state",
        "recovery",
        "quarantine",
        "list",
        "--limit",
        "25",
        "--state",
        "all",
        "--json",
      ]),
    ).toEqual({
      kind: "recovery-list",
      collection: "quarantine",
      limit: 25,
      state: "all",
      json: true,
    });
    expect(
      parseAgenCStateCliArgs([
        "state",
        "recovery",
        "deferred",
        "show",
        "block-1",
        "--json",
      ]),
    ).toEqual({
      kind: "recovery-show",
      collection: "deferred",
      id: "block-1",
      json: true,
    });
    expect(
      parseAgenCStateCliArgs([
        "state",
        "recovery",
        "quarantine",
        "abandon",
        "incident-1",
        "--confirm-run-id",
        "run-1",
        "--confirm-source-sha256",
        "a".repeat(64),
        "--reason",
        "source cannot be recovered",
      ]),
    ).toMatchObject({
      kind: "recovery-mutation",
      action: "abandon",
      confirmedRunId: "run-1",
      confirmedSourceSha256: "a".repeat(64),
    });
    expect(
      parseAgenCStateCliArgs([
        "state",
        "recovery",
        "quarantine",
        "rescan",
        "incident-1",
        "--confirm-source-sha256",
        "b".repeat(64),
      ]),
    ).toMatchObject({
      kind: "recovery-mutation",
      action: "rescan",
      confirmedSourceSha256: "b".repeat(64),
    });
    expect(
      parseAgenCStateCliArgs([
        "state",
        "recovery",
        "quarantine",
        "rescan",
        "incident-1",
      ]),
    ).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--confirm-source-sha256"),
    });
    expect(
      parseAgenCStateCliArgs([
        "state",
        "recovery",
        "quarantine",
        "list",
        "--limit",
        "101",
      ]),
    ).toMatchObject({
      kind: "error",
      message: expect.stringContaining("between 1 and 100"),
    });
  });

  it("lists and shows safe recovery evidence offline", async () => {
    const repository = new StateRecoveryIncidentRepository(driver);
    const incident = repository.recordQuarantine({
      runId: "run-cli",
      sourceKind: "run_journal",
      sourcePath: "/journal/run-cli.jsonl",
      reasonCode: "malformed_json",
      safeDetail: { message: "invalid JSON", XAI_API_KEY: "never-print-this" },
      sourceSizeBytes: 100,
      sourceMtimeMs: 5,
      sourceSha256: "a".repeat(64),
      detectedAtMs: 10,
      facts: { lineNumber: 2, byteOffset: 50 },
    });
    const listIo = createIo();
    await expect(
      runAgenCStateCli(
        {
          kind: "recovery-list",
          collection: "quarantine",
          limit: 100,
          state: "active",
          json: true,
        },
        { driver, io: listIo },
      ),
    ).resolves.toBe(0);
    const listed = JSON.parse(listIo.stdoutText()) as {
      readonly items: readonly {
        readonly quarantineId: string;
        readonly safeDetail: string;
      }[];
    };
    expect(listed.items[0]?.quarantineId).toBe(incident.quarantineId);
    expect(listIo.stdoutText()).not.toContain("never-print-this");

    const showIo = createIo();
    await expect(
      runAgenCStateCli(
        {
          kind: "recovery-show",
          collection: "quarantine",
          id: incident.quarantineId,
          json: false,
        },
        { driver, io: showIo },
      ),
    ).resolves.toBe(0);
    expect(showIo.stdoutText()).toContain(incident.quarantineId);
    expect(showIo.stdoutText()).toContain("malformed_json");
  });

  it("keeps all recovery mutations fail-closed until the cutover adapter exists", async () => {
    const io = createIo();
    await expect(
      runAgenCStateCli(
        {
          kind: "recovery-mutation",
          collection: "quarantine",
          action: "rescan",
          id: "incident-1",
          confirmedSourceSha256: "a".repeat(64),
        },
        { driver, io },
      ),
    ).resolves.toBe(1);
    expect(io.stdoutText()).toBe("");
    expect(io.stderrText()).toContain("executable-selector cutover");
    expect(io.stderrText()).toContain("evidence remains active");
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

function agentExists(stateDriver: StateSqliteDriver, agentId: string): boolean {
  return (
    stateDriver
      .prepareState<[string], { count: number }>(
        "SELECT COUNT(*) AS count FROM agent_runs WHERE id = ?",
      )
      .get(agentId)?.count === 1
  );
}
