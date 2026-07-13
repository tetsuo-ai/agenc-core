import { describe, expect, test } from "vitest";

import { checkReadOnlyConstraints } from "../../../src/tools/BashTool/readOnlyValidation.js";

// M-BASH-1 (core-todo.md): in the `date` read-only config, --iso-8601 was typed
// 'string' AND listed in the danger callback's flagsWithArgs, so a trailing
// positional (MMDDhhmm, which sets the system clock) was consumed as the flag's
// argument and never reached the "positional not starting with +" danger check.
// GNU date's --iso-8601 / --rfc-3339 take an OPTIONAL argument only via '='.

function readOnly(command: string): boolean {
  const result = checkReadOnlyConstraints({ command } as never, false);
  return result.behavior === "allow";
}

describe("date --iso-8601 read-only classification — M-BASH-1", () => {
  test("a clock-setting positional after --iso-8601 is NOT read-only", () => {
    expect(readOnly("date --iso-8601 12312359")).toBe(false);
    expect(readOnly("date --rfc-3339 12312359")).toBe(false);
  });

  test("the equivalent -I / bare positional forms remain blocked (regression guard)", () => {
    expect(readOnly("date -I 12312359")).toBe(false);
    expect(readOnly("date 12312359")).toBe(false);
  });

  test("legit display forms stay read-only", () => {
    expect(readOnly("date --iso-8601=hours")).toBe(true);
    expect(readOnly("date --iso-8601")).toBe(true);
    expect(readOnly("date --rfc-3339=ns")).toBe(true);
    expect(readOnly("date +%Y-%m-%d")).toBe(true);
    expect(readOnly("date -u")).toBe(true);
  });
});
