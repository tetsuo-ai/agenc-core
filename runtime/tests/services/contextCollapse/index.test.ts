import { describe, expect, it } from "vitest";
import {
  getContextCollapseState,
  isContextCollapseEnabled,
  type AgenCContextCollapseState,
} from "./index.js";

describe("contextCollapse disabled service surface", () => {
  it("reports the disabled collapse state without throwing", () => {
    expect(isContextCollapseEnabled()).toBe(false);
    expect(getContextCollapseState()).toBeNull();
  });

  it("pins the state type to the disabled null surface", () => {
    const state: AgenCContextCollapseState = getContextCollapseState();
    expect(state).toBeNull();
  });
});
