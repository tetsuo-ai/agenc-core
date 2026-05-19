import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getProjectDir } from "../session/session-store.js";
import { sanitizePath } from "../utils/sessionStoragePortable.js";
import {
  resolveLatestSessionId,
  resolveResumeSessionId,
} from "./resume-session.js";

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "agenc-resume-cli-"));
  process.env.AGENC_HOME = join(workHome, ".agenc");
});

afterEach(() => {
  delete process.env.AGENC_HOME;
});

/**
 * Write the JSONL header that `listResumableSessions` requires to surface
 * a rollout from disk: a session_meta line plus at least one user
 * message (the picker filters out rollouts that never recorded one).
 */
function rolloutContent(sessionId: string): string {
  return (
    `${JSON.stringify({ type: "session_meta", sessionId })}\n` +
    `${JSON.stringify({ role: "user", content: `seed for ${sessionId}` })}\n`
  );
}

function writeRolloutAtSlug(
  slug: string,
  sessionId: string,
  iso: string,
  mtimeSec: number,
): void {
  const sessionDir = join(
    process.env.AGENC_HOME!,
    "projects",
    slug,
    "sessions",
    sessionId,
  );
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, `rollout-${iso}-${sessionId}.jsonl`);
  writeFileSync(file, rolloutContent(sessionId));
  utimesSync(file, mtimeSec, mtimeSec);
}

/** Write under the canonical (hashed) project slug. */
function writeRollout(
  cwd: string,
  sessionId: string,
  iso: string,
  mtimeSec: number,
): void {
  const projectDir = getProjectDir(cwd);
  const slug = projectDir.split("/").pop()!;
  writeRolloutAtSlug(slug, sessionId, iso, mtimeSec);
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
): void {
  writeRolloutAtSlug(sanitizePath(cwd), sessionId, iso, mtimeSec);
}

describe("resume-session CLI lookup", () => {
  it("resolves the newest project session for --continue", () => {
    writeRollout(workHome, "sess-older", "2026-01-01T10-00-00-000Z", 1);
    writeRollout(workHome, "sess-newer", "2026-01-02T10-00-00-000Z", 2);

    expect(resolveLatestSessionId(workHome)).toEqual({
      kind: "ok",
      sessionId: "sess-newer",
    });
  });

  it("resolves exact and unique-prefix session ids", () => {
    writeRollout(workHome, "conv-abcdef", "2026-01-01T10-00-00-000Z", 1);

    expect(resolveResumeSessionId(workHome, "conv-abcdef")).toEqual({
      kind: "ok",
      sessionId: "conv-abcdef",
    });
    expect(resolveResumeSessionId(workHome, "conv-abc")).toEqual({
      kind: "ok",
      sessionId: "conv-abcdef",
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
    writeLegacyRollout(workHome, "conv-legacy01", "2026-01-01T10-00-00-000Z", 1);

    expect(resolveResumeSessionId(workHome, "conv-legacy01")).toEqual({
      kind: "ok",
      sessionId: "conv-legacy01",
    });
  });

  it("dedups when the same conv-id exists in both slug layouts", () => {
    // Same conv-id written under both the canonical (hashed) and legacy
    // (sanitized) project slugs. The resolver should accept it from
    // either path without reporting ambiguity.
    writeRollout(workHome, "conv-shared01", "2026-01-02T10-00-00-000Z", 2);
    writeLegacyRollout(workHome, "conv-shared01", "2026-01-01T10-00-00-000Z", 1);

    expect(resolveResumeSessionId(workHome, "conv-shared01")).toEqual({
      kind: "ok",
      sessionId: "conv-shared01",
    });
  });

  it("finds a conv-id globally when neither local layout matches", () => {
    // Write a rollout under an unrelated project slug - neither the
    // canonical nor legacy slug for `workHome` will contain it.
    const foreignProject = join(workHome, "..", "some-other-checkout");
    writeRolloutAtSlug(
      sanitizePath(foreignProject),
      "conv-foreign01",
      "2026-01-01T10-00-00-000Z",
      1,
    );

    expect(resolveResumeSessionId(workHome, "conv-foreign01")).toEqual({
      kind: "ok",
      sessionId: "conv-foreign01",
    });
  });

  it("returns not_found when neither layout nor global walk finds the id", () => {
    writeRollout(workHome, "conv-existing", "2026-01-01T10-00-00-000Z", 1);

    expect(resolveResumeSessionId(workHome, "conv-missing01")).toEqual({
      kind: "not_found",
      input: "conv-missing01",
    });
  });
});
