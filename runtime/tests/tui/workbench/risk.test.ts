import { describe, expect, it } from "vitest";

import {
  classifyApprovalRisk,
  typedConfirmationWordForRisk,
} from "../../../src/permissions/risk.js";

describe("approval risk helpers", () => {
  it("classifies low, medium, and destructive requests", () => {
    expect(classifyApprovalRisk({ toolName: "Read", command: "cat README.md" })).toBe("low");
    expect(classifyApprovalRisk({ toolName: "Bash", command: "npm install" })).toBe("medium");
    expect(classifyApprovalRisk({ toolName: "Bash", command: "rm -rf /tmp/project" })).toBe("destructive");
    expect(classifyApprovalRisk({ toolName: "Bash", command: `bash {"script":"rm -rf /tmp/project"}` })).toBe("destructive");
  });

  it.each([
    "rm -fr /tmp/project",
    "rm -r -f /tmp/project",
    "rm --recursive --force /tmp/project",
    "bash -lc 'rm -fr /tmp/project'",
  ])("classifies equivalent forced recursive removals as destructive: %s", (command) => {
    expect(classifyApprovalRisk({ toolName: "Bash", command })).toBe("destructive");
  });

  it("requires specific confirmation words for destructive actions", () => {
    expect(typedConfirmationWordForRisk({ risk: "destructive", command: "transfer tokens" })).toBe("transfer");
    expect(typedConfirmationWordForRisk({ risk: "destructive", command: "delete branch" })).toBe("delete");
    expect(typedConfirmationWordForRisk({ risk: "destructive", command: "rm -fr /tmp/project" })).toBe("delete");
    expect(typedConfirmationWordForRisk({ risk: "destructive", command: `bash {"script":"rm -rf /tmp/project"}` })).toBe("delete");
    expect(typedConfirmationWordForRisk({ risk: "medium", command: "npm install" })).toBe("yes");
  });
});
