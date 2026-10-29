import { describe, expect, test } from "vitest";

import { hookMatcherInputsForToolName } from "./hook-event-schedule.js";

describe("hook tool matcher aliases", () => {
  test.each(["exec_command", "system.bash", "PowerShell"])(
    "Bash matches %s while preserving its canonical name",
    (name) => {
      expect(hookMatcherInputsForToolName(name)).toEqual([name, "Bash"]);
    },
  );

  test.each(["FileRead", "NotebookRead"])(
    "Read matches %s while preserving its canonical name",
    (name) => {
      expect(hookMatcherInputsForToolName(name)).toEqual([name, "Read"]);
    },
  );

  test("preserves apply_patch and explicit aliases without duplicates", () => {
    expect(hookMatcherInputsForToolName("apply_patch", ["Edit", "Custom"]))
      .toEqual(["apply_patch", "Write", "Edit", "Custom"]);
    expect(hookMatcherInputsForToolName("exec_command", ["Bash", "Custom"]))
      .toEqual(["exec_command", "Bash", "Custom"]);
  });

  test.each(["Read", "Bash", "Write", "Grep", "mcp.read_file", "custom.bash"])(
    "keeps other tool names unchanged: %s",
    (name) => {
      expect(hookMatcherInputsForToolName(name)).toEqual([name]);
    },
  );
});
