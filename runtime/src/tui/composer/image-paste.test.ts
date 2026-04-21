/**
 * Wave 3-C: image-paste tests.
 *
 * Two layers of coverage:
 *   - Pure `getPlatformClipboardExtractor` routing, verified by passing
 *     an explicit platform tag so the test is deterministic on any host.
 *   - `tryReadClipboardImage` negative path, exercised with
 *     `child_process.execFile` mocked to always fail so no real shell
 *     command is spawned during CI.
 *
 * We deliberately do not assert on the positive clipboard path from unit
 * tests — success would require a real image payload and a real jimp
 * decode, which belongs in an integration test behind a platform gate.
 */

import { describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => {
  /**
   * Every `execFile(cmd, args, opts, cb)` call is failed with ENOENT so
   * the production code path simulates "no clipboard tool installed"
   * across every platform extractor.
   */
  type ExecCallback = (
    err: Error & { code?: string },
    stdout: Buffer,
    stderr: Buffer,
  ) => void;
  function execFile(
    _cmd: string,
    _args: readonly string[] | undefined,
    optionsOrCb: unknown,
    maybeCb?: ExecCallback,
  ): unknown {
    const cb =
      typeof optionsOrCb === "function"
        ? (optionsOrCb as ExecCallback)
        : maybeCb;
    const err = new Error("mocked ENOENT") as Error & { code?: string };
    err.code = "ENOENT";
    if (cb !== undefined) {
      queueMicrotask(() => cb(err, Buffer.alloc(0), Buffer.alloc(0)));
    }
    return {
      on: () => undefined,
      kill: () => undefined,
    };
  }
  return { execFile, default: { execFile } };
});

import {
  getPlatformClipboardExtractor,
  tryReadClipboardImage,
} from "./image-paste.js";

describe("getPlatformClipboardExtractor", () => {
  test("maps darwin to the darwin extractor", () => {
    expect(getPlatformClipboardExtractor("darwin")).toBe("darwin");
  });

  test("maps linux to the linux extractor", () => {
    expect(getPlatformClipboardExtractor("linux")).toBe("linux");
  });

  test("maps win32 to the win32 extractor", () => {
    expect(getPlatformClipboardExtractor("win32")).toBe("win32");
  });

  test("maps unknown platforms to unsupported", () => {
    // `aix` is a valid Node platform value but is not one of the three
    // that ship with a clipboard extractor. Cast through the narrower
    // union so the helper still receives a legal NodeJS.Platform.
    expect(
      getPlatformClipboardExtractor("aix" as NodeJS.Platform),
    ).toBe("unsupported");
  });
});

describe("tryReadClipboardImage", () => {
  test("returns null when the clipboard extractor fails", async () => {
    // With `execFile` mocked to always error, every supported platform
    // path falls through to the "no image" terminal state and we get
    // null. Running this on `aix` would be equally valid — the
    // platform check short-circuits before any subprocess.
    const result = await tryReadClipboardImage();
    expect(result).toBeNull();
  });
});
