import { describe, expect, test, vi } from "vitest";

import {
  routeCLI,
  stripRoutingFlags,
  type BootTUIArgs,
  type ContinueTUIArgs,
  type ResumeTUIArgs,
} from "./route.js";
import { readStartupCliFlags } from "./bootstrap.js";

const NODE = "/usr/bin/node";
const SCRIPT = "/opt/agenc/bin/agenc.js";

function handles() {
  return {
    bootTUI: vi.fn(async (_args: BootTUIArgs) => 0),
    oneShotCLI: vi.fn(async (_message: string) => 0),
    resumeTUI: vi.fn(async (_args: ResumeTUIArgs) => 0),
    continueTUI: vi.fn(async (_args: ContinueTUIArgs) => 0),
  };
}

describe("TUI yolo startup parity", () => {
  test("--yolo keeps interactive startup on the same TUI route", async () => {
    const h = handles();

    const exit = await routeCLI({
      argv: [NODE, SCRIPT, "--yolo", "repair", "the", "tui"],
      isTTY: true,
      isStdoutTTY: true,
      ...h,
    });

    expect(exit).toBe(0);
    expect(h.bootTUI).toHaveBeenCalledWith({ initialPrompt: "repair the tui" });
    expect(h.oneShotCLI).not.toHaveBeenCalled();
    expect(h.resumeTUI).not.toHaveBeenCalled();
    expect(h.continueTUI).not.toHaveBeenCalled();
  });

  test("startup permission flags are not treated as prompt text", () => {
    expect(
      stripRoutingFlags([
        "--permission-mode",
        "bypassPermissions",
        "--yolo",
        "--allow-dangerously-skip-permissions",
        "fix",
        "rendering",
      ]),
    ).toEqual(["fix", "rendering"]);
  });

  test("--yolo resolves to the permission-bypass startup policy", () => {
    expect(readStartupCliFlags([NODE, SCRIPT, "--yolo"])).toMatchObject({
      allowDangerouslySkipPermissions: true,
    });
  });
});
