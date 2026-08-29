import { afterEach, describe, expect, test, vi } from "vitest";

const platform = vi.hoisted(() => ({ getPlatform: vi.fn() }));

vi.mock("../../../src/utils/platform.js", () => platform);

import { isPowerShellToolEnabled } from "../../../src/utils/shell/shellToolUtils.js";

const originalToggle = process.env.AGENC_USE_POWERSHELL_TOOL;

afterEach(() => {
  platform.getPlatform.mockReset();
  if (originalToggle === undefined) {
    delete process.env.AGENC_USE_POWERSHELL_TOOL;
  } else {
    process.env.AGENC_USE_POWERSHELL_TOOL = originalToggle;
  }
});

describe("PowerShell capability authority", () => {
  test("Windows capability does not depend on the removed environment toggle", () => {
    platform.getPlatform.mockReturnValue("windows");
    for (const value of [undefined, "0", "1"] as const) {
      if (value === undefined) delete process.env.AGENC_USE_POWERSHELL_TOOL;
      else process.env.AGENC_USE_POWERSHELL_TOOL = value;
      expect(isPowerShellToolEnabled()).toBe(true);
    }
  });

  test("non-Windows platforms do not register the Windows-only tool", () => {
    platform.getPlatform.mockReturnValue("linux");
    process.env.AGENC_USE_POWERSHELL_TOOL = "1";
    expect(isPowerShellToolEnabled()).toBe(false);
  });
});
