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
  renameSync,
  statSync,
  truncateSync,
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
  reproveResumeSessionAllowingAppend,
  resolveInitialResumeSession,
  resolveLatestSessionId as resolveLatestSessionIdWithHome,
  resolveResumeSessionId as resolveResumeSessionIdWithHome,
  type ResolvedResumeSession,
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

/** A rollout whose session header names its originator and source. */
function writeRolloutWithMeta(
  cwd: string,
  sessionId: string,
  mtimeSec: number,
  meta: { readonly originator: string; readonly source?: string },
): string {
  const sessionDir = join(projectDir(cwd), "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, `rollout-2026-01-01T10-00-00-000Z-${sessionId}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd,
        agencVersion: "0.19.12",
        rolloutSchemaVersion: 5,
        ...meta,
      },
    })}\n${JSON.stringify({
      type: "response_item",
      payload: { role: "user", content: `seed for ${sessionId}` },
    })}\n`,
  );
  utimesSync(file, mtimeSec, mtimeSec);
  return file;
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

  it("--continue skips newer sub-agent, hook-agent and review sessions", () => {
    // After a turn, memory extraction (a sub-agent) writes the newest rollout
    // in the project; --continue must still open the user's conversation.
    const root = writeRolloutWithMeta(workHome, "conv-userroot1", 1, {
      originator: "agenc-cli",
      source: "interactive-root",
    });
    writeRolloutWithMeta(workHome, "a1b2c3d4-0000-4000-8000-000000000001", 4, {
      originator: "agenc-subagent",
    });
    writeRolloutWithMeta(workHome, "a1b2c3d4-0000-4000-8000-000000000002", 3, {
      originator: "agenc-hook-agent",
    });
    writeRolloutWithMeta(workHome, "a1b2c3d4-0000-4000-8000-000000000003", 2, {
      originator: "agenc-review-delegate",
    });

    expect(resolveLatestSessionId(workHome)).toMatchObject({
      kind: "ok",
      sessionId: "conv-userroot1",
      rolloutPath: root,
    });
  });

  it("--continue is not stopped by a background session still being written", () => {
    const root = writeRolloutWithMeta(workHome, "conv-userroot2", 1, {
      originator: "agenc-cli",
      source: "interactive-root",
    });
    const live = writeRolloutWithMeta(workHome, "a1b2c3d4-0000-4000-8000-000000000004", 2, {
      originator: "agenc-subagent",
    });
    // The extraction appends while the search reads its header.
    __setResumeSessionTestHooksForTest({
      afterCandidateMetadataRead: (path) => {
        if (path === live) writeFileSync(path, `${JSON.stringify({ type: "response_item", payload: {} })}\n`, { flag: "a" });
      },
    });

    expect(resolveLatestSessionId(workHome)).toMatchObject({
      kind: "ok",
      sessionId: "conv-userroot2",
      rolloutPath: root,
    });
  });

  it("an explicit session id still resolves a sub-agent session", () => {
    const sub = writeRolloutWithMeta(workHome, "a1b2c3d4-0000-4000-8000-000000000005", 2, {
      originator: "agenc-subagent",
    });

    expect(
      resolveResumeSessionId(workHome, "a1b2c3d4-0000-4000-8000-000000000005"),
    ).toMatchObject({ kind: "ok", rolloutPath: sub });
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

  it("prefers the versioned project record over an ambiguous legacy directory", () => {
    const canonicalPath = writeRollout(
      workHome,
      "conv-shared01",
      "2026-01-02T10-00-00-000Z",
      2,
    );
    writeLegacyRollout(
      workHome,
      "conv-shared01",
      "2026-01-01T10-00-00-000Z",
      1,
    );

    expect(resolveResumeSessionId(workHome, "conv-shared01")).toMatchObject({
      kind: "ok",
      sessionId: "conv-shared01",
      rolloutPath: canonicalPath,
    });
  });

  it("does not automatically continue from an ambiguous legacy project key", () => {
    const legacyPath = writeLegacyRollout(
      workHome,
      "conv-oldkey01",
      "2026-01-01T10-00-00-000Z",
      1,
    );
    expect(resolveLatestSessionId(workHome)).toEqual({ kind: "none" });
    expect(resolveResumeSessionId(workHome, "conv-oldkey01")).toMatchObject({
      kind: "ok",
      rolloutPath: legacyPath,
      cwd: workHome,
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

describe("initial resume search during startup writes", () => {
  it.each(["latest", "exact"] as const)("retries a %s search whose source grows while metadata is read", async (kind) => {
    const id = "conv-startupappend1";
    const path = writeRollout(workHome, id, "2026-01-01T10-00-00-000Z", 1);
    let appends = 0;
    __setResumeSessionTestHooksForTest({ afterCandidateMetadataRead: (observed) => {
      if (observed !== path || appends >= 2) return;
      appends += 1;
      writeFileSync(path, `${JSON.stringify({ type: "response_item", payload: { role: "assistant", content: "restored" } })}\n`, { flag: "a" });
    } });
    const result = await resolveInitialResumeSession(() => kind === "latest"
      ? resolveLatestSessionId(workHome) : resolveResumeSessionId(workHome, id));
    expect(result).toMatchObject({ kind: "ok", sessionId: id, sourceSize: String(statSync(path).size) });
    expect(appends).toBe(2);
    if (result.kind === "ok") {
      expect(resolveResumeSessionId(workHome, id)).toEqual(result);
    }
  });

  it("does not retry a search that exhausted its metadata budget", async () => {
    let attempts = 0;
    const result = await resolveInitialResumeSession(() => {
      attempts += 1;
      return { kind: "search_incomplete", input: "--continue", reason: "metadata_limit" };
    });
    expect(result).toMatchObject({ kind: "search_incomplete", reason: "metadata_limit" });
    expect(attempts).toBe(1);
  });

  it("fails closed when the rollout never becomes stable", async () => {
    const id = "conv-startupunstable1";
    const path = writeRollout(workHome, id, "2026-01-01T10-00-00-000Z", 1);
    let mutations = 0;
    __setResumeSessionTestHooksForTest({ afterCandidateMetadataRead: () => {
      mutations += 1;
      writeFileSync(path, `${rolloutContent(id, workHome)}${" ".repeat(mutations)}\n`);
    } });
    const result = await resolveInitialResumeSession(() => resolveLatestSessionId(workHome));
    expect(result).toEqual({ kind: "search_incomplete", input: "--continue", reason: "source_unavailable" });
    expect(mutations).toBeGreaterThan(1);
  });

  it("keeps an unavailable source closed when cancelled", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const result = await resolveInitialResumeSession(() => {
      attempts += 1;
      controller.abort();
      return { kind: "search_incomplete", input: "--continue", reason: "source_unavailable" };
    }, controller.signal);
    expect(result).toMatchObject({ kind: "search_incomplete", reason: "source_unavailable" });
    expect(attempts).toBe(1);
  });
});

describe("append-only resume reproof", () => {
  function appendLine(path: string, text: string): void {
    const fd = openSync(path, "a");
    try {
      writeSync(fd, `${JSON.stringify({ type: "response_item", payload: { role: "assistant", content: text } })}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  function resolved(sessionId: string): ResolvedResumeSession {
    const result = resolveResumeSessionId(workHome, sessionId);
    if (result.kind !== "ok") throw new Error(`fixture did not resolve: ${result.kind}`);
    return result;
  }

  it("accepts what a live daemon appended after the descriptor was resolved", () => {
    const sessionId = "conv-appendok1";
    const rolloutPath = writeRollout(workHome, sessionId, "2026-01-01T10-00-00-000Z", 1);
    const before = resolved(sessionId);
    appendLine(rolloutPath, "streamed after the terminal closed");
    const after = reproveResumeSessionAllowingAppend(before, agencHome);
    expect(after.rolloutPath).toBe(rolloutPath);
    expect(after.sourceIno).toBe(before.sourceIno);
    expect(Number(after.sourceSize)).toBe(statSync(rolloutPath).size);
    expect(Number(after.sourceSize)).toBeGreaterThan(Number(before.sourceSize));
  });

  it("retries while appends land during the read, then reproves the grown source", () => {
    const sessionId = "conv-appendrace1";
    const rolloutPath = writeRollout(workHome, sessionId, "2026-01-01T10-00-00-000Z", 1);
    const before = resolved(sessionId);
    let appended = 0;
    __setResumeSessionTestHooksForTest({
      afterCandidateMetadataRead: (path) => {
        if (appended >= 2) return;
        appended += 1;
        appendLine(path, `delta ${appended}`);
      },
    });
    const after = reproveResumeSessionAllowingAppend(before, agencHome);
    expect(appended).toBe(2);
    expect(Number(after.sourceSize)).toBe(statSync(rolloutPath).size);
  });

  it("still refuses a rewritten past, a replaced file and a truncation", () => {
    for (const change of ["rewritten", "replaced", "truncated"] as const) {
      const sessionId = `conv-append${change}`;
      const rolloutPath = writeRollout(workHome, sessionId, "2026-01-01T10-00-00-000Z", 1);
      const before = resolved(sessionId);
      const original = readFileSync(rolloutPath, "utf8");
      if (change === "rewritten") {
        writeFileSync(rolloutPath, original.replace(`seed for ${sessionId}`, "rewritten input") + "\n");
      } else if (change === "replaced") {
        renameSync(rolloutPath, `${rolloutPath}.old`);
        writeFileSync(rolloutPath, `${original}\n`);
      } else {
        truncateSync(rolloutPath, Number(before.sourceSize) - 10);
      }
      expect(() => reproveResumeSessionAllowingAppend(before, agencHome), change)
        .toThrow(/changed during authorization/);
    }
  });

  it("gives up when the source never holds still", () => {
    const sessionId = "conv-appendstorm1";
    writeRollout(workHome, sessionId, "2026-01-01T10-00-00-000Z", 1);
    const before = resolved(sessionId);
    let appended = 0;
    __setResumeSessionTestHooksForTest({
      afterCandidateMetadataRead: (path) => {
        appended += 1;
        appendLine(path, `delta ${appended}`);
      },
    });
    const started = Date.now();
    expect(() => reproveResumeSessionAllowingAppend(before, agencHome)).toThrow(/changed during authorization/);
    expect(appended).toBeGreaterThan(5);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
