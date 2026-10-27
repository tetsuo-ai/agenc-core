import { describe, expect, it } from "vitest";
import { checkReadOnlyConstraints } from "../../src/tools/BashTool/readOnlyValidation.js";

describe("literal printf inspection", () => {
  it("permits the operator's literal plan-mode probe", () => {
    expect(checkReadOnlyConstraints({ command: "printf TF6_PLAN_OK" }, false).behavior).toBe("allow");
  });
  it.each(["printf -v value text", "printf %n 'a[$(touch marker)]'", "printf text > marker", "printf $(touch marker)"])(
    "does not grant the text-only exception to %s", (command) => {
      expect(checkReadOnlyConstraints({ command }, false).behavior).not.toBe("allow");
    },
  );
});
