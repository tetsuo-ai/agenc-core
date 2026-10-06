import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgenCDaemonSnapshotPolicyRegistry,
  recoverAgenCDaemonStartupState,
} from "../../src/app-server/daemon-cli.js";
import { defaultConfig } from "../../src/config/schema.js";
import { upsertAgentRun } from "../../src/state/agent-runs.js";
import { ROLLOUT_SCHEMA_VERSION } from "../../src/session/event-log.js";
import { serializeRolloutItem } from "../../src/session/rollout-item.js";
import {
  openStateDatabasePaths,
  resolveStateDatabasePaths,
} from "../../src/state/sqlite-driver.js";

const denied = vi.hoisted(() => ({ projectDir: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    lstatSync: (...args: Parameters<typeof original.lstatSync>) => {
      if (args[0] === denied.projectDir) {
        throw Object.assign(new Error("project directory access denied"), { code: "EACCES" });
      }
      return original.lstatSync(...args);
    },
  };
});

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-startup-state-"));
  cwd = join(home, "workspace");
  mkdirSync(join(cwd, ".git"), { recursive: true });
});

afterEach(() => {
  denied.projectDir = "";
  rmSync(home, { recursive: true, force: true });
});

function pathsFor(workspace = cwd) {
  return resolveStateDatabasePaths({ cwd: workspace, agencHome: home });
}

function seedExpiredRun(workspace: string) {
  const paths = pathsFor(workspace);
  const driver = openStateDatabasePaths(paths);
  try {
    upsertAgentRun(driver, {
      id: "expired-run",
      objective: "finished work",
      status: "completed",
      startedAt: "2000-01-01T00:00:00.000Z",
      lastActiveAt: "2000-01-01T00:00:00.000Z",
    });
  } finally {
    driver.close();
  }
  return paths;
}

function seedExpiredRollout(workspace: string, sessionId: string): string {
  const sessionDir = join(pathsFor(workspace).projectDir, "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = join(sessionDir, `rollout-2000-01-01T00-00-00-000Z-${sessionId}.jsonl`);
  writeFileSync(rolloutPath, serializeRolloutItem({
    type: "session_meta",
    payload: {
      sessionId, cwd: workspace, timestamp: "2000-01-01T00:00:00.000Z",
      originator: "test", agencVersion: "0.2.0",
      rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
      model: "grok-4", modelProvider: "xai",
    },
  }));
  const expiredAt = new Date("2000-01-01T00:00:00.000Z");
  utimesSync(rolloutPath, expiredAt, expiredAt);
  return rolloutPath;
}

describe("daemon startup state materialization", () => {
  it("does not create a default project solely for empty startup recovery", () => {
    const paths = pathsFor();
    expect(existsSync(paths.projectDir)).toBe(false);
    const report = recoverAgenCDaemonStartupState(home, cwd, defaultConfig());
    expect(report.recoveredRuns).toEqual([]);
    expect(report.recoveredToolCalls).toEqual([]);
    expect(existsSync(paths.projectDir)).toBe(false);
  });

  it("keeps the recovery path for an existing empty project directory", () => {
    const paths = pathsFor();
    mkdirSync(paths.projectDir, { recursive: true });
    const log = vi.fn();
    recoverAgenCDaemonStartupState(home, cwd, defaultConfig(), log);
    expect(existsSync(paths.stateDbPath)).toBe(true);
    expect(existsSync(paths.logsDbPath)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(paths.stateDbPath));
  });

  it.each([false, true])("still recovers and prunes an existing database (nonprimary=%s)", (nonprimary) => {
    const existingCwd = nonprimary ? join(home, "other") : cwd;
    if (nonprimary) mkdirSync(join(existingCwd, ".git"), { recursive: true });
    const paths = seedExpiredRun(existingCwd);
    const config = defaultConfig();
    recoverAgenCDaemonStartupState(home, cwd, {
      ...config,
      agent: { ...config.agent, retention: { completed_days: 1 } },
    });
    const driver = openStateDatabasePaths(paths);
    try {
      expect(driver.prepareState("SELECT id FROM agent_runs WHERE id = 'expired-run'").get()).toBeUndefined();
    } finally {
      driver.close();
    }
    if (nonprimary) expect(existsSync(pathsFor().projectDir)).toBe(false);
  });

  it("propagates access errors instead of treating an existing project as absent", () => {
    const paths = pathsFor();
    mkdirSync(paths.projectDir, { recursive: true });
    denied.projectDir = paths.projectDir;
    expect(() => recoverAgenCDaemonStartupState(home, cwd, defaultConfig())).toThrow("project directory access denied");
    expect(existsSync(paths.stateDbPath)).toBe(false);
  });

  it("materializes a new snapshot policy before its first durable run write", () => {
    const paths = pathsFor();
    const policies = new AgenCDaemonSnapshotPolicyRegistry({
      agencHome: home, defaultCwd: cwd, onError: () => {},
    });
    try {
      policies.flushPeriodic();
      expect(existsSync(paths.projectDir)).toBe(false);
      policies.recordAgentRun({
        id: "new-run", objective: "new work", status: "pending",
        startedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      });
      expect(existsSync(paths.stateDbPath)).toBe(true);
      expect(existsSync(paths.logsDbPath)).toBe(false);
      const driver = openStateDatabasePaths(paths, undefined, { deferLogs: true });
      try {
        expect(driver.prepareState("SELECT id FROM agent_runs WHERE id = 'new-run'").get()).toEqual({ id: "new-run" });
      } finally {
        driver.close();
      }
    } finally {
      policies.close();
    }
  });

  it("initializes the snapshot policy eagerly for an existing empty project", () => {
    const paths = pathsFor();
    mkdirSync(paths.projectDir, { recursive: true });
    const policies = new AgenCDaemonSnapshotPolicyRegistry({
      agencHome: home, defaultCwd: cwd, onError: () => {},
    });
    try {
      expect(existsSync(paths.stateDbPath)).toBe(true);
      expect(existsSync(paths.logsDbPath)).toBe(false);
    } finally {
      policies.close();
    }
  });

  it("retains periodic rollout cleanup when another process creates the default project", () => {
    const paths = pathsFor();
    const onError = vi.fn();
    const policies = new AgenCDaemonSnapshotPolicyRegistry({
      agencHome: home, defaultCwd: cwd, snapshotRetention: { rollout_days: 1 }, onError,
    });
    try {
      policies.flushPeriodic();
      expect(existsSync(paths.projectDir)).toBe(false);
      const rolloutPath = seedExpiredRollout(cwd, "external-old-session");
      expect(existsSync(paths.stateDbPath)).toBe(false);
      policies.flushPeriodic();
      expect(existsSync(paths.stateDbPath)).toBe(true);
      expect(existsSync(rolloutPath)).toBe(false);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      policies.close();
    }
  });

  it("flushes other project policies even when deferred default discovery fails", () => {
    const otherCwd = join(home, "other-workspace");
    mkdirSync(join(otherCwd, ".git"), { recursive: true });
    const onError = vi.fn();
    const policies = new AgenCDaemonSnapshotPolicyRegistry({
      agencHome: home, defaultCwd: cwd, snapshotRetention: { rollout_days: 1 }, onError,
    });
    try {
      policies.registerSession({ sessionId: "other-session", agentId: "other-agent", cwd: otherCwd });
      const rolloutPath = seedExpiredRollout(otherCwd, "external-other-old-session");
      denied.projectDir = pathsFor().projectDir;
      expect(() => policies.flushPeriodic()).toThrow("daemon periodic snapshot flush failed");
      expect(existsSync(rolloutPath)).toBe(false);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "EACCES" }));
    } finally {
      denied.projectDir = "";
      policies.close();
    }
  });

  it("does not reopen the default policy after its last routed session releases it", () => {
    const onError = vi.fn();
    const policies = new AgenCDaemonSnapshotPolicyRegistry({
      agencHome: home, defaultCwd: cwd, snapshotRetention: { rollout_days: 1 }, onError,
    });
    try {
      policies.registerSession({ sessionId: "released-session", agentId: "released-agent", cwd });
      policies.releaseSession("released-session");
      const rolloutPath = seedExpiredRollout(cwd, "external-after-release");
      policies.flushPeriodic();
      expect(existsSync(rolloutPath)).toBe(true);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      policies.close();
    }
  });

  it("does not defer snapshot storage errors", () => {
    denied.projectDir = pathsFor().projectDir;
    expect(() => new AgenCDaemonSnapshotPolicyRegistry({
      agencHome: home, defaultCwd: cwd, onError: () => {},
    })).toThrow("project directory access denied");
  });
});


it.each(["malformed", "access-error"])("keeps existing logs validation eager for snapshot policy: %s", failure => {
  const paths = pathsFor(); mkdirSync(paths.projectDir, { recursive: true });
  if (failure === "malformed") writeFileSync(paths.logsDbPath, "malformed SQLite");
  else denied.projectDir = paths.logsDbPath;
  expect(() => new AgenCDaemonSnapshotPolicyRegistry({ agencHome: home, defaultCwd: cwd, onError: () => {} })).toThrow();
});
