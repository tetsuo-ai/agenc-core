import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getProjectDir } from "../session/session-store.js";
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

function writeRollout(
  cwd: string,
  sessionId: string,
  iso: string,
  mtimeSec: number,
): void {
  const sessionDir = join(getProjectDir(cwd), "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, `rollout-${iso}-${sessionId}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session_meta", sessionId })}\n`,
  );
  utimesSync(file, mtimeSec, mtimeSec);
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

    expect(resolveResumeSessionId(workHome, "conv-abc")).toEqual({
      kind: "ambiguous",
      input: "conv-abc",
      matches: ["conv-abc222", "conv-abc111"],
    });
  });

  it("returns none when the project has no sessions", () => {
    expect(resolveLatestSessionId(workHome)).toEqual({ kind: "none" });
  });
});
