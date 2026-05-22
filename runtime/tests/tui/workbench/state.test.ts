import { describe, expect, it } from "vitest";

import { isWorkbenchEnabled } from "../../../src/tui/workbench/state.js";
import { WORKBENCH_ENV_VAR } from "../../../src/tui/workbench/types.js";

describe("workbench state helpers", () => {
  it("enables the workbench by default with explicit opt-out", () => {
    expect(isWorkbenchEnabled({})).toBe(true);
    expect(isWorkbenchEnabled({ [WORKBENCH_ENV_VAR]: "1" })).toBe(true);
    expect(isWorkbenchEnabled({ [WORKBENCH_ENV_VAR]: "true" })).toBe(true);
    expect(isWorkbenchEnabled({ [WORKBENCH_ENV_VAR]: "0" })).toBe(false);
    expect(isWorkbenchEnabled({ [WORKBENCH_ENV_VAR]: "false" })).toBe(false);
  });
});
