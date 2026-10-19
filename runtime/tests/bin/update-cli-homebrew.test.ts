import { afterEach, describe, expect, test, vi } from "vitest";
import { runAgenCUpdateCli } from "../../src/bin/update-cli.js";

afterEach(() => vi.restoreAllMocks());

describe("Homebrew update ownership", () => {
  test.each([
    {},
    { wrapper: "/home/user/.local/bin/agenc" },
    { pinVersion: "0.19.12", json: true },
  ])("refuses installation before fetching or discovering wrappers: %j", async options => {
    vi.spyOn(process, "argv", "get").mockReturnValue([
      "/usr/bin/node",
      "/home/linuxbrew/.linuxbrew/Cellar/agenc/0.19.11/libexec/node_modules/@tetsuo-ai/runtime/bin/agenc",
    ]);
    const fetchImpl = vi.fn<typeof fetch>();
    const stderr = vi.fn();
    expect(await runAgenCUpdateCli({ kind: "update", check: false, json: false, ...options }, {
      env: {}, fetchImpl, stderr, stdout: vi.fn(),
    })).toBe(1);
    expect(stderr).toHaveBeenCalledWith("agenc: Homebrew manages this installation. Run in your terminal: brew upgrade tetsuo-ai/agenc/agenc");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
