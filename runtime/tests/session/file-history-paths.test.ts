import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FileHistory } from "../../src/session/file-history.js";
import { fileHistorySessionDirName } from "../../src/session/file-history-paths.js";

test("the session directory name is pinned: directories on disk already carry it", () => {
  expect(fileHistorySessionDirName("probe")).toBe("session-ba9c736f19e7f60b");
});

test.each(["probe", "conv-mf3k2a9", "", "a/b\\c", "café"])(
  "the name for %j is `session-` plus 16 hex digits of the SHA-256 of the id",
  (sessionId) => {
    const name = fileHistorySessionDirName(sessionId);
    expect(name).toBe(
      `session-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`,
    );
    // One path segment whatever the id contains.
    expect(name).toMatch(/^session-[0-9a-f]{16}$/);
  },
);

test("the engine keeps a conversation's history in that directory", () => {
  const projectDir = join("projects", "example");
  const withSession = new FileHistory({ projectDir, sessionId: "probe" });
  const withoutSession = new FileHistory({ projectDir });
  try {
    expect(withSession.historyDir).toBe(
      join(projectDir, "file-history", "session-ba9c736f19e7f60b"),
    );
    expect(withoutSession.historyDir).toBe(join(projectDir, "file-history"));
  } finally {
    withSession.stop();
    withoutSession.stop();
  }
});
