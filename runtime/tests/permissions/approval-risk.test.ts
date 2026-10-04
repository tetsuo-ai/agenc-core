import { describe, expect, it } from "vitest";

import {
  classifyApprovalRisk,
  typedConfirmationWordForRisk,
} from "../../src/permissions/risk.js";

describe("classifyApprovalRisk", () => {
  it("does not treat slash-command or output-format wording as destructive", () => {
    expect(
      classifyApprovalRisk({
        toolName: "TodoWrite",
        description: "Update the slash-command registry",
        toolInput: { todos: [{ content: "Document the /compact slash command" }] },
      }),
    ).toBe("low");
    expect(
      classifyApprovalRisk({
        toolName: "exec_command",
        command: "git log --format=oneline --output-format json",
      }),
    ).toBe("low");
  });

  it("classifies disk format and fund-movement words as destructive", () => {
    expect(classifyApprovalRisk({ command: "format C:" })).toBe("destructive");
    expect(
      classifyApprovalRisk({
        description: "settle the mainnet escrow and transfer stake",
      }),
    ).toBe("destructive");
    expect(
      classifyApprovalRisk({
        toolName: "exec_command",
        command: "rm -rf /tmp/fixture",
      }),
    ).toBe("destructive");
    expect(
      classifyApprovalRisk({
        toolName: "exec_command",
        command: "rm --recursive --force /tmp/fixture",
      }),
    ).toBe("destructive");
  });

  it("classifies mutation and network verbs as medium, not a typed confirm", () => {
    expect(
      classifyApprovalRisk({
        toolName: "Write",
        description: "write the patch and chmod the script",
      }),
    ).toBe("medium");
    expect(
      classifyApprovalRisk({
        toolName: "exec_command",
        command: "curl https://example.test",
      }),
    ).toBe("medium");
    expect(
      typedConfirmationWordForRisk({
        risk: "medium",
        command: "curl https://example.test",
      }),
    ).toBe("yes");
  });
});

describe("typedConfirmationWordForRisk", () => {
  it.each([
    ["settle the escrow", "settle"],
    ["stake the validator", "stake"],
    ["transfer funds", "transfer"],
    ["delete the snapshot", "delete"],
    ["destroy the volume", "delete"],
    ["format C:", "approve"],
  ] as const)("typed confirmation for %s is %s", (haystack, word) => {
    expect(
      typedConfirmationWordForRisk({
        risk: "destructive",
        description: haystack,
      }),
    ).toBe(word);
  });

  it("uses delete for CronDelete and removal commands", () => {
    expect(
      typedConfirmationWordForRisk({
        risk: "destructive",
        toolName: "CronDelete",
      }),
    ).toBe("delete");
    expect(
      typedConfirmationWordForRisk({
        risk: "destructive",
        toolName: "exec_command",
        command: "rm -rf /tmp/fixture",
      }),
    ).toBe("delete");
  });
});
