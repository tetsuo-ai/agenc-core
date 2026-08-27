import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { AsyncQueue } from "../utils/async-queue.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ROLLOUT_SCHEMA_VERSION } from "./event-log.js";
import { EventLog } from "./event-log.js";
import {
  DEFAULT_SESSION_ROOT_MARKERS,
  findProjectRootSync,
  getProjectDir,
  I4_FSYNC_RETRY_MS,
  MAX_SESSION_INDEX_ENTRIES,
  readIndexSnapshot,
  rewriteAtomically,
  SchemaMismatchError,
  SESSION_INDEX_EVICT_BATCH,
  SessionLock,
  SessionLockedError,
  SessionStore,
  createResumeRolloutDescriptorLease,
  hasSupportedFileIdentity,
  slugifyCwd,
  truncateCorruptTail,
} from "./session-store.js";
import { RolloutStore } from "./rollout-store.js";
import { Session } from "./session.js";
import {
  AGENC_TRAJECTORY_EXPORT_PATH_ENV,
  TRAJECTORY_EXPORT_SCHEMA_VERSION,
} from "./trajectory-export.js";

describe("session-store", () => {
  let home = "";
  let origHome = "";

  function findDeadPid(): number {
    for (const pid of [2_147_483_647, 99_999_999, 4_194_303]) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        if ((err as { code?: string }).code === "ESRCH") return pid;
      }
    }
    throw new Error("unable to find a dead pid for stale-lock test");
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-session-store-"));
    origHome = process.env.AGENC_HOME ?? "";
    process.env.AGENC_HOME = home;
  });
  afterEach(() => {
    if (origHome) process.env.AGENC_HOME = origHome;
    else delete process.env.AGENC_HOME;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("slugifyCwd produces stable slug + hash suffix", () => {
    const a = slugifyCwd("/home/user/proj");
    const b = slugifyCwd("/home/user/proj");
    expect(a).toBe(b);
    expect(a.endsWith("-").length).toBeFalsy();
  });

  test("open creates session_meta header with schema version (I-49)", () => {
    const store = new SessionStore({
      cwd: "/home/test",
      sessionId: "sess-a",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-a",
      timestamp: new Date().toISOString(),
      cwd: "/home/test",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    const content = readFileSync(store.rolloutPath, "utf8");
    expect(content).toContain(
      `"rolloutSchemaVersion":${ROLLOUT_SCHEMA_VERSION}`,
    );
    expect(content).toContain(`"sessionId":"sess-a"`);
    store.close();
  });

  test("fresh session metadata canonicalizes a symlink-spelled workspace", () => {
    const canonicalCwd = mkdtempSync(join(home, "canonical-workspace-"));
    const lexicalCwd = join(home, "workspace-alias");
    symlinkSync(canonicalCwd, lexicalCwd, "dir");
    const store = new SessionStore({
      cwd: lexicalCwd,
      sessionId: "sess-canonical-cwd",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-canonical-cwd",
      timestamp: new Date().toISOString(),
      cwd: lexicalCwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    try {
      const firstLine = readFileSync(store.rolloutPath, "utf8").split("\n")[0]!;
      expect(JSON.parse(firstLine)).toMatchObject({
        type: "session_meta",
        payload: { cwd: realpathSync(canonicalCwd) },
      });
    } finally {
      store.close();
    }
  });

  test("explicit resume opens a canonical rollout through a symlinked AGENC_HOME", () => {
    const cwd = mkdtempSync(join(home, "resume-workspace-"));
    const sessionId = "sess-home-alias-resume";
    const seed = new SessionStore({ cwd, sessionId, agencVersion: "0.2.0" });
    seed.open({
      sessionId,
      timestamp: new Date().toISOString(),
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    const rolloutPath = seed.rolloutPath;
    seed.close();

    const lexicalHome = `${home}-alias`;
    symlinkSync(home, lexicalHome, "dir");
    process.env.AGENC_HOME = lexicalHome;
    const resumed = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      resume: true,
      resumeRolloutPath: rolloutPath,
    });
    try {
      expect(() =>
        resumed.open({
          sessionId,
          timestamp: new Date().toISOString(),
          cwd,
          originator: "agenc-cli",
          agencVersion: "0.2.0",
        }),
      ).not.toThrow();
      expect(resumed.rolloutPath).toBe(realpathSync(rolloutPath));
    } finally {
      resumed.close();
      rmSync(lexicalHome, { force: true });
      process.env.AGENC_HOME = home;
    }
  });

  test("open rejects rollout header schema newer than the runtime", () => {
    const store = new SessionStore({
      cwd: "/home/test-schema-newer",
      sessionId: "sess-schema-newer",
      agencVersion: "0.2.0",
    });
    writeFileSync(
      store.rolloutPath,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          sessionId: "sess-schema-newer",
          timestamp: new Date().toISOString(),
          cwd: "/home/test-schema-newer",
          originator: "agenc-cli",
          agencVersion: "0.2.0",
          rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION + 1,
        },
        eventVersion: 1,
      })}\n`,
      { mode: 0o600 },
    );

    expect(() =>
      store.open({
        sessionId: "sess-schema-newer",
        timestamp: new Date().toISOString(),
        cwd: "/home/test-schema-newer",
        originator: "agenc-cli",
        agencVersion: "0.2.0",
      }),
    ).toThrowError(SchemaMismatchError);
    expect(() =>
      store.open({
        sessionId: "sess-schema-newer",
        timestamp: new Date().toISOString(),
        cwd: "/home/test-schema-newer",
        originator: "agenc-cli",
        agencVersion: "0.2.0",
      }),
    ).toThrowError(/please use \/fork to migrate or upgrade/i);
  });

  test("explicit resume rejects a hard-linked canonical rollout", () => {
    const cwd = mkdtempSync(join(home, "resume-hardlink-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const sessionId = "conv-hardlink1";
    const seed = new SessionStore({ cwd, sessionId, agencVersion: "0.2.0" });
    const meta = {
      sessionId,
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    } as const;
    seed.open(meta);
    seed.close();
    linkSync(seed.rolloutPath, `${seed.rolloutPath}.alias`);

    const resumed = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      resume: true,
      resumeRolloutPath: seed.rolloutPath,
    });
    expect(() => resumed.open(meta)).toThrow("regular non-symlink file");
  });

  test("explicit resume refuses to append after the bound source is swapped", () => {
    const cwd = mkdtempSync(join(home, "resume-swap-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const sessionId = "conv-swap1";
    const seed = new SessionStore({ cwd, sessionId, agencVersion: "0.2.0" });
    const meta = {
      sessionId,
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    } as const;
    seed.open(meta);
    seed.close();
    const original = readFileSync(seed.rolloutPath);
    const parked = `${seed.rolloutPath}.parked`;
    const resumed = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      resume: true,
      resumeRolloutPath: seed.rolloutPath,
    });
    resumed.open(meta);
    renameSync(seed.rolloutPath, parked);
    writeFileSync(seed.rolloutPath, original);
    const replacementBefore = readFileSync(seed.rolloutPath);

    expect(() =>
      resumed.append(
        {
          id: "swap-event",
          eventId: "swap-event",
          seq: 1,
          msg: { type: "warning", payload: { cause: "test", message: "safe" } },
        },
        { durable: true },
      ),
    ).toThrow("resume rollout source changed during validation");
    expect(readFileSync(seed.rolloutPath)).toEqual(replacementBefore);

    rmSync(seed.rolloutPath, { force: true });
    renameSync(parked, seed.rolloutPath);
    resumed.close();
  });

  test("descriptor-bound readAll fails closed when its canonical path disappears", () => {
    const cwd = mkdtempSync(join(home, "resume-read-missing-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const sessionId = "conv-readmissing1";
    const meta = {
      sessionId,
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    } as const;
    const seed = new SessionStore({ cwd, sessionId, agencVersion: "0.2.0" });
    seed.open(meta);
    seed.close();
    const parked = `${seed.rolloutPath}.parked`;
    const resumed = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      resume: true,
      resumeRolloutPath: seed.rolloutPath,
    });
    resumed.open(meta);
    renameSync(seed.rolloutPath, parked);
    try {
      expect(() => resumed.readAll()).toThrow(
        "resume rollout source changed during validation",
      );
    } finally {
      renameSync(parked, seed.rolloutPath);
      resumed.close();
    }
  });

  test("descriptor handoff never treats a missing resume path as a fresh rollout", () => {
    const cwd = mkdtempSync(join(home, "resume-handoff-missing-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const sessionId = "conv-handoffmissing1";
    const meta = {
      sessionId,
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    } as const;
    const seed = new SessionStore({ cwd, sessionId, agencVersion: "0.2.0" });
    seed.open(meta);
    seed.close();
    const sourceFd = openSync(
      seed.rolloutPath,
      fsConstants.O_RDWR | fsConstants.O_APPEND,
    );
    const lease = createResumeRolloutDescriptorLease(
      seed.rolloutPath,
      sourceFd,
    );
    const parked = `${seed.rolloutPath}.parked`;
    renameSync(seed.rolloutPath, parked);
    const resumed = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      resume: true,
      resumeRolloutPath: seed.rolloutPath,
      resumeRolloutLease: lease,
    });
    try {
      expect(() => resumed.open(meta)).toThrow(
        "resume rollout source changed during validation",
      );
      expect(existsSync(seed.rolloutPath)).toBe(false);
    } finally {
      renameSync(parked, seed.rolloutPath);
    }
  });

  test.each(["append", "in-place"] as const)(
    "descriptor-bound streaming rewrite rejects a mid-read %s mutation",
    (mutation) => {
      const cwd = mkdtempSync(join(home, `resume-stream-${mutation}-cwd-`));
      mkdirSync(join(cwd, ".git"));
      const sessionId = `conv-stream-${mutation.replaceAll("-", "")}`;
      const meta = {
        sessionId,
        timestamp: "2026-08-19T00:00:00.000Z",
        cwd,
        originator: "agenc-cli",
        agencVersion: "0.2.0",
      } as const;
      const seed = new SessionStore({ cwd, sessionId, agencVersion: "0.2.0" });
      seed.open(meta);
      seed.rewriteRolloutItemsAtomically([
        ...seed.readAll(),
        {
          type: "response_item",
          payload: { role: "user", content: "authorized removal" },
        },
      ]);
      seed.close();
      const physicalLines = readFileSync(seed.rolloutPath, "utf8").split("\n");
      const physical = Buffer.from(`${physicalLines[1]!}\n`, "utf8");
      const digestDomain = "descriptor-bound-streaming-rewrite-test";
      const beforeInode = lstatSync(seed.rolloutPath, { bigint: true }).ino;
      let mutated = false;
      const resumed = new SessionStore({
        cwd,
        sessionId,
        agencVersion: "0.2.0",
        resume: true,
        resumeRolloutPath: seed.rolloutPath,
        afterBoundResumeStreamingRewriteReadForTestingOnly: () => {
          if (mutated) return;
          mutated = true;
          if (mutation === "append") {
            writeFileSync(
              seed.rolloutPath,
              `${JSON.stringify({
                type: "response_item",
                payload: { role: "user", content: "raced append" },
              })}\n`,
              { flag: "a" },
            );
            return;
          }
          const fd = openSync(seed.rolloutPath, fsConstants.O_RDWR);
          try {
            writeSync(fd, Buffer.from(" "), 0, 1, 0);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        },
      });
      resumed.open(meta);
      expect(() =>
        resumed.rewriteRolloutExcludingPhysicalLinesAtomically(
          [
            {
              lineNumber: 2,
              encodedBytes: physical.byteLength,
              sha256: createHash("sha256")
                .update(digestDomain, "utf8")
                .update(physical)
                .digest("hex"),
              itemType: "response_item",
            },
          ],
          digestDomain,
        ),
      ).toThrow("resume rollout source changed during streaming rewrite");
      expect(mutated).toBe(true);
      expect(lstatSync(seed.rolloutPath, { bigint: true }).ino).toBe(
        beforeInode,
      );
      resumed.close();
    },
  );

  test("descriptor handoff rejects a source swap before SessionStore adoption", () => {
    const cwd = mkdtempSync(join(home, "resume-handoff-swap-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const sessionId = "conv-handoffswap1";
    const meta = {
      sessionId,
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    } as const;
    const seed = new SessionStore({ cwd, sessionId, agencVersion: "0.2.0" });
    seed.open(meta);
    seed.close();
    const original = readFileSync(seed.rolloutPath);
    const sourceFd = openSync(
      seed.rolloutPath,
      fsConstants.O_RDWR | fsConstants.O_APPEND,
    );
    const lease = createResumeRolloutDescriptorLease(
      seed.rolloutPath,
      sourceFd,
    );
    const parked = `${seed.rolloutPath}.parked`;
    renameSync(seed.rolloutPath, parked);
    writeFileSync(seed.rolloutPath, original, { mode: 0o600 });
    const replacement = readFileSync(seed.rolloutPath);
    const resumed = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      resume: true,
      resumeRolloutPath: seed.rolloutPath,
      resumeRolloutLease: lease,
    });

    expect(() => resumed.open(meta)).toThrow(
      "resume rollout source changed during validation",
    );
    expect(readFileSync(seed.rolloutPath)).toEqual(replacement);
    expect(existsSync(resumed.lockPath)).toBe(false);

    rmSync(seed.rolloutPath, { force: true });
    renameSync(parked, seed.rolloutPath);
  });

  test("close releases the resumed descriptor and lock after a flush failure", () => {
    const cwd = mkdtempSync(join(home, "resume-close-failure-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const sessionId = "conv-closefailure1";
    const meta = {
      sessionId,
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    } as const;
    const seed = new SessionStore({ cwd, sessionId, agencVersion: "0.2.0" });
    seed.open(meta);
    seed.close();
    const resumed = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      resume: true,
      resumeRolloutPath: seed.rolloutPath,
    });
    resumed.open(meta);
    resumed.append({
      id: "queued-close-failure",
      eventId: "queued-close-failure",
      seq: 1,
      msg: {
        type: "warning",
        payload: { cause: "test", message: "queued" },
      },
    });
    resumed.setWriteImplForTest(() => {
      throw new Error("injected close flush failure");
    });

    expect(() => resumed.close()).toThrow("injected close flush failure");
    expect(existsSync(resumed.lockPath)).toBe(false);

    const reopened = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      resume: true,
      resumeRolloutPath: seed.rolloutPath,
    });
    expect(() => reopened.open(meta)).not.toThrow();
    reopened.close();
  });

  test("explicit resume open preserves its failure while releasing a close-failed descriptor and lock", () => {
    const cwd = mkdtempSync(join(home, "resume-open-cleanup-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const sessionId = "conv-opencleanup1";
    const meta = {
      sessionId,
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    } as const;
    const seed = new SessionStore({ cwd, sessionId, agencVersion: "0.2.0" });
    seed.open(meta);
    seed.close();
    const primary = new Error("injected resume fsync failure");
    const cleanup = new Error("injected resume close report failure");
    const resumed = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      resume: true,
      resumeRolloutPath: seed.rolloutPath,
      resumeSourceCloseForTestingOnly: (fd) => {
        closeSync(fd);
        throw cleanup;
      },
    });
    resumed.setFsyncImplForTest(() => {
      throw primary;
    });

    let thrown: unknown;
    try {
      resumed.open(meta);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).cause).toBe(primary);
    expect((thrown as AggregateError).errors).toEqual([primary, cleanup]);
    expect(existsSync(resumed.lockPath)).toBe(false);

    const reopened = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      resume: true,
      resumeRolloutPath: seed.rolloutPath,
    });
    expect(() => reopened.open(meta)).not.toThrow();
    reopened.close();
  });

  test("explicit resume atomically rebinds after a typed rollout rewrite", () => {
    const cwd = mkdtempSync(join(home, "resume-rewrite-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const sessionId = "conv-rewrite1";
    const meta = {
      sessionId,
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    } as const;
    const seed = new SessionStore({ cwd, sessionId, agencVersion: "0.2.0" });
    seed.open(meta);
    seed.close();

    const resumed = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      resume: true,
      resumeRolloutPath: seed.rolloutPath,
      boundResumeRewriteRenameForTestingOnly: (from, to) => {
        if (existsSync(to)) {
          throw Object.assign(new Error("injected replace-over-open failure"), {
            code: "EPERM",
          });
        }
        renameSync(from, to);
      },
      boundResumeRewriteDirectorySyncForTestingOnly: () => {
        throw Object.assign(new Error("injected Windows directory fsync"), {
          code: "EPERM",
        });
      },
      boundResumeRewritePlatformForTestingOnly: "win32",
      boundResumeRewriteUnlinkForTestingOnly: () => {
        throw Object.assign(new Error("injected stale recovery cleanup"), {
          code: "EPERM",
        });
      },
    });
    resumed.open(meta);
    resumed.append(
      {
        id: "before-rewrite",
        eventId: "before-rewrite",
        seq: 1,
        msg: {
          type: "warning",
          payload: { cause: "test", message: "before" },
        },
      },
      { durable: true },
    );
    const before = lstatSync(seed.rolloutPath, { bigint: true });

    resumed.rewriteRolloutItemsAtomically(resumed.readAll());

    const after = lstatSync(seed.rolloutPath, { bigint: true });
    expect(after.ino).not.toBe(before.ino);
    expect(resumed.canonicalSourceIdentity()).toMatchObject({
      rolloutPath: seed.rolloutPath,
      dev: after.dev.toString(10),
      ino: after.ino.toString(10),
    });
    expect(
      readdirSync(dirname(seed.rolloutPath)).some(
        (name) =>
          name.startsWith("rollout-recovery-") &&
          name.endsWith(`-${sessionId}.jsonl`),
      ),
    ).toBe(true);
    resumed.append(
      {
        id: "after-rewrite",
        eventId: "after-rewrite",
        seq: 2,
        msg: {
          type: "warning",
          payload: { cause: "test", message: "after" },
        },
      },
      { durable: true },
    );
    resumed.close();
    expect(readFileSync(seed.rolloutPath, "utf8")).toContain("after-rewrite");
  });

  test("explicit resume rejects a rewrite path swap and keeps its old descriptor usable", () => {
    const cwd = mkdtempSync(join(home, "resume-rewrite-swap-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const sessionId = "conv-rewriteswap1";
    const meta = {
      sessionId,
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    } as const;
    const seed = new SessionStore({ cwd, sessionId, agencVersion: "0.2.0" });
    seed.open(meta);
    seed.close();
    const parked = `${seed.rolloutPath}.parked`;
    const original = readFileSync(seed.rolloutPath);
    let injected = false;
    const resumed = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      resume: true,
      resumeRolloutPath: seed.rolloutPath,
      beforeBoundResumeRewritePublishForTestingOnly: () => {
        if (injected) return;
        injected = true;
        renameSync(seed.rolloutPath, parked);
        writeFileSync(seed.rolloutPath, original, { mode: 0o600 });
      },
    });
    resumed.open(meta);

    expect(() =>
      resumed.rewriteRolloutItemsAtomically(resumed.readAll()),
    ).toThrow("resume rollout source changed during validation");
    expect(readFileSync(seed.rolloutPath)).toEqual(original);

    rmSync(seed.rolloutPath, { force: true });
    renameSync(parked, seed.rolloutPath);
    resumed.append(
      {
        id: "old-descriptor-still-live",
        eventId: "old-descriptor-still-live",
        seq: 1,
        msg: {
          type: "warning",
          payload: { cause: "test", message: "usable" },
        },
      },
      { durable: true },
    );
    resumed.close();
    expect(readFileSync(seed.rolloutPath, "utf8")).toContain(
      "old-descriptor-still-live",
    );
  });

  test("explicit resume rejects an in-place source change after its typed rewrite read", () => {
    const cwd = mkdtempSync(join(home, "resume-rewrite-read-race-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const sessionId = "conv-rewritereadrace1";
    const meta = {
      sessionId,
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    } as const;
    const seed = new SessionStore({ cwd, sessionId, agencVersion: "0.2.0" });
    seed.open(meta);
    seed.close();
    const resumed = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      resume: true,
      resumeRolloutPath: seed.rolloutPath,
    });
    resumed.open(meta);
    const items = resumed.readAll();
    const beforeInode = lstatSync(seed.rolloutPath, { bigint: true }).ino;
    writeFileSync(
      seed.rolloutPath,
      `${JSON.stringify({
        type: "response_item",
        payload: { role: "user", content: "raced typed rewrite" },
      })}\n`,
      { flag: "a" },
    );

    expect(() => resumed.rewriteRolloutItemsAtomically(items)).toThrow(
      "resume rollout source changed after its exact read",
    );
    expect(lstatSync(seed.rolloutPath, { bigint: true }).ino).toBe(beforeInode);
    expect(readFileSync(seed.rolloutPath, "utf8")).toContain(
      "raced typed rewrite",
    );
    resumed.close();
  });

  test.each([
    "old_moved",
    "new_published",
    "directory_synced",
    "new_opened",
    "metadata_validated",
    "before_old_close",
  ] as const)(
    "explicit resume rolls back a replacement failure after %s",
    (failStep) => {
      const cwd = mkdtempSync(join(home, `resume-failpoint-${failStep}-`));
      mkdirSync(join(cwd, ".git"));
      const sessionId = `conv-fail-${failStep.replaceAll("_", "-")}`;
      const meta = {
        sessionId,
        timestamp: "2026-08-19T00:00:00.000Z",
        cwd,
        originator: "agenc-cli",
        agencVersion: "0.2.0",
      } as const;
      const seed = new SessionStore({ cwd, sessionId, agencVersion: "0.2.0" });
      seed.open(meta);
      seed.close();
      const original = readFileSync(seed.rolloutPath);
      const resumed = new SessionStore({
        cwd,
        sessionId,
        agencVersion: "0.2.0",
        resume: true,
        resumeRolloutPath: seed.rolloutPath,
        afterBoundResumeRewriteStepForTestingOnly: (step) => {
          if (step === failStep)
            throw new Error(`injected ${failStep} failure`);
        },
      });
      resumed.open(meta);

      expect(() =>
        resumed.rewriteRolloutItemsAtomically(resumed.readAll()),
      ).toThrow(`injected ${failStep} failure`);
      expect(readFileSync(seed.rolloutPath)).toEqual(original);
      resumed.append(
        {
          id: `append-after-${failStep}`,
          eventId: `append-after-${failStep}`,
          seq: 1,
          msg: {
            type: "warning",
            payload: { cause: "test", message: "rollback usable" },
          },
        },
        { durable: true },
      );
      resumed.close();
      expect(readFileSync(seed.rolloutPath, "utf8")).toContain(
        `append-after-${failStep}`,
      );
    },
  );

  test("explicit resume revokes writer authority when replacement rollback cannot be proven", () => {
    const cwd = mkdtempSync(join(home, "resume-rollback-failure-"));
    mkdirSync(join(cwd, ".git"));
    const sessionId = "conv-rollbackfailure1";
    const meta = {
      sessionId,
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    } as const;
    const seed = new SessionStore({ cwd, sessionId, agencVersion: "0.2.0" });
    seed.open(meta);
    seed.close();
    let renameCount = 0;
    const resumed = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      resume: true,
      resumeRolloutPath: seed.rolloutPath,
      boundResumeRewriteRenameForTestingOnly: (from, to) => {
        renameCount += 1;
        if (renameCount === 4)
          throw new Error("injected rollback rename failure");
        renameSync(from, to);
      },
      afterBoundResumeRewriteStepForTestingOnly: (step) => {
        if (step === "new_published") {
          throw new Error("injected post-publication failure");
        }
      },
    });
    resumed.open(meta);

    expect(() =>
      resumed.rewriteRolloutItemsAtomically(resumed.readAll()),
    ).toThrow(/could not restore its prior generation/);
    expect(() => resumed.syncCanonicalTail()).toThrow(
      "writer authority was revoked",
    );
    resumed.close();
  });

  test("file identity rejects unavailable Windows sentinel values", () => {
    const sentinel = 0xffff_ffff_ffff_ffffn;
    expect(hasSupportedFileIdentity({ dev: sentinel, ino: 1n })).toBe(false);
    expect(hasSupportedFileIdentity({ dev: 1n, ino: sentinel })).toBe(false);
    expect(hasSupportedFileIdentity({ dev: 1n, ino: 1n })).toBe(true);
  });

  test("open accepts an older rollout schema header without rewriting it", () => {
    const store = new SessionStore({
      cwd: "/home/test-schema-older",
      sessionId: "sess-schema-older",
      agencVersion: "0.2.0",
    });
    writeFileSync(
      store.rolloutPath,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          sessionId: "sess-schema-older",
          timestamp: new Date().toISOString(),
          cwd: "/home/test-schema-older",
          originator: "agenc-cli",
          agencVersion: "0.1.0",
          rolloutSchemaVersion: 0,
        },
        eventVersion: 0,
      })}\n`,
      { mode: 0o600 },
    );

    store.open({
      sessionId: "sess-schema-older",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-schema-older",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    store.append({
      id: "legacy-mixed-row",
      seq: 1,
      msg: {
        type: "warning",
        payload: { cause: "compat", message: "mixed history" },
      },
    });
    store.close();

    const [headerLine, appendedLine] = readFileSync(store.rolloutPath, "utf8")
      .trim()
      .split("\n");
    const header = JSON.parse(headerLine!);
    const appended = JSON.parse(appendedLine!);

    expect(header.payload.rolloutSchemaVersion).toBe(0);
    expect(header.eventVersion).toBe(0);
    expect(appended.type).toBe("event_msg");
    expect(appended.eventVersion).toBe(1);
  });

  test("I-23 SessionLock: a distinct same-PID owner cannot acquire or release the lease", () => {
    // Independent stores in one daemon share a PID, so ownership must include
    // the unique start token. A second wrapper must neither enter nor unlink a
    // lease held by the first owner identity.
    const dir = mkdtempSync(join(tmpdir(), "agenc-lock-xproc-"));
    try {
      const lockPath = join(dir, "rollout.jsonl.lock");
      const stamp = JSON.stringify({
        pid: process.pid,
        startNs: "other-holder-with-same-pid",
        acquiredAtIso: new Date().toISOString(),
      });
      writeFileSync(lockPath, `${stamp}\n`);
      const secondLock = new SessionLock(lockPath);
      expect(() => secondLock.acquire()).toThrow(SessionLockedError);
      secondLock.release();
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("I-23 SessionLock: two-process exclusivity — spawn child, parent acquire must fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-lock-child-"));
    let child: ReturnType<typeof spawn> | null = null;
    try {
      const lockPath = join(dir, "rollout.jsonl.lock");
      const readyPath = join(dir, "child.ready");
      // The child script is self-contained: it uses the same atomic
      // `tmp+linkSync` recipe as SessionLock so the parent's
      // SessionLock.acquire() observes a live, valid lock file and
      // must throw SessionLockedError. We spawn detached so the
      // child outlives the parent's acquire attempt regardless of
      // the vitest test duration.
      const childScript = `
        const { openSync, writeSync, fsyncSync, closeSync, linkSync, unlinkSync, writeFileSync } = require("node:fs");
        const lockPath = ${JSON.stringify(lockPath)};
        const readyPath = ${JSON.stringify(readyPath)};
        const tmp = lockPath + "." + process.pid + ".tmp";
        const record = JSON.stringify({
          pid: process.pid,
          startNs: "child-" + Date.now(),
          acquiredAtIso: new Date().toISOString(),
        }) + "\\n";
        const fd = openSync(tmp, "wx", 0o600);
        writeSync(fd, record);
        fsyncSync(fd);
        closeSync(fd);
        linkSync(tmp, lockPath);
        try { unlinkSync(tmp); } catch {}
        writeFileSync(readyPath, String(process.pid));
        // Sleep ~10s holding the lock. The parent test will finish
        // far before then; it signals us via SIGTERM on cleanup.
        setTimeout(() => process.exit(0), 10_000);
      `;
      child = spawn(process.execPath, ["-e", childScript], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let childStdout = "";
      let childStderr = "";
      let childSpawnError: Error | undefined;
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        childStdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        childStderr += chunk;
      });
      child.once("error", (error) => {
        childSpawnError = error;
      });
      child.unref();

      // Poll for the child's ready file — at most 3s.
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !existsSync(readyPath)) {
        await new Promise((r) => setTimeout(r, 25));
      }

      const readyExists = existsSync(readyPath);
      const lockExists = existsSync(lockPath);
      if (!readyExists || !lockExists) {
        throw new Error(
          [
            "SessionLock child failed to establish the cross-process lock within 3000ms",
            `pid=${String(child.pid)}`,
            `exitCode=${String(child.exitCode)}`,
            `signalCode=${String(child.signalCode)}`,
            `spawnError=${childSpawnError?.stack ?? "none"}`,
            `readyPath=${JSON.stringify(readyPath)} exists=${String(readyExists)}`,
            `lockPath=${JSON.stringify(lockPath)} exists=${String(lockExists)}`,
            `stdout=${JSON.stringify(childStdout)}`,
            `stderr=${JSON.stringify(childStderr)}`,
          ].join("\n"),
        );
      }

      // Sanity: verify the lock file holds the child's pid, not
      // ours. This guards against a race where the child's ready
      // file was observed but the lockfile points somewhere else.
      const record = JSON.parse(readFileSync(lockPath, "utf8").trim()) as {
        pid: number;
      };
      expect(record.pid).not.toBe(process.pid);
      expect(record.pid).toBe(child.pid);

      // The child is holding the lock + child PID is alive. Parent
      // acquire MUST throw SessionLockedError.
      const parentLock = new SessionLock(lockPath);
      let caught: unknown;
      try {
        parentLock.acquire();
        parentLock.release();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SessionLockedError);
      expect((caught as SessionLockedError).holderPid).toBe(child.pid);
    } finally {
      if (child && child.pid !== undefined) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          /* already dead */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("I-23 SessionLock: stale-holder reclaim (dead PID -> next acquire succeeds)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-lock-stale-"));
    try {
      const lockPath = join(dir, "rollout.jsonl.lock");
      const deadPid = findDeadPid();
      const stamp = JSON.stringify({
        pid: deadPid,
        startNs: "stale",
        acquiredAtIso: new Date().toISOString(),
      });
      writeFileSync(lockPath, `${stamp}\n`);
      const lock = new SessionLock(lockPath);
      // This should succeed: dead holder -> stale reclaim path.
      lock.acquire();
      // After acquire, the lock file should contain OUR pid, not the dead one.
      const record = JSON.parse(readFileSync(lockPath, "utf8").trim());
      expect(record.pid).toBe(process.pid);
      lock.release();
      // After release, the lock file should be gone.
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("I-23 SessionLock: second acquire in same process is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-lock-reentry-"));
    try {
      const lockPath = join(dir, "rollout.jsonl.lock");
      const lock = new SessionLock(lockPath);
      lock.acquire();
      expect(() => lock.acquire()).not.toThrow();
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("I-24 rewriteAtomically replaces file durably + cleans up tmp on failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-rewrite-"));
    try {
      const target = join(dir, "target.json");
      writeFileSync(target, "original\n");
      rewriteAtomically(target, "replacement\n");
      expect(readFileSync(target, "utf8")).toBe("replacement\n");
      // Tmp must not linger.
      expect(existsSync(`${target}.tmp`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("I-24 rewriteAtomically: a stale tmp from a prior crash is cleared, not refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-rewrite-stale-"));
    try {
      const target = join(dir, "target.json");
      writeFileSync(target, "original\n");
      // Simulate a crashed prior run that left tmp in place.
      writeFileSync(`${target}.tmp`, "stale-tmp-contents");
      rewriteAtomically(target, "fresh\n");
      expect(readFileSync(target, "utf8")).toBe("fresh\n");
      expect(existsSync(`${target}.tmp`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("I-88 toolResultBytes + tokenEstimate indexes accumulate per-turn", () => {
    const store = new SessionStore({
      cwd: "/home/test",
      sessionId: "sess-b",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-b",
      timestamp: new Date().toISOString(),
      cwd: "/home/test",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    store.append(
      {
        id: "s",
        seq: 2,
        msg: {
          type: "tool_call_completed",
          payload: { callId: "c1", result: "ok", isError: false },
        },
      },
      { turnId: "turn-1", toolResultBytes: 5000, tokenEstimate: 1250 },
    );
    store.append(
      {
        id: "s",
        seq: 3,
        msg: {
          type: "tool_call_completed",
          payload: { callId: "c2", result: "ok", isError: false },
        },
      },
      { turnId: "turn-1", toolResultBytes: 7000, tokenEstimate: 1750 },
    );
    expect(store.getToolResultBytes("turn-1")).toBe(12000);
    expect(store.getTokenEstimate("turn-1")).toBe(3000);
    store.close();
  });

  test("resumed schema upgrade reads only from its pinned descriptor during a path swap", () => {
    const cwd = mkdtempSync(join(home, "resume-schema-swap-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const sessionId = "conv-schemaswap1";
    const seed = new SessionStore({ cwd, sessionId, agencVersion: "0.2.0" });
    const meta = {
      sessionId,
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd,
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    } as const;
    const header = {
      type: "session_meta",
      payload: { ...meta, rolloutSchemaVersion: 0 },
      eventVersion: 0,
    } as const;
    writeFileSync(
      seed.rolloutPath,
      `${JSON.stringify(header)}\n${JSON.stringify({
        type: "response_item",
        payload: { role: "user", content: "trusted canonical content" },
      })}\n`,
      { mode: 0o600 },
    );
    const parked = `${seed.rolloutPath}.parked`;
    const foreign = `${JSON.stringify(header)}\n${JSON.stringify({
      type: "response_item",
      payload: { role: "user", content: "foreign substituted content" },
    })}\n`;
    const resumed = new SessionStore({
      cwd,
      sessionId,
      agencVersion: "0.2.0",
      resume: true,
      resumeRolloutPath: seed.rolloutPath,
      beforeBoundResumeSchemaUpgradeReadForTestingOnly: () => {
        renameSync(seed.rolloutPath, parked);
        writeFileSync(seed.rolloutPath, foreign, { mode: 0o600 });
      },
      afterBoundResumeSchemaUpgradeReadForTestingOnly: () => {
        rmSync(seed.rolloutPath, { force: true });
        renameSync(parked, seed.rolloutPath);
      },
    });
    resumed.open(meta);

    resumed.upgradeCanonicalSchemaHeader(ROLLOUT_SCHEMA_VERSION);
    resumed.close();

    const published = readFileSync(seed.rolloutPath, "utf8");
    expect(published).toContain("trusted canonical content");
    expect(published).not.toContain("foreign substituted content");
    expect(published).toContain(
      `\"rolloutSchemaVersion\":${ROLLOUT_SCHEMA_VERSION}`,
    );
  });

  // OOM regression: the four per-session monotonic indices (offsetsBySeq,
  // toolCallTurnIds, toolResultBytesByTurn, tokenEstimateByTurn) previously grew
  // one entry per event/tool-call for the whole session — the same unbounded
  // growth class as the #946/#947 leaks — bloating both heap and index.json.
  // Drive a 50k+ tool-call soak and assert every index stays capped, both
  // in-memory and in the serialized snapshot.
  test("bounds the per-session monotonic indices under a 50k+ tool-call soak (OOM regression)", () => {
    const store = new SessionStore({
      cwd: "/home/test-index-soak",
      sessionId: "sess-soak",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-soak",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-index-soak",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    // Enough unique completions to cross the cap and force ≥1 eviction cycle.
    // Unique seq + callId + turnId per event so all four indices grow 1/event.
    const total = MAX_SESSION_INDEX_ENTRIES + SESSION_INDEX_EVICT_BATCH + 100;
    for (let i = 0; i < total; i++) {
      store.append(
        {
          id: `evt-${i}`,
          seq: i + 1,
          msg: {
            type: "tool_call_completed",
            payload: { callId: `call-${i}`, result: "ok", isError: false },
          },
        },
        { turnId: `turn-${i}`, toolResultBytes: 1, tokenEstimate: 1 },
      );
    }

    // In-memory (heap) bound: the append-path indices stay capped, the oldest
    // entries are evicted (FIFO), and the newest survive. Before the fix each
    // held all `total` entries.
    const live = store.getCompactionIndexSnapshot();
    expect(live.toolResultBytesByTurn.size).toBeLessThanOrEqual(
      MAX_SESSION_INDEX_ENTRIES,
    );
    expect(live.toolResultBytesByTurn.size).toBeLessThan(total);
    expect(live.tokenEstimateByTurn?.size ?? 0).toBeLessThanOrEqual(
      MAX_SESSION_INDEX_ENTRIES,
    );
    expect(live.toolCallTurnIds.size).toBeLessThanOrEqual(
      MAX_SESSION_INDEX_ENTRIES,
    );
    expect(live.toolCallTurnIds.get("call-0")).toBeUndefined();
    expect(live.toolCallTurnIds.get(`call-${total - 1}`)).toBe(
      `turn-${total - 1}`,
    );

    store.close();

    // Serialized (index.json) bound: the snapshot the audit flagged as bloated
    // by unbounded indices stays capped for all four records, including
    // offsetsBySeq (bounded on the flush path).
    const snapshot = readIndexSnapshot(store.indexPath);
    expect(snapshot).not.toBeNull();
    expect(Object.keys(snapshot!.offsetsBySeq).length).toBeLessThanOrEqual(
      MAX_SESSION_INDEX_ENTRIES,
    );
    expect(
      Object.keys(snapshot!.toolCallTurnIds ?? {}).length,
    ).toBeLessThanOrEqual(MAX_SESSION_INDEX_ENTRIES);
    expect(
      Object.keys(snapshot!.toolResultBytesByTurn ?? {}).length,
    ).toBeLessThanOrEqual(MAX_SESSION_INDEX_ENTRIES);
    expect(
      Object.keys(snapshot!.tokenEstimateByTurn ?? {}).length,
    ).toBeLessThanOrEqual(MAX_SESSION_INDEX_ENTRIES);
  });

  test("Session.emit forwards real tool completion bytes into the rollout index", () => {
    const rolloutStore = new RolloutStore({
      cwd: "/home/test-session-emit",
      sessionId: "sess-emit",
      agencVersion: "0.2.0",
      sessionTempRoot: tmpdir(),
      autoStartScheduler: false,
    });
    rolloutStore.open({
      sessionId: "sess-emit",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-session-emit",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    const session = Object.assign(Object.create(Session.prototype), {
      eventLog: new EventLog(),
      rolloutStore,
      txEvent: new AsyncQueue<any>(),
      isRolloutPersistenceSuspended: () => false,
      nextInternalSubId: (() => {
        let n = 0;
        return () => `sub-${++n}`;
      })(),
    }) as Session;

    session.emit(
      {
        id: "tool-1",
        msg: {
          type: "tool_call_completed",
          payload: { callId: "call-1", result: "tool output", isError: false },
        },
      },
      {
        turnId: "turn-emit",
        toolResultBytes: Buffer.byteLength("tool output", "utf8"),
        tokenEstimate: Math.ceil(Buffer.byteLength("tool output", "utf8") / 4),
      },
    );

    expect(rolloutStore.getToolResultBytes("turn-emit")).toBe(
      Buffer.byteLength("tool output", "utf8"),
    );
    expect(rolloutStore.getTokenEstimate("turn-emit")).toBe(
      Math.ceil(Buffer.byteLength("tool output", "utf8") / 4),
    );
    rolloutStore.close();
  });

  test("Session.emit derives tool completion bytes + active turn id when append opts are omitted", () => {
    const rolloutStore = new RolloutStore({
      cwd: "/home/test-session-derived",
      sessionId: "sess-derived",
      agencVersion: "0.2.0",
      sessionTempRoot: tmpdir(),
      autoStartScheduler: false,
    });
    rolloutStore.open({
      sessionId: "sess-derived",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-session-derived",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    const session = Object.assign(Object.create(Session.prototype), {
      eventLog: new EventLog(),
      rolloutStore,
      txEvent: new AsyncQueue<any>(),
      activeTurn: {
        unsafePeek: () => ({
          turnId: "turn-derived",
          startedAtMs: 123,
          abortController: new AbortController(),
        }),
      },
      isRolloutPersistenceSuspended: () => false,
      nextInternalSubId: (() => {
        let n = 0;
        return () => `sub-${++n}`;
      })(),
    }) as Session;

    session.emit({
      id: "tool-2",
      msg: {
        type: "tool_call_completed",
        payload: { callId: "call-2", result: { ok: true }, isError: false },
      },
    });

    const snapshot = rolloutStore.getCompactionIndexSnapshot();
    expect(snapshot.toolResultBytesByTurn.get("turn-derived")).toBe(
      Buffer.byteLength(JSON.stringify({ ok: true }), "utf8"),
    );
    expect(snapshot.tokenEstimateByTurn?.get("turn-derived")).toBe(
      Math.ceil(Buffer.byteLength(JSON.stringify({ ok: true }), "utf8") / 4),
    );
    expect(snapshot.toolCallTurnIds.get("call-2")).toBe("turn-derived");
    rolloutStore.close();
  });

  test("Session.emit fsyncs durable events before listener and transport publication", () => {
    const order: string[] = [];
    const eventLog = new EventLog();
    eventLog.subscribe(() => order.push("listener"));
    const session = Object.assign(Object.create(Session.prototype), {
      eventLog,
      rolloutStore: {
        append: (_event: unknown, opts: { readonly durable?: boolean }) => {
          expect(opts.durable).toBe(true);
          order.push("fsync");
          return true;
        },
      },
      txEvent: {
        send: () => {
          order.push("tx");
          return true;
        },
      },
      isRolloutPersistenceSuspended: () => false,
    }) as Session;

    const stamped = session.emit({
      id: "effect-intent-id",
      msg: {
        type: "effect_intent",
        payload: {
          runId: "run-1",
          stepId: "tool:turn-1:call-1",
          callId: "call-1",
          toolName: "system.write",
          recoveryCategory: "side-effecting",
          intentDigest: "a".repeat(64),
          attempt: 1,
          recordedAt: "2026-07-18T00:00:00.000Z",
        },
      },
    });

    expect(stamped.seq).toBe(1);
    expect(order).toEqual(["fsync", "listener", "tx"]);
  });

  test("Session.prepareEmit defers publication and publishes exactly once", () => {
    const order: string[] = [];
    const eventLog = new EventLog();
    eventLog.subscribe(() => order.push("listener"));
    const session = Object.assign(Object.create(Session.prototype), {
      eventLog,
      rolloutStore: {
        append: () => {
          order.push("fsync");
          return true;
        },
      },
      txEvent: {
        send: () => {
          order.push("tx");
          return true;
        },
      },
      isRolloutPersistenceSuspended: () => false,
    }) as Session;

    const prepared = session.prepareEmit(
      {
        id: "settings-1",
        msg: {
          type: "warning",
          payload: { cause: "test", message: "prepared" },
        },
      },
      { durable: true },
    );
    expect(order).toEqual(["fsync"]);
    expect(prepared.publish()).toBe(prepared.event);
    expect(prepared.publish()).toBe(prepared.event);
    expect(order).toEqual(["fsync", "listener", "tx"]);
  });

  test("Session.emit does not publish a durable event when fsync fails", () => {
    const rolloutStore = new RolloutStore({
      cwd: "/home/test-session-fsync-failure",
      sessionId: "sess-fsync-failure",
      agencVersion: "0.2.0",
      sessionTempRoot: tmpdir(),
      autoStartScheduler: false,
    });
    rolloutStore.open({
      sessionId: "sess-fsync-failure",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-session-fsync-failure",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    rolloutStore.store.setFsyncImplForTest(() => {
      throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
    });
    const published: string[] = [];
    const eventLog = new EventLog();
    eventLog.subscribe(() => published.push("listener"));
    const session = Object.assign(Object.create(Session.prototype), {
      eventLog,
      rolloutStore,
      txEvent: {
        send: () => {
          published.push("tx");
          return true;
        },
      },
      isRolloutPersistenceSuspended: () => false,
    }) as Session;

    expect(() =>
      session.emit({
        id: "effect-result-id",
        msg: {
          type: "effect_result",
          payload: {
            runId: "run-1",
            stepId: "tool:turn-1:call-1",
            callId: "call-1",
            toolName: "system.write",
            recoveryCategory: "side-effecting",
            intentEventSeq: 1,
            outcome: "committed",
            recordedAt: "2026-07-18T00:00:00.000Z",
          },
        },
      }),
    ).toThrow(/was not fsync-committed/);
    expect(published).toEqual([]);

    // Let the scheduled retry/close path use the real fsync implementation.
    rolloutStore.store.setFsyncImplForTest(fsyncSync);
    rolloutStore.close();
  });

  test("durable rollout writes loop until every byte is appended", () => {
    const store = new SessionStore({
      cwd: "/home/test-short-write",
      sessionId: "sess-short-write",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-short-write",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-short-write",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    let writes = 0;
    store.setWriteImplForTest((fd, buffer, offset, length) => {
      writes += 1;
      return writeSync(fd, buffer, offset, Math.min(length, 7));
    });
    store.append(
      {
        id: "short-write-event",
        seq: 1,
        msg: {
          type: "warning",
          payload: { cause: "short_write", message: "fully committed" },
        },
      },
      { durable: true },
    );
    store.close();

    expect(writes).toBeGreaterThan(1);
    expect(() => {
      for (const line of readFileSync(store.rolloutPath, "utf8")
        .trimEnd()
        .split("\n")) {
        JSON.parse(line);
      }
    }).not.toThrow();
    expect(readFileSync(store.rolloutPath, "utf8")).toContain(
      '"id":"short-write-event"',
    );
  });

  test("rolls back a partial append before degraded requeue", () => {
    const store = new SessionStore({
      cwd: "/home/test-interrupted-short-write",
      sessionId: "sess-interrupted-short-write",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-interrupted-short-write",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-interrupted-short-write",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    const committedPrefix = readFileSync(store.rolloutPath, "utf8");
    let writes = 0;
    store.setWriteImplForTest((fd, buffer, offset, length) => {
      writes += 1;
      if (writes === 1) {
        return writeSync(fd, buffer, offset, Math.min(length, 7));
      }
      throw Object.assign(new Error("injected interrupted write"), {
        code: "EIO",
      });
    });

    expect(
      store.append(
        {
          id: "interrupted-short-write-event",
          seq: 1,
          msg: {
            type: "warning",
            payload: { cause: "short_write", message: "must not leave a tail" },
          },
        },
        { durable: true },
      ),
    ).toBe(false);
    expect(readFileSync(store.rolloutPath, "utf8")).toBe(committedPrefix);

    store.setWriteImplForTest((fd, buffer, offset, length) =>
      writeSync(fd, buffer, offset, length),
    );
    store.close();
  });

  test("durable non-event append and explicit rollout flush propagate fsync failure", () => {
    const rollout = new RolloutStore({
      cwd: "/home/test-rollout-flush-failure",
      sessionId: "sess-rollout-flush-failure",
      agencVersion: "0.2.0",
      sessionTempRoot: tmpdir(),
      autoStartScheduler: false,
    });
    rollout.open({
      sessionId: "sess-rollout-flush-failure",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-rollout-flush-failure",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    const failFsync = () => {
      throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
    };
    rollout.store.setFsyncImplForTest(failFsync);
    expect(() =>
      rollout.appendRollout(
        {
          type: "response_item",
          payload: { role: "user", content: "durable" },
        },
        { durable: true },
      ),
    ).toThrow(/not fsync-committed/);

    rollout.store.setFsyncImplForTest(fsyncSync);
    rollout.appendRollout({
      type: "response_item",
      payload: { role: "user", content: "queued" },
    });
    rollout.store.setFsyncImplForTest(failFsync);
    expect(() => rollout.flushDurable()).toThrow(/not fsync-committed/);

    rollout.store.setFsyncImplForTest(fsyncSync);
    rollout.close();
  });

  test("explicit canonical-tail sync fsyncs an empty pending batch and propagates failure", () => {
    const rollout = new RolloutStore({
      cwd: "/home/test-explicit-tail-sync",
      sessionId: "sess-explicit-tail-sync",
      agencVersion: "0.2.0",
      sessionTempRoot: tmpdir(),
      autoStartScheduler: false,
    });
    rollout.open({
      sessionId: "sess-explicit-tail-sync",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-explicit-tail-sync",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    let syncs = 0;
    rollout.store.setFsyncImplForTest(() => {
      syncs += 1;
      throw Object.assign(new Error("injected explicit sync failure"), {
        code: "EIO",
      });
    });

    // The legacy flush API has no bytes to write and therefore no fsync proof.
    expect(rollout.store.flushBatch(true)).toBe(true);
    expect(syncs).toBe(0);
    expect(() => rollout.syncCanonicalTail()).toThrow(
      /injected explicit sync failure/,
    );
    expect(syncs).toBe(1);

    rollout.store.setFsyncImplForTest(fsyncSync);
    expect(() => rollout.syncCanonicalTail()).not.toThrow();
    rollout.close();
  });

  test("resume refuses recovery evidence when the surviving tail cannot be fsynced", () => {
    const original = new SessionStore({
      cwd: "/home/test-resume-tail-sync",
      sessionId: "sess-resume-tail-sync",
      agencVersion: "0.2.0",
    });
    const meta = {
      sessionId: "sess-resume-tail-sync",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-resume-tail-sync",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    } as const;
    original.open(meta);
    original.close();

    const resumed = new SessionStore({
      cwd: "/home/test-resume-tail-sync",
      sessionId: "sess-resume-tail-sync",
      agencVersion: "0.2.0",
      resume: true,
    });
    resumed.setFsyncImplForTest(() => {
      throw Object.assign(new Error("injected resume sync failure"), {
        code: "EIO",
      });
    });
    expect(() => resumed.open(meta)).toThrow(/injected resume sync failure/);
    expect(existsSync(resumed.lockPath)).toBe(false);
    resumed.close();
  });

  test("UUID dedup: repeated event.id without seq is skipped", () => {
    const store = new SessionStore({
      cwd: "/home/test-dedup",
      sessionId: "sess-d",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-d",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-dedup",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    const ev = {
      id: "dup-id",
      msg: { type: "warning" as const, payload: { cause: "x", message: "y" } },
    };
    store.append(ev);
    store.append(ev);
    store.append(ev);
    store.close();
    const content = readFileSync(store.rolloutPath, "utf8");
    const matches = content.match(/"dup-id"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test("fails closed on a repeated sequenced event", () => {
    const store = new SessionStore({
      cwd: "/home/test-sequence-conflict",
      sessionId: "sess-sequence-conflict",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-sequence-conflict",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-sequence-conflict",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    store.append(
      {
        id: "first",
        seq: 1,
        msg: {
          type: "warning",
          payload: { cause: "first", message: "one" },
        },
      },
      { durable: true },
    );

    expect(() =>
      store.append(
        {
          id: "conflict",
          seq: 1,
          msg: {
            type: "warning",
            payload: { cause: "conflict", message: "different" },
          },
        },
        { durable: true },
      ),
    ).toThrow(/non-monotonic rollout event sequence 1/);
    store.close();

    const content = readFileSync(store.rolloutPath, "utf8");
    expect(content).toContain('"id":"first"');
    expect(content).not.toContain('"id":"conflict"');
  });

  test("I-24 close writes atomic index.json snapshot with seq + offsets", () => {
    const store = new SessionStore({
      cwd: "/home/test-idx",
      sessionId: "sess-e",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-e",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-idx",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    store.append({
      id: "1",
      seq: 1,
      msg: { type: "warning", payload: { cause: "x", message: "y" } },
    });
    store.append(
      {
        id: "2",
        seq: 2,
        msg: { type: "turn_complete", payload: { turnId: "t" } },
      },
      { durable: true },
    );
    store.close();
    const snapshot = readIndexSnapshot(store.indexPath);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.snapshotSequenceNumber).toBe(2);
    expect(snapshot!.schemaVersion).toBe(ROLLOUT_SCHEMA_VERSION);
    expect(Object.keys(snapshot!.offsetsBySeq)).toContain("1");
    expect(Object.keys(snapshot!.offsetsBySeq)).toContain("2");
    expect(snapshot!.tokenEstimateByTurn ?? {}).toEqual({});
  });

  test("resume hydrates the compaction index snapshot from disk", () => {
    const first = new SessionStore({
      cwd: "/home/test-idx-resume",
      sessionId: "sess-resume",
      agencVersion: "0.2.0",
    });
    first.open({
      sessionId: "sess-resume",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-idx-resume",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    first.append(
      {
        id: "tool-complete",
        seq: 2,
        msg: {
          type: "tool_call_completed",
          payload: { callId: "call-resume", result: "payload", isError: false },
        },
      },
      {
        turnId: "turn-resume",
        toolResultBytes: Buffer.byteLength("payload", "utf8"),
        tokenEstimate: Math.ceil(Buffer.byteLength("payload", "utf8") / 4),
      },
    );
    first.close();

    const resumed = new SessionStore({
      cwd: "/home/test-idx-resume",
      sessionId: "sess-resume",
      agencVersion: "0.2.0",
      resume: true,
    });
    resumed.open({
      sessionId: "sess-resume",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-idx-resume",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    const snapshot = resumed.getCompactionIndexSnapshot();
    expect(snapshot.toolResultBytesByTurn.get("turn-resume")).toBe(
      Buffer.byteLength("payload", "utf8"),
    );
    expect(snapshot.tokenEstimateByTurn?.get("turn-resume")).toBe(
      Math.ceil(Buffer.byteLength("payload", "utf8") / 4),
    );
    expect(snapshot.toolCallTurnIds.get("call-resume")).toBe("turn-resume");
    resumed.close();
    expect(readIndexSnapshot(resumed.indexPath)?.snapshotSequenceNumber).toBe(
      2,
    );
  });

  test("reAppendSessionMetadata writes session_meta line again after compact", () => {
    const store = new SessionStore({
      cwd: "/home/test-meta",
      sessionId: "sess-f",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-f",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-meta",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });
    store.reAppendSessionMetadata();
    store.close();
    const content = readFileSync(store.rolloutPath, "utf8");
    const metaCount = (content.match(/"type":"session_meta"/g) ?? []).length;
    expect(metaCount).toBeGreaterThanOrEqual(2);
  });

  test("I-38 fsync retry: first attempt fails, async retry succeeds without busy-wait", async () => {
    const store = new SessionStore({
      cwd: "/home/test-fsync-retry-ok",
      sessionId: "sess-fsync-ok",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-fsync-ok",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-fsync-retry-ok",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    const diagnostics: Array<{ cause: string; level: string }> = [];
    store.setDiagnosticListener((d) => {
      diagnostics.push({ cause: d.cause, level: d.level });
    });

    // Fail the next fsync call exactly once, then let the real impl run.
    let callsSeen = 0;
    store.setFsyncImplForTest((fd: number) => {
      callsSeen += 1;
      if (callsSeen === 1) {
        const err = new Error(
          "simulated transient fsync failure",
        ) as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return fsyncSync(fd);
    });

    try {
      const start = Date.now();
      store.append(
        {
          id: "durable-1",
          seq: 1,
          msg: { type: "turn_complete", payload: { turnId: "t1" } },
        },
        { durable: true },
      );
      const syncElapsed = Date.now() - start;

      // Assert no busy-wait: the sync append path must return quickly
      // (well under the 100ms I-38 retry window).
      expect(syncElapsed).toBeLessThan(I4_FSYNC_RETRY_MS);

      // Wait for the deferred async retry to settle.
      await (
        store as unknown as {
          awaitPendingFsyncRetries(): Promise<void>;
        }
      ).awaitPendingFsyncRetries();

      expect(callsSeen).toBeGreaterThanOrEqual(2);
      expect(diagnostics.some((d) => d.cause === "fsync_retry_succeeded")).toBe(
        true,
      );
      expect(diagnostics.some((d) => d.cause === "fsync_failed")).toBe(false);
      expect(store.isDegraded).toBe(false);
    } finally {
      store.setFsyncImplForTest(fsyncSync);
      store.close();
    }
  });

  test("appendRollout inherits durable flushing for terminal event_msg rows", () => {
    const store = new SessionStore({
      cwd: "/home/test-rollout-durable-terminal",
      sessionId: "sess-rollout-durable-terminal",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-rollout-durable-terminal",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-rollout-durable-terminal",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    store.appendRollout({
      type: "event_msg",
      payload: {
        id: "terminal-rollout-event",
        msg: {
          type: "turn_aborted",
          payload: { turnId: "turn-rollout", reason: "process_killed" },
        },
      },
    });

    const lines = readFileSync(store.rolloutPath, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            payload?: { msg?: { type?: string } };
          },
      );
    expect(
      lines.some(
        (line) =>
          line.type === "event_msg" &&
          line.payload?.msg?.type === "turn_aborted",
      ),
    ).toBe(true);
    store.close();
  });

  test("opt-in trajectory export mirrors redacted rollout rows", () => {
    const previousExportPath = process.env[AGENC_TRAJECTORY_EXPORT_PATH_ENV];
    const exportPath = join(home, "trajectory.jsonl");
    process.env[AGENC_TRAJECTORY_EXPORT_PATH_ENV] = exportPath;
    const store = new SessionStore({
      cwd: "/home/test-trajectory-export",
      sessionId: "sess-trajectory-export",
      agencVersion: "0.2.0",
    });
    const rawSecret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456-";

    try {
      store.open({
        sessionId: "sess-trajectory-export",
        timestamp: new Date().toISOString(),
        cwd: "/home/test-trajectory-export",
        originator: "agenc-cli",
        agencVersion: "0.2.0",
      });

      store.appendRollout(
        {
          type: "response_item",
          payload: {
            role: "user",
            content: `Authorization: Bearer abcdefghijklmnop= ${rawSecret}`,
          },
        },
        { durable: true },
      );
      store.close();

      const raw = readFileSync(exportPath, "utf8");
      expect(raw).not.toContain(rawSecret);
      const records = raw
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              schemaVersion: number;
              sessionId: string;
              rolloutPath: string;
              item: { type: string; payload?: unknown };
            },
        );
      expect(records.map((record) => record.schemaVersion)).toEqual([
        TRAJECTORY_EXPORT_SCHEMA_VERSION,
        TRAJECTORY_EXPORT_SCHEMA_VERSION,
      ]);
      expect(records.map((record) => record.item.type)).toEqual([
        "session_meta",
        "response_item",
      ]);
      expect(
        records.every(
          (record) => record.sessionId === "sess-trajectory-export",
        ),
      ).toBe(true);
      expect(
        records.every((record) => record.rolloutPath === store.rolloutPath),
      ).toBe(true);
    } finally {
      store.close();
      if (previousExportPath === undefined) {
        delete process.env[AGENC_TRAJECTORY_EXPORT_PATH_ENV];
      } else {
        process.env[AGENC_TRAJECTORY_EXPORT_PATH_ENV] = previousExportPath;
      }
    }
  });

  test("I-38 fsync retry: both attempts fail — emits fsync_failed + routes to degraded", async () => {
    const store = new SessionStore({
      cwd: "/home/test-fsync-retry-fail",
      sessionId: "sess-fsync-fail",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-fsync-fail",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-fsync-retry-fail",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    const diagnostics: Array<{ cause: string; level: string }> = [];
    store.setDiagnosticListener((d) => {
      diagnostics.push({ cause: d.cause, level: d.level });
    });

    // Fail every fsync on the rollout path — first attempt and
    // deferred retry must both trip the mock.
    store.setFsyncImplForTest(() => {
      const err = new Error(
        "simulated persistent fsync failure",
      ) as NodeJS.ErrnoException;
      err.code = "EIO";
      throw err;
    });

    try {
      store.append(
        {
          id: "durable-2",
          seq: 1,
          msg: { type: "turn_complete", payload: { turnId: "t2" } },
        },
        { durable: true },
      );

      // Wait for the deferred async retry to run + fail.
      await (
        store as unknown as {
          awaitPendingFsyncRetries(): Promise<void>;
        }
      ).awaitPendingFsyncRetries();

      const fsyncFailed = diagnostics.find((d) => d.cause === "fsync_failed");
      expect(fsyncFailed).toBeDefined();
      expect(fsyncFailed?.level).toBe("error");

      // Retry failure must have routed the batch into the degraded
      // ring buffer (I-12 / I-38).
      expect(store.isDegraded).toBe(true);
      expect(diagnostics.some((d) => d.cause === "rollout_degraded")).toBe(
        true,
      );
    } finally {
      // Restore so the close() path + index-snapshot fsync run the
      // real impl and don't trip the mock.
      store.setFsyncImplForTest(fsyncSync);
      store.close();
    }
  });

  test("#11 durable fsync-failure does not duplicate the row after degraded flush", async () => {
    const store = new SessionStore({
      cwd: "/home/test-fsync-dup",
      sessionId: "sess-fsync-dup",
      agencVersion: "0.2.0",
    });
    store.open({
      sessionId: "sess-fsync-dup",
      timestamp: new Date().toISOString(),
      cwd: "/home/test-fsync-dup",
      originator: "agenc-cli",
      agencVersion: "0.2.0",
    });

    try {
      // Fail every fsync so the durable append's writeSync lands the row
      // on disk but both the initial fsync and the I-38 retry trip.
      store.setFsyncImplForTest(() => {
        const err = new Error(
          "simulated persistent fsync failure",
        ) as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      });

      store.append(
        {
          id: "durable-once",
          seq: 1,
          msg: { type: "turn_complete", payload: { turnId: "t-once" } },
        },
        { durable: true },
      );

      await (
        store as unknown as {
          awaitPendingFsyncRetries(): Promise<void>;
        }
      ).awaitPendingFsyncRetries();

      // writeSync persisted the row even though fsync failed; we entered
      // degraded mode.
      expect(store.isDegraded).toBe(true);

      const countOccurrences = () =>
        readFileSync(store.rolloutPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { payload?: { id?: string } })
          .filter((line) => line.payload?.id === "durable-once").length;

      // Already exactly once on disk (the original writeSync).
      expect(countOccurrences()).toBe(1);

      // Restore fsync and drive the degraded flush. The pre-fix bug
      // re-queued the already-written row into the degraded buffer, so
      // this flush re-appended it — producing two copies on disk (and a
      // double on resume/reduce). With the fix the degraded buffer is
      // empty, so the flush is a no-op and the row stays exactly once.
      store.setFsyncImplForTest(fsyncSync);
      await (
        store as unknown as {
          degraded: { tryFlush(): Promise<boolean> };
        }
      ).degraded.tryFlush();

      expect(countOccurrences()).toBe(1);
    } finally {
      store.setFsyncImplForTest(fsyncSync);
      store.close();
    }
  });

  test("I-24 truncateCorruptTail removes partial trailing line", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-corrupt-"));
    try {
      const path = join(dir, "rollout.jsonl");
      writeFileSync(
        path,
        '{"type":"session_meta","payload":{"sessionId":"x"}}\n{"type":"event_msg","payload":{"id":"1","msg":{"type":"warning"',
        { mode: 0o600 },
      );
      const result = truncateCorruptTail(path);
      expect(result.truncated).toBe(true);
      const content = readFileSync(path, "utf8");
      expect(content.endsWith("\n")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("I-24 truncateCorruptTail fails closed when truncate or fsync repair fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-corrupt-repair-failure-"));
    try {
      const path = join(dir, "rollout.jsonl");
      const partial =
        '{"type":"session_meta","payload":{}}\n{"type":"event_msg"';
      writeFileSync(path, partial, { mode: 0o600 });
      const truncateFailure = new Error("injected truncate failure");
      expect(() =>
        truncateCorruptTail(path, {
          truncate: () => {
            throw truncateFailure;
          },
        }),
      ).toThrow(truncateFailure);

      writeFileSync(path, partial, { mode: 0o600 });
      const syncFailure = new Error("injected repair fsync failure");
      expect(() =>
        truncateCorruptTail(path, {
          sync: () => {
            throw syncFailure;
          },
        }),
      ).toThrow(syncFailure);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // T10 Fix-E integration point 5 — project-root slug uses ancestor
  // walk so two checkouts nested under the same `.git` root share the
  // same `~/.agenc/projects/<slug>/` directory.
  // ───────────────────────────────────────────────────────────────────

  test("getProjectDir slugs from .git ancestor when cwd is nested under it", () => {
    const repo = mkdtempSync(join(tmpdir(), "agenc-proj-root-"));
    try {
      mkdirSync(join(repo, ".git"));
      const nested = join(repo, "packages", "alpha", "src");
      mkdirSync(nested, { recursive: true });

      const dirFromNested = getProjectDir(nested);
      const dirFromRepo = getProjectDir(repo);
      // Both should resolve to the same slug because the ancestor
      // walk finds the `.git` marker at `repo`.
      expect(dirFromNested).toBe(dirFromRepo);
      expect(dirFromNested).toContain(slugifyCwd(repo));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("getProjectDir falls back to raw cwd when no marker ancestor exists", () => {
    // Build an isolated subtree under the test HOME so we guarantee
    // no .git/package.json/etc exists anywhere on the way up. Using
    // the test `home` (AGENC_HOME) keeps the walk contained to this
    // temp tree; tmpdir() itself may be inside a repo on developer
    // machines.
    const walled = mkdtempSync(join(home, "no-marker-"));
    try {
      const dir = getProjectDir(walled, ["agenc-no-such-marker-xyzzy"]);
      // With a custom marker list that cannot match, the store must
      // slug from the raw cwd (not a non-existent ancestor).
      expect(dir).toContain(slugifyCwd(walled));
    } finally {
      rmSync(walled, { recursive: true, force: true });
    }
  });

  test("two cwds under the same .git root slug to the same project dir", () => {
    const repo = mkdtempSync(join(tmpdir(), "agenc-shared-root-"));
    try {
      mkdirSync(join(repo, ".git"));
      const a = join(repo, "apps", "web");
      const b = join(repo, "apps", "api", "src");
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });

      const dirA = getProjectDir(a);
      const dirB = getProjectDir(b);
      expect(dirA).toBe(dirB);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("findProjectRootSync locates .git ancestor and returns rootDir + marker", () => {
    const repo = mkdtempSync(join(tmpdir(), "agenc-walk-"));
    try {
      mkdirSync(join(repo, ".git"));
      const nested = join(repo, "a", "b", "c");
      mkdirSync(nested, { recursive: true });
      const root = findProjectRootSync(nested);
      expect(root).not.toBeNull();
      expect(root!.rootDir).toBe(repo);
      expect(root!.marker).toBe(".git");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("DEFAULT_SESSION_ROOT_MARKERS covers common ecosystem roots", () => {
    // Guards against accidental drift between this list and the
    // project-instructions loader; a full equality check would couple
    // the two, so just assert coverage of the agenc runtime-rooted minimum.
    expect(DEFAULT_SESSION_ROOT_MARKERS).toContain(".git");
    expect(DEFAULT_SESSION_ROOT_MARKERS).toContain("package.json");
  });
});
