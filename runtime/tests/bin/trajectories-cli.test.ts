import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { TRAJECTORY_EXPORT_SCHEMA_VERSION } from "../../src/session/trajectory-export.js";
import {
  formatAgenCTrajectoriesCliHelpText,
  parseAgenCTrajectoriesCliArgs,
  runAgenCTrajectoriesCli,
  type AgenCTrajectoriesCliIo,
} from "./trajectories-cli.js";

// ─────────────────────────────────────────────────────────────────────
// Fixtures — the exact JSONL shape the export sink writes
// ─────────────────────────────────────────────────────────────────────

function exportLine(sessionId: string, item: unknown): string {
  return JSON.stringify({
    schemaVersion: TRAJECTORY_EXPORT_SCHEMA_VERSION,
    exportedAtUnixMs: 1_720_000_000_000,
    sessionId,
    rolloutPath: `/tmp/sessions/${sessionId}/rollout.jsonl`,
    item,
  });
}

function response(role: string, content: string, extra: object = {}): unknown {
  return { type: "response_item", payload: { role, content, ...extra } };
}

function event(msg: unknown): unknown {
  return { type: "event_msg", payload: { id: "evt", msg } };
}

function cleanSessionLines(sessionId: string): string[] {
  return [
    exportLine(sessionId, event({ type: "turn_started", payload: { turnId: "t1" } })),
    exportLine(sessionId, response("user", "Fix the bug")),
    exportLine(
      sessionId,
      response("assistant", "Patched the api_key='sk-cli-plant-123456' handling."),
    ),
    exportLine(sessionId, event({ type: "turn_complete", payload: { turnId: "t1" } })),
  ];
}

function abortedSessionLines(sessionId: string): string[] {
  return [
    exportLine(sessionId, event({ type: "turn_started", payload: { turnId: "t1" } })),
    exportLine(sessionId, response("user", "Do something")),
    exportLine(
      sessionId,
      event({ type: "turn_aborted", payload: { turnId: "t1", reason: "interrupted" } }),
    ),
    exportLine(sessionId, event({ type: "turn_started", payload: { turnId: "t2" } })),
    exportLine(sessionId, response("user", "ok try again")),
    exportLine(sessionId, response("assistant", "done")),
    exportLine(sessionId, event({ type: "turn_complete", payload: { turnId: "t2" } })),
  ];
}

interface CapturedIo extends AgenCTrajectoriesCliIo {
  readonly out: () => string;
  readonly err: () => string;
}

function captureIo(): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout.push(String(chunk));
        return true;
      },
    },
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      },
    },
    out: () => stdout.join(""),
    err: () => stderr.join(""),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Arg parsing
// ─────────────────────────────────────────────────────────────────────

describe("parseAgenCTrajectoriesCliArgs", () => {
  test("returns null for non-trajectories argv", () => {
    expect(parseAgenCTrajectoriesCliArgs(["doctor"])).toBeNull();
    expect(parseAgenCTrajectoriesCliArgs([])).toBeNull();
  });

  test("bare and --help forms show help", () => {
    expect(parseAgenCTrajectoriesCliArgs(["trajectories"])).toEqual({
      kind: "help",
      text: formatAgenCTrajectoriesCliHelpText(),
    });
    expect(
      parseAgenCTrajectoriesCliArgs(["trajectories", "export", "--help"]),
    ).toMatchObject({ kind: "help" });
  });

  test("export defaults to sft format", () => {
    expect(parseAgenCTrajectoriesCliArgs(["trajectories", "export"])).toEqual({
      kind: "export",
      format: "sft",
    });
  });

  test("export accepts --format, --dir, and --out in both flag forms", () => {
    expect(
      parseAgenCTrajectoriesCliArgs([
        "trajectories",
        "export",
        "--format=dpo",
        "--dir",
        "/exports",
        "--out=pairs.jsonl",
      ]),
    ).toEqual({
      kind: "export",
      format: "dpo",
      dir: "/exports",
      out: "pairs.jsonl",
    });
  });

  test("rejects unknown subcommands, formats, and stray arguments", () => {
    expect(
      parseAgenCTrajectoriesCliArgs(["trajectories", "import"]),
    ).toMatchObject({ kind: "error" });
    expect(
      parseAgenCTrajectoriesCliArgs(["trajectories", "export", "--format", "csv"]),
    ).toMatchObject({ kind: "error" });
    expect(
      parseAgenCTrajectoriesCliArgs(["trajectories", "export", "extra"]),
    ).toMatchObject({ kind: "error" });
    expect(
      parseAgenCTrajectoriesCliArgs(["trajectories", "export", "--dir"]),
    ).toMatchObject({ kind: "error" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Export runs against a real temp export dir
// ─────────────────────────────────────────────────────────────────────

describe("runAgenCTrajectoriesCli export", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agenc-traj-cli-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("sft: keeps the clean session, drops the aborted one, redacts output", async () => {
    writeFileSync(
      join(dir, "sess-clean.jsonl"),
      `${cleanSessionLines("sess-clean").join("\n")}\n`,
    );
    writeFileSync(
      join(dir, "sess-aborted.jsonl"),
      `${abortedSessionLines("sess-aborted").join("\n")}\n`,
    );

    const io = captureIo();
    const code = await runAgenCTrajectoriesCli(
      { kind: "export", format: "sft", dir },
      { env: {}, io },
    );

    expect(code).toBe(0);
    const rows = io
      .out()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].meta.sessionId).toBe("sess-clean");
    expect(rows[0].messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    // The planted secret must not survive emission.
    expect(io.out()).not.toContain("sk-cli-plant-123456");
    expect(io.out()).toContain("[REDACTED_SECRET]");
    expect(io.err()).toContain("kept 1");
    expect(io.err()).toContain("1 aborted/interrupted");
  });

  test("sft: resolves the source dir from AGENC_TRAJECTORY_EXPORT_DIR", async () => {
    writeFileSync(
      join(dir, "sess-clean.jsonl"),
      `${cleanSessionLines("sess-clean").join("\n")}\n`,
    );
    const io = captureIo();
    const code = await runAgenCTrajectoriesCli(
      { kind: "export", format: "sft" },
      { env: { AGENC_TRAJECTORY_EXPORT_DIR: dir }, io },
    );
    expect(code).toBe(0);
    expect(io.out().trim().split("\n")).toHaveLength(1);
  });

  test("sft: --out writes the JSONL file instead of stdout", async () => {
    writeFileSync(
      join(dir, "sess-clean.jsonl"),
      `${cleanSessionLines("sess-clean").join("\n")}\n`,
    );
    const outPath = join(dir, "out", "..", "sft.jsonl");
    mkdirSync(join(dir, "out"), { recursive: true });

    const io = captureIo();
    const code = await runAgenCTrajectoriesCli(
      { kind: "export", format: "sft", dir, out: outPath },
      { env: {}, io },
    );

    expect(code).toBe(0);
    expect(io.out()).toBe("");
    const written = readFileSync(join(dir, "sft.jsonl"), "utf8");
    expect(JSON.parse(written.trim()).meta.sessionId).toBe("sess-clean");
  });

  test("dpo: derives a pair from a rollback regeneration", async () => {
    const sessionId = "sess-regen";
    const lines = [
      exportLine(sessionId, event({ type: "turn_started", payload: { turnId: "t1" } })),
      exportLine(sessionId, response("user", "Write the parser")),
      exportLine(sessionId, response("assistant", "A regex-based parser.")),
      exportLine(sessionId, event({ type: "turn_complete", payload: { turnId: "t1" } })),
      exportLine(sessionId, event({ type: "thread_rolled_back", payload: { numTurns: 1 } })),
      exportLine(sessionId, event({ type: "turn_started", payload: { turnId: "t2" } })),
      exportLine(sessionId, response("user", "Write the parser")),
      exportLine(sessionId, response("assistant", "A recursive-descent parser.")),
      exportLine(sessionId, event({ type: "turn_complete", payload: { turnId: "t2" } })),
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);

    const io = captureIo();
    const code = await runAgenCTrajectoriesCli(
      { kind: "export", format: "dpo", dir },
      { env: {}, io },
    );

    expect(code).toBe(0);
    const rows = io
      .out()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt.at(-1).content).toBe("Write the parser");
    expect(rows[0].chosen[0].content).toBe("A recursive-descent parser.");
    expect(rows[0].rejected[0].content).toBe("A regex-based parser.");
  });

  test("dpo: errors explicitly when no honest pairs exist", async () => {
    writeFileSync(
      join(dir, "sess-clean.jsonl"),
      `${cleanSessionLines("sess-clean").join("\n")}\n`,
    );
    const io = captureIo();
    const code = await runAgenCTrajectoriesCli(
      { kind: "export", format: "dpo", dir },
      { env: {}, io },
    );
    expect(code).toBe(1);
    expect(io.out()).toBe("");
    expect(io.err()).toContain("thread_rolled_back");
    expect(io.err()).toContain("Nothing was fabricated");
  });

  test("errors when no source dir is configured or present", async () => {
    const io = captureIo();
    expect(
      await runAgenCTrajectoriesCli(
        { kind: "export", format: "sft" },
        { env: {}, io },
      ),
    ).toBe(1);
    expect(io.err()).toContain("AGENC_TRAJECTORY_EXPORT_DIR");

    const io2 = captureIo();
    expect(
      await runAgenCTrajectoriesCli(
        { kind: "export", format: "sft", dir: join(dir, "missing") },
        { env: {}, io: io2 },
      ),
    ).toBe(1);
    expect(io2.err()).toContain("not found");
  });
});
