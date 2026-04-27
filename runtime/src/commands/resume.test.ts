import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listResumableSessions,
  parseResumeArgs,
  readFirstUserPreview,
  sessionIdFromFilename,
  runResume,
} from "./resume.js";
import { getProjectDir } from "../session/session-store.js";

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "agenc-resume-"));
  process.env.AGENC_HOME = join(workHome, ".agenc");
});

afterEach(() => {
  delete process.env.AGENC_HOME;
});

function writeRollout(
  slug: string,
  sessionId: string,
  iso: string,
  lines: unknown[],
  mtimeSec: number,
): string {
  const projectDir = join(workHome, ".agenc", "projects", slug);
  const sessionDir = join(projectDir, "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const fname = `rollout-${iso}-${sessionId}.jsonl`;
  const full = join(sessionDir, fname);
  writeFileSync(full, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  utimesSync(full, mtimeSec, mtimeSec);
  return full;
}

describe("resumeCommand helpers", () => {
  it("sessionIdFromFilename extracts an id from a AgenC-style filename", () => {
    const id = sessionIdFromFilename(
      "rollout-2026-04-20T10-00-00-000Z-abc123def.jsonl",
    );
    expect(id).toBe("abc123def");
  });

  it("sessionIdFromFilename returns null for non-rollout filenames", () => {
    expect(sessionIdFromFilename("not-a-rollout.jsonl")).toBeNull();
    expect(sessionIdFromFilename("rollout-xyz.txt")).toBeNull();
  });

  it("readFirstUserPreview pulls the first user-role content", () => {
    const file = join(workHome, "preview.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ role: "system", content: "ignore me" }),
        JSON.stringify({ role: "user", content: "hello there world" }),
      ].join("\n"),
    );
    expect(readFirstUserPreview(file)).toBe("hello there world");
  });

  it("parseResumeArgs accepts --last and a session id", () => {
    expect(parseResumeArgs("")).toEqual({ last: false });
    expect(parseResumeArgs("--last")).toEqual({ last: true });
    expect(parseResumeArgs("abcd1234")).toEqual({
      last: false,
      sessionId: "abcd1234",
    });
  });

  it("listResumableSessions walks the project slug and returns newest first", () => {
    // Resolve the real per-project slug from session-store so we
    // write rollouts to the exact path listResumableSessions will scan.
    const projectDir = getProjectDir(workHome);
    const realSlug = projectDir.split("/").pop()!;

    writeRollout(
      realSlug,
      "sess-older",
      "2026-04-01T10-00-00-000Z",
      [{ role: "user", content: "older session" }],
      1_700_000_000,
    );
    writeRollout(
      realSlug,
      "sess-newer",
      "2026-04-10T10-00-00-000Z",
      [{ role: "user", content: "newer session" }],
      1_800_000_000,
    );

    const results = listResumableSessions(workHome, { limit: 5 });
    expect(results.length).toBe(2);
    expect(results[0]!.sessionId).toBe("sess-newer");
    expect(results[1]!.sessionId).toBe("sess-older");
    expect(results[0]!.firstUserPreview).toMatch(/newer session/);
  });

  it("runResume returns a 'no sessions' message when directory is missing", async () => {
    const res = await runResume(join(workHome, "missing"), "");
    expect(res.kind).toBe("text");
    if (res.kind === "text") expect(res.text).toMatch(/No resumable sessions/);
  });

  it("runResume --last filters to the newest", async () => {
    const projectDir = getProjectDir(workHome);
    const realSlug = projectDir.split("/").pop()!;
    writeRollout(
      realSlug,
      "a",
      "2026-01-01T10-00-00-000Z",
      [{ role: "user", content: "a" }],
      1_700_000_000,
    );
    writeRollout(
      realSlug,
      "bbbbbbbb",
      "2026-03-01T10-00-00-000Z",
      [{ role: "user", content: "b" }],
      1_800_000_000,
    );
    const res = await runResume(workHome, "--last");
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/bbbbbbbb/);
      expect(res.text).not.toMatch(/ a  —/);
      expect(res.text).toMatch(/agenc --resume <sessionId>/);
    }
  });
});
