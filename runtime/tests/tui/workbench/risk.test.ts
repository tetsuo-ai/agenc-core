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
  });

  it("requires specific confirmation words for destructive actions", () => {
    expect(typedConfirmationWordForRisk({ risk: "destructive", command: "transfer tokens" })).toBe("transfer");
    expect(typedConfirmationWordForRisk({ risk: "destructive", command: "delete branch" })).toBe("delete");
    expect(typedConfirmationWordForRisk({ risk: "medium", command: "npm install" })).toBe("yes");
  });
});
