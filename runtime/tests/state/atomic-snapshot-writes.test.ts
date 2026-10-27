import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageSessionSnapshotWrite } from "./atomic-snapshot-writes.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";

// Reload helpers imported by test setup so filesystem fault injection reaches them.
vi.hoisted(() => vi.resetModules());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

const actualOpen = vi.mocked(openSync).getMockImplementation()!;
const actualSync = vi.mocked(fsyncSync).getMockImplementation()!;
const actualClose = vi.mocked(closeSync).getMockImplementation()!;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

let home = "";
let cwd = "";
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-atomic-snapshot-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-atomic-snapshot-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
});

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.mocked(openSync).mockReset().mockImplementation(actualOpen);
  vi.mocked(fsyncSync).mockReset().mockImplementation(actualSync);
  vi.mocked(closeSync).mockReset().mockImplementation(actualClose);
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("atomic session snapshot writes", () => {
  it("replays daemon snapshot writes left after tmp fsync and atomic rename", () => {
    seedRun("run-crash", "session-crash");
    const pending = stageSessionSnapshotWrite(
      driver.projectDir,
      {
        sessionId: "session-crash",
        snapshotAt: "2026-05-01T00:00:10.000Z",
        conversationJson: JSON.stringify([{ role: "user", content: "save" }]),
        toolStateJson: JSON.stringify({ lastTrigger: "message_exchange" }),
        mcpConnectionStateJson: JSON.stringify({ status: "connected" }),
      },
      { updateRunLastSnapshotAt: true, replayOnStartup: true },
    );

    expect(existsSync(pending.path)).toBe(true);
    expect(readdirSync(pending.directory).some((name) => name.endsWith(".tmp")))
      .toBe(false);

    driver.close();
    driver = openStateDatabases({ cwd, agencHome: home });

    expect(existsSync(pending.path)).toBe(false);
    expect(latestSnapshot("session-crash")).toEqual({
      conversation: [{ role: "user", content: "save" }],
      toolState: { lastTrigger: "message_exchange" },
      mcpConnectionState: { status: "connected" },
    });
    expect(runLastSnapshotAt("run-crash")).toBe("2026-05-01T00:00:10.000Z");
  });

  it("drops non-replay staging files without inserting orphan snapshots", () => {
    const pending = stageSessionSnapshotWrite(
      driver.projectDir,
      {
        sessionId: "session-import-crash",
        snapshotAt: "2026-05-01T00:00:20.000Z",
        conversationJson: JSON.stringify([]),
        toolStateJson: JSON.stringify({}),
        mcpConnectionStateJson: JSON.stringify({}),
      },
      { replayOnStartup: false },
    );

    driver.close();
    driver = openStateDatabases({ cwd, agencHome: home });

    expect(existsSync(pending.path)).toBe(false);
    expect(snapshotCount("session-import-crash")).toBe(0);
  });

  it("quarantines a corrupt pending write instead of bricking every open", () => {
    seedRun("run-good", "session-good");
    const good = stageSessionSnapshotWrite(
      driver.projectDir,
      {
        sessionId: "session-good",
        snapshotAt: "2026-05-01T00:00:30.000Z",
        conversationJson: JSON.stringify([{ role: "user", content: "ok" }]),
        toolStateJson: JSON.stringify({ lastTrigger: "message_exchange" }),
        mcpConnectionStateJson: JSON.stringify({ status: "connected" }),
      },
      { updateRunLastSnapshotAt: true, replayOnStartup: true },
    );

    // A torn/partial write: valid filename, unparseable JSON contents.
    const corruptPath = join(good.directory, "00corrupt.json");
    writeFileSync(corruptPath, '{"format":"agenc.session_state_snapshot_write"');

    driver.close();
    // The corrupt file must not throw out of the driver constructor.
    driver = openStateDatabases({ cwd, agencHome: home });

    // Bad file quarantined to a sidecar; good file still replayed.
    expect(existsSync(corruptPath)).toBe(false);
    expect(existsSync(`${corruptPath}.corrupt`)).toBe(true);
    expect(existsSync(good.path)).toBe(false);
    expect(latestSnapshot("session-good")).toEqual({
      conversation: [{ role: "user", content: "ok" }],
      toolState: { lastTrigger: "message_exchange" },
      mcpConnectionState: { status: "connected" },
    });
  });
});

describe.each(["win32", "linux", "darwin"] as const)("snapshot directory sync on %s", (platform) => {
  it.each(["EINVAL", "ENOTSUP", "EPERM", "EACCES", "EBADF", "EISDIR", "EIO", "ENOSPC"])(
    "preserves the snapshot policy for %s from open and fsync",
    (code) => {
      Object.defineProperty(process, "platform", { value: platform });
      const error = Object.assign(new Error(`directory: ${code}`), { code });
      for (const phase of ["open", "sync"]) {
        vi.mocked(openSync).mockImplementation((path, flags, mode) => {
          if (phase === "open" && flags === "r") throw error;
          return actualOpen(path, flags, mode);
        });
        vi.mocked(fsyncSync).mockImplementation((fd) => {
          if (fstatSync(fd).isDirectory()) throw error;
          actualSync(fd);
        });
        const stage = () => stageSessionSnapshotWrite(driver.projectDir, {
          sessionId: `directory-${phase}`,
          snapshotAt: "2026-05-01T00:00:10.000Z",
          conversationJson: "[]",
          toolStateJson: "{}",
          mcpConnectionStateJson: "{}",
        });
        if (code === "EINVAL" || code === "ENOTSUP" || code === "EPERM" ||
            (platform === "win32" && code !== "EIO" && code !== "ENOSPC")) {
          expect(stage).not.toThrow();
        } else {
          expect(stage).toThrow(error);
        }
      }
    },
  );

  it("propagates EPERM from directory close", () => {
    Object.defineProperty(process, "platform", { value: platform });
    const error = Object.assign(new Error("directory close: EPERM"), { code: "EPERM" });
    vi.mocked(closeSync).mockImplementation((fd) => {
      const isDirectory = fstatSync(fd).isDirectory();
      actualClose(fd);
      if (isDirectory) throw error;
    });
    expect(() => stageSessionSnapshotWrite(driver.projectDir, {
      sessionId: "directory-close",
      snapshotAt: "2026-05-01T00:00:10.000Z",
      conversationJson: "[]",
      toolStateJson: "{}",
      mcpConnectionStateJson: "{}",
    })).toThrow(error);
  });
});

function seedRun(runId: string, sessionId: string): void {
  driver
    .prepareState(
      `INSERT INTO agent_runs (
        id,
        objective,
        status,
        started_at,
        last_active_at,
        current_session_id,
        created_by_client,
        last_snapshot_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      "atomic snapshot work",
      "running",
      "2026-05-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
      sessionId,
      "client-1",
      null,
    );
}

function latestSnapshot(sessionId: string): {
  readonly conversation: unknown;
  readonly toolState: unknown;
  readonly mcpConnectionState: unknown;
} {
  const row = driver
    .prepareState<
      [string],
      {
        conversation_json: string;
        tool_state_json: string;
        mcp_connection_state_json: string;
      }
    >(
      `SELECT conversation_json, tool_state_json, mcp_connection_state_json
       FROM session_state_snapshots
       WHERE session_id = ?
       ORDER BY snapshot_at DESC
       LIMIT 1`,
    )
    .get(sessionId);
  if (row === undefined) throw new Error("snapshot missing");
  return {
    conversation: JSON.parse(row.conversation_json),
    toolState: JSON.parse(row.tool_state_json),
    mcpConnectionState: JSON.parse(row.mcp_connection_state_json),
  };
}

function snapshotCount(sessionId: string): number {
  return (
    driver
      .prepareState<[string], { count: number }>(
        `SELECT COUNT(*) AS count
         FROM session_state_snapshots
         WHERE session_id = ?`,
      )
      .get(sessionId)?.count ?? 0
  );
}

function runLastSnapshotAt(runId: string): string | null {
  return (
    driver
      .prepareState<[string], { last_snapshot_at: string | null }>(
        "SELECT last_snapshot_at FROM agent_runs WHERE id = ?",
      )
      .get(runId)?.last_snapshot_at ?? null
  );
}
