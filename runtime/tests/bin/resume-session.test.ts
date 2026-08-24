import {
  closeSync,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SESSION_ROOT_MARKERS,
  getProjectDir,
  isSafeSessionIdSegment,
} from "../session/session-store.js";
import { sanitizePath } from "../utils/sessionStoragePortable.js";
import {
  __setResumeSessionTestHooksForTest,
  resolveLatestSessionId as resolveLatestSessionIdWithHome,
  resolveResumeSessionId as resolveResumeSessionIdWithHome,
} from "./resume-session.js";

let workHome: string;
let agencHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "agenc-resume-cli-"));
  agencHome = join(workHome, ".agenc");
});

afterEach(() => {
  __setResumeSessionTestHooksForTest();
  rmSync(workHome, { recursive: true, force: true });
});

function resolveLatestSessionId(cwd: string) {
  return resolveLatestSessionIdWithHome(cwd, agencHome);
}

function resolveResumeSessionId(cwd: string, input: string) {
  return resolveResumeSessionIdWithHome(cwd, input, agencHome);
}

function projectDir(cwd: string): string {
  return getProjectDir(cwd, DEFAULT_SESSION_ROOT_MARKERS, agencHome);
}

/**
 * Write the JSONL header that `listResumableSessions` requires to surface
 * a rollout from disk: a session_meta line plus at least one user
 * message (the picker filters out rollouts that never recorded one).
 */
function rolloutContent(sessionId: string, cwd: string): string {
  return (
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd,
        originator: "agenc-cli",
        agencVersion: "0.16.1",
        rolloutSchemaVersion: 3,
      },
    })}\n` +
    `${JSON.stringify({
      type: "response_item",
      payload: { role: "user", content: `seed for ${sessionId}` },
    })}\n`
  );
}

function writeRolloutAtSlug(
  slug: string,
  sessionId: string,
  iso: string,
  mtimeSec: number,
  cwd: string,
): string {
  const sessionDir = join(
    agencHome,
    "projects",
    slug,
    "sessions",
    sessionId,
  );
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, `rollout-${iso}-${sessionId}.jsonl`);
  writeFileSync(file, rolloutContent(sessionId, cwd));
  utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

/** Write under the canonical (hashed) project slug. */
function writeRollout(
  cwd: string,
  sessionId: string,
  iso: string,
  mtimeSec: number,
): string {
  const slug = projectDir(cwd).split("/").pop()!;
  return writeRolloutAtSlug(slug, sessionId, iso, mtimeSec, cwd);
}

/**
 * Write under the LEGACY project-slug layout
 * (`~/.agenc/projects/<sanitizePath(cwd)>/sessions/<id>/rollout-*.jsonl`).
 * Bypasses `getProjectDir` to emulate older directories written by tools
 * that use `sanitizePath` rather than `slugifyCwd`.
 */
function writeLegacyRollout(
  cwd: string,
  sessionId: string,
  iso: string,
  mtimeSec: number,
): string {
  return writeRolloutAtSlug(sanitizePath(cwd), sessionId, iso, mtimeSec, cwd);
}

describe("resume-session CLI lookup", () => {
  it("resolves the newest project session for --continue", () => {
    writeRollout(workHome, "sess-older", "2026-01-01T10-00-00-000Z", 1);
    const rolloutPath = writeRollout(
      workHome,
      "sess-newer",
      "2026-01-02T10-00-00-000Z",
      2,
    );

    const resolved = resolveLatestSessionId(workHome);
    expect(resolved).toMatchObject({
      kind: "ok",
      sessionId: "sess-newer",
      rolloutPath,
      cwd: workHome,
    });
    if (resolved.kind === "ok") {
      expect(resolved.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(BigInt(resolved.sourceDev)).toBeGreaterThan(0n);
      expect(BigInt(resolved.sourceIno)).toBeGreaterThan(0n);
      expect(BigInt(resolved.sourceSize)).toBeGreaterThan(0n);
      expect(BigInt(resolved.cwdDev)).toBeGreaterThan(0n);
      expect(BigInt(resolved.cwdIno)).toBeGreaterThan(0n);
    }
  });

  it("resolves exact and unique-prefix session ids", () => {
    const rolloutPath = writeRollout(
      workHome,
      "conv-abcdef",
      "2026-01-01T10-00-00-000Z",
      1,
    );

    expect(resolveResumeSessionId(workHome, "conv-abcdef")).toMatchObject({
      kind: "ok",
      sessionId: "conv-abcdef",
      rolloutPath,
      cwd: workHome,
    });
    expect(resolveResumeSessionId(workHome, "conv-abc")).toMatchObject({
      kind: "ok",
      sessionId: "conv-abcdef",
      rolloutPath,
      cwd: workHome,
    });
  });

  it("orders rollout generations by nanoseconds within one millisecond", () => {
    const sessionId = "conv-nanosecond1";
    const older = writeRollout(
      workHome,
      sessionId,
      "2026-01-02T10-00-00-000Z",
      1_700_000_000.0001,
    );
    const newer = writeRollout(
      workHome,
      sessionId,
      "2026-01-01T10-00-00-000Z",
      1_700_000_000.0009,
    );
    const olderTime = lstatSync(older, { bigint: true }).mtimeNs;
    const newerTime = lstatSync(newer, { bigint: true }).mtimeNs;
    expect(olderTime / 1_000_000n).toBe(newerTime / 1_000_000n);
    expect(newerTime).toBeGreaterThan(olderTime);

    expect(resolveResumeSessionId(workHome, sessionId)).toMatchObject({
      kind: "ok",
      sessionId,
      rolloutPath: newer,
    });
  });

  it("uses recovery rollouts only when no normal generation exists", () => {
    const sessionId = "conv-recoveryfallback1";
    const normal = writeRollout(
      workHome,
      sessionId,
      "2026-01-01T10-00-00-000Z",
      10,
    );
    const recovery = join(
      normal,
      "..",
      `rollout-recovery-test-${sessionId}.jsonl`,
    );
    copyFileSync(normal, recovery);
    utimesSync(normal, 10, 10);
    utimesSync(recovery, 10, 10);

    expect(resolveResumeSessionId(workHome, sessionId)).toMatchObject({
      kind: "ok",
      rolloutPath: normal,
    });

    rmSync(normal);
    expect(resolveResumeSessionId(workHome, sessionId)).toMatchObject({
      kind: "ok",
      rolloutPath: recovery,
    });
  });

  it("rejects ambiguous prefixes", () => {
    writeRollout(workHome, "conv-abc111", "2026-01-01T10-00-00-000Z", 1);
    writeRollout(workHome, "conv-abc222", "2026-01-02T10-00-00-000Z", 2);

    const result = resolveResumeSessionId(workHome, "conv-abc");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.input).toBe("conv-abc");
      expect([...result.matches].sort()).toEqual([
        "conv-abc111",
        "conv-abc222",
      ]);
    }
  });

  it("returns none when the project has no sessions", () => {
    expect(resolveLatestSessionId(workHome)).toEqual({ kind: "none" });
  });

  it("walks the legacy project-slug layout when the hashed slug has no match", () => {
    const rolloutPath = writeLegacyRollout(
      workHome,
      "conv-legacy01",
      "2026-01-01T10-00-00-000Z",
      1,
    );

    expect(resolveResumeSessionId(workHome, "conv-legacy01")).toMatchObject({
      kind: "ok",
      sessionId: "conv-legacy01",
      rolloutPath,
      cwd: workHome,
    });
  });

  it("returns canonical rollout paths when AGENC_HOME is a lexical alias", () => {
    const canonicalHome = join(workHome, "canonical-home");
    const lexicalHome = join(workHome, "lexical-home");
    mkdirSync(canonicalHome, { recursive: true });
    symlinkSync(canonicalHome, lexicalHome, "dir");
    agencHome = lexicalHome;
    const rolloutPath = writeRollout(
      workHome,
      "conv-homealias1",
      "2026-01-01T10-00-00-000Z",
      1,
    );
    const canonicalRolloutPath = realpathSync(rolloutPath);

    expect(resolveLatestSessionId(workHome)).toMatchObject({
      kind: "ok",
      sessionId: "conv-homealias1",
      rolloutPath: canonicalRolloutPath,
    });
    expect(resolveResumeSessionId(workHome, "conv-homealias1")).toMatchObject({
      kind: "ok",
      sessionId: "conv-homealias1",
      rolloutPath: canonicalRolloutPath,
    });
  });

  it("fails ambiguous when divergent copies share an id across slug layouts", () => {
    const canonicalPath = writeRollout(
      workHome,
      "conv-shared01",
      "2026-01-02T10-00-00-000Z",
      2,
    );
    const legacyPath = writeLegacyRollout(
      workHome,
      "conv-shared01",
      "2026-01-01T10-00-00-000Z",
      1,
    );

    expect(resolveResumeSessionId(workHome, "conv-shared01")).toEqual({
      kind: "ambiguous",
      input: "conv-shared01",
      matches: [
        `conv-shared01 @ ${canonicalPath}`,
        `conv-shared01 @ ${legacyPath}`,
      ],
    });
  });

  it("finds a conv-id globally when neither local layout matches", () => {
    // Write a rollout under an unrelated project slug - neither the
    // canonical nor legacy slug for `workHome` will contain it.
    const foreignProject = join(workHome, "some-other-checkout");
    mkdirSync(foreignProject, { recursive: true });
    const rolloutPath = writeRolloutAtSlug(
      sanitizePath(foreignProject),
      "conv-foreign01",
      "2026-01-01T10-00-00-000Z",
      1,
      foreignProject,
    );

    expect(resolveResumeSessionId(workHome, "conv-foreign01")).toMatchObject({
      kind: "ok",
      sessionId: "conv-foreign01",
      rolloutPath,
      cwd: foreignProject,
    });
  });

  it("returns not_found when neither layout nor global walk finds the id", () => {
    writeRollout(workHome, "conv-existing", "2026-01-01T10-00-00-000Z", 1);

    expect(resolveResumeSessionId(workHome, "conv-missing01")).toEqual({
      kind: "not_found",
      input: "conv-missing01",
    });
  });

  it("rejects traversal and Windows device-alias session ids", () => {
    for (const unsafe of [
      "../conv-safe",
      "conv/safe",
      "conv-safe.",
      "CON",
      "nul.jsonl",
      "Com1.txt",
      "LPT9.log",
    ]) {
      expect(isSafeSessionIdSegment(unsafe)).toBe(false);
      expect(resolveResumeSessionId(workHome, unsafe)).toEqual({
        kind: "not_found",
        input: unsafe,
      });
    }
    expect(isSafeSessionIdSegment(`a${"b".repeat(254)}`)).toBe(true);
    expect(isSafeSessionIdSegment(`a${"b".repeat(255)}`)).toBe(false);
  });

  it("fails closed when a session directory exceeds the file budget", () => {
    const sessionId = "conv-overlimit1";
    const sessionDir = join(projectDir(workHome), "sessions", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    for (let index = 0; index < 257; index += 1) {
      writeFileSync(join(sessionDir, `entry-${index}.tmp`), "");
    }

    expect(resolveResumeSessionId(workHome, sessionId)).toEqual({
      kind: "search_incomplete",
      input: sessionId,
      reason: "file_limit",
    });
  });

  it("canonicalizes a legacy symlink-spelled rollout cwd", () => {
    const realCwd = join(workHome, "real-target");
    const linkedCwd = join(workHome, "linked-target");
    mkdirSync(realCwd, { recursive: true });
    symlinkSync(realCwd, linkedCwd, "dir");
    writeRolloutAtSlug(
      projectDir(workHome).split("/").pop()!,
      "conv-symlinkcwd1",
      "2026-01-01T10-00-00-000Z",
      1,
      linkedCwd,
    );

    expect(resolveResumeSessionId(workHome, "conv-symlinkcwd1")).toMatchObject({
      kind: "ok",
      sessionId: "conv-symlinkcwd1",
      cwd: realpathSync(realCwd),
    });
  });

  it.each(["metadata", "hash"] as const)(
    "rejects a same-size source mutation during candidate %s proof",
    (stage) => {
      const sessionId = `conv-${stage}race1`;
      const rolloutPath = writeRollout(
        workHome,
        sessionId,
        "2026-01-01T10-00-00-000Z",
        1,
      );
      let mutated = false;
      const mutate = () => {
        if (mutated) return;
        mutated = true;
        const bytes = readFileSync(rolloutPath);
        const needle = Buffer.from(stage === "metadata" ? "agenc-cli" : "seed");
        const offset = bytes.indexOf(needle);
        expect(offset).toBeGreaterThanOrEqual(0);
        const fd = openSync(rolloutPath, "r+");
        try {
          const replacement = Buffer.from(
            stage === "metadata" ? "Agenc-cli" : "Seed",
          );
          writeSync(fd, replacement, 0, replacement.byteLength, offset);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      };
      __setResumeSessionTestHooksForTest(
        stage === "metadata"
          ? { afterCandidateMetadataRead: mutate }
          : { afterCandidateHashRead: mutate },
      );

      expect(resolveResumeSessionId(workHome, sessionId)).toEqual({
        kind: "search_incomplete",
        input: sessionId,
        reason: "source_unavailable",
      });
      expect(mutated).toBe(true);
    },
  );

  it("fails closed when one global same-id source becomes unreadable", () => {
    const sessionId = "conv-globalfault1";
    const firstProject = join(workHome, "foreign-one");
    const secondProject = join(workHome, "foreign-two");
    mkdirSync(firstProject, { recursive: true });
    mkdirSync(secondProject, { recursive: true });
    writeRolloutAtSlug(
      sanitizePath(firstProject),
      sessionId,
      "2026-01-01T10-00-00-000Z",
      1,
      firstProject,
    );
    const hiddenPath = writeRolloutAtSlug(
      sanitizePath(secondProject),
      sessionId,
      "2026-01-02T10-00-00-000Z",
      2,
      secondProject,
    );
    const hiddenSessionDir = realpathSync(join(hiddenPath, ".."));
    __setResumeSessionTestHooksForTest({
      beforeOpenDirectory: (path) => {
        if (path !== hiddenSessionDir) return;
        throw Object.assign(new Error("injected directory I/O failure"), {
          code: "EIO",
        });
      },
    });

    expect(resolveResumeSessionId(workHome, sessionId)).toEqual({
      kind: "search_incomplete",
      input: sessionId,
      reason: "source_unavailable",
    });
  });

  it("fails closed when the sealed candidate descriptor cannot be closed", () => {
    const sessionId = "conv-closefault1";
    writeRollout(workHome, sessionId, "2026-01-01T10-00-00-000Z", 1);
    let injected = false;
    __setResumeSessionTestHooksForTest({
      beforeCandidateClose: (_path, fd) => {
        if (injected) return;
        injected = true;
        closeSync(fd);
      },
    });

    expect(resolveResumeSessionId(workHome, sessionId)).toEqual({
      kind: "search_incomplete",
      input: sessionId,
      reason: "source_unavailable",
    });
    expect(injected).toBe(true);
  });
});
