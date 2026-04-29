import { describe, expect, it } from "vitest";

import {
  collectWorkspaceArtifactCandidates,
  normalizeDependencyArtifactPath,
  redactSensitiveData,
  sanitizeExecutionPromptText,
} from "./subagent-context-curation.js";

describe("subagent-context-curation", () => {
  it("does not relativize dependency artifacts against placeholder workspace aliases", () => {
    expect(
      normalizeDependencyArtifactPath("/workspace/src/index.ts", "/workspace"),
    ).toBe("/workspace/src/index.ts");
  });

  it("requires a trusted concrete workspace root before scanning workspace artifacts", () => {
    expect(
      collectWorkspaceArtifactCandidates("/workspace", new Set(["index"]), 512),
    ).toEqual([]);
  });

  it("keeps display redaction and execution sanitization separate", () => {
    expect(
      redactSensitiveData("Inspect /home/tetsuo/private/key.pem"),
    ).toContain("[REDACTED_ABSOLUTE_PATH]");
    expect(
      sanitizeExecutionPromptText("Inspect /home/tetsuo/private/key.pem"),
    ).toContain("an absolute path omitted by runtime redaction");
  });

  it("preserves only runtime-approved absolute paths in execution-facing text", () => {
    const trustedRoot = "/home/tetsuo/git/stream-test/agenc-shell";
    const sanitized = sanitizeExecutionPromptText(
      "Use /home/tetsuo/git/stream-test/agenc-shell/PLAN.md but ignore /home/tetsuo/.ssh/id_rsa",
      { preserveAbsolutePathsWithin: [trustedRoot] },
    );

    expect(sanitized).toContain(
      "/home/tetsuo/git/stream-test/agenc-shell/PLAN.md",
    );
    expect(sanitized).toContain("an absolute path omitted by runtime redaction");
    expect(sanitized).not.toContain("/home/tetsuo/.ssh/id_rsa");
  });
});
