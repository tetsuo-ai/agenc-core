import { describe, expect, test } from "vitest";

import type { ResumableSession } from "../../session/session-store.js";
import {
  buildResumeSearchText,
  filterResumableSessions,
} from "./ResumeConversation.js";
import {
  readRuntimeStatusNoticeWarnings,
  type StatusNoticeSession,
} from "../cockpit/StatusNotices.js";

function session(id: string, summary: string): ResumableSession {
  return {
    sessionId: id,
    rolloutPath: `/tmp/${id}/rollout.jsonl`,
    indexPath: `/tmp/${id}/index.json`,
    lastModified: Date.UTC(2026, 3, 30, 12, 0, 0),
    fileSize: 1024,
    summary,
    agencVersion: "0.2.0",
    schemaVersion: 3,
  };
}

describe("OpenClaude resume and status parity", () => {
  test("resume search matches persisted local session metadata", () => {
    const sessions = [
      session("conv-shell", "Repair startup shell"),
      session("conv-resume", "Bounded resume picker"),
    ];

    expect(buildResumeSearchText(sessions[1]!)).toContain("bounded resume picker");
    expect(filterResumableSessions(sessions, "resume bounded")).toEqual([
      sessions[1],
    ]);
  });

  test("runtime status notices read project memory and agent definition warnings", () => {
    const warnings = readRuntimeStatusNoticeWarnings({
      projectMemoryWarnings: ["AGENTS.md include dropped: unreadable"],
      agentDefinitions: {
        activeAgents: [
          { agentType: "worker", whenToUse: "implementation" },
          { name: "malformed" },
        ],
      },
    } as StatusNoticeSession);

    expect(warnings.projectMemoryWarnings).toHaveLength(1);
    expect(warnings.agentDefinitionWarnings).toHaveLength(1);
  });
});
