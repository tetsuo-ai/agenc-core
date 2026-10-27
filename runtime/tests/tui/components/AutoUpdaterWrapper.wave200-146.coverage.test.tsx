import { describe, expect, test, vi } from "vitest";
import { AutoUpdaterWrapper } from "../../../src/tui/components/AutoUpdaterWrapper.js";

describe("legacy updater shutdown", () => {
  test("never mounts an upstream updater for any install or settings", () => {
    const onChangeIsUpdating = vi.fn();
    const onAutoUpdaterResult = vi.fn();
    expect(AutoUpdaterWrapper({ isUpdating: false, onChangeIsUpdating, onAutoUpdaterResult,
      autoUpdaterResult: null, showSuccessMessage: true, verbose: true })).toBeNull();
    expect(onChangeIsUpdating).not.toHaveBeenCalled();
    expect(onAutoUpdaterResult).not.toHaveBeenCalled();
  });
});
