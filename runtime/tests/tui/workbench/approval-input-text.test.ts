import { describe, expect, it } from "vitest";

import { approvalInputText } from "../../../src/tui/workbench/approvals/inputText.js";

describe("approvalInputText", () => {
  it("renders split shell command and args as one command line", () => {
    expect(
      approvalInputText({
        command: "rm",
        args: ["-rf", "/tmp/agenc-danger"],
      }),
    ).toBe("rm -rf /tmp/agenc-danger");
  });

  it("renders local-shell argv arrays as one command line", () => {
    expect(
      approvalInputText({
        command: ["bash", "-lc", "rm -rf /tmp/agenc-danger"],
        cwd: "/tmp/agenc",
      }),
    ).toBe("bash -lc rm -rf /tmp/agenc-danger");
  });
});
