import { describe, expect, test } from "vitest";

import type { ResumableSession } from "../../session/session-store.js";
import {
  buildResumeSearchText,
  filterResumableSessions,
} from "./ResumeConversation.js";

function session(
  overrides: Partial<ResumableSession> & Pick<ResumableSession, "sessionId">,
): ResumableSession {
  return {
    sessionId: overrides.sessionId,
    rolloutPath:
      overrides.rolloutPath ??
      `/tmp/sessions/${overrides.sessionId}/rollout-2026-${overrides.sessionId}.jsonl`,
    indexPath:
      overrides.indexPath ?? `/tmp/sessions/${overrides.sessionId}/index.json`,
    lastModified: overrides.lastModified ?? Date.UTC(2026, 3, 29, 12, 0, 0),
    fileSize: overrides.fileSize ?? 2048,
    summary: overrides.summary ?? `summary for ${overrides.sessionId}`,
    ...(overrides.agencVersion !== undefined
      ? { agencVersion: overrides.agencVersion }
      : {}),
    ...(overrides.schemaVersion !== undefined
      ? { schemaVersion: overrides.schemaVersion }
      : {}),
  };
}

describe("ResumeConversation search helpers", () => {
  test("buildResumeSearchText uses persisted local session metadata", () => {
    const text = buildResumeSearchText(
      session({
        sessionId: "conv-alpha",
        summary: "Fix startup gate wiring",
        agencVersion: "0.2.0",
        schemaVersion: 3,
      }),
    );

    expect(text).toContain("conv-alpha");
    expect(text).toContain("fix startup gate wiring");
    expect(text).toContain("0.2.0");
    expect(text).toContain("schema 3");
  });

  test("filterResumableSessions matches all query terms case-insensitively", () => {
    const sessions = [
      session({
        sessionId: "conv-status",
        summary: "Footer notice cleanup",
      }),
      session({
        sessionId: "conv-resume",
        summary: "Resume picker search",
      }),
    ];

    expect(
      filterResumableSessions(sessions, "PICKER resume").map(
        (item) => item.sessionId,
      ),
    ).toEqual(["conv-resume"]);
  });

  test("filterResumableSessions returns the original list for empty search", () => {
    const sessions = [
      session({ sessionId: "conv-a" }),
      session({ sessionId: "conv-b" }),
    ];

    expect(filterResumableSessions(sessions, "")).toBe(sessions);
  });
});
