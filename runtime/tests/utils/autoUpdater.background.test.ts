import { afterEach, expect, test, vi } from "vitest";
const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("../../src/utils/execFileNoThrow.js", () => ({ execFileNoThrowWithCwd: exec }));
import { getLatestVersion } from "../../src/utils/autoUpdater.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("background checks run once per interval and back off failures; explicit checks stay fresh", async () => {
  let now = Date.UTC(2026, 9, 13);
  vi.stubGlobal("MACRO", { PACKAGE_URL: "@tetsuo-ai/agenc" });
  vi.spyOn(Date, "now").mockImplementation(() => now);
  exec.mockResolvedValue({ code: 1, stdout: "", stderr: "registry unavailable" });
  const interval = 30 * 60 * 1000;
  await Promise.all(Array.from({ length: 20 }, () => getLatestVersion("latest", { background: true })));
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec.mock.calls[0]?.[2]).toMatchObject({ background: true, timeout: 5000 });
  now += interval - 1;
  await getLatestVersion("latest", { background: true });
  expect(exec).toHaveBeenCalledTimes(1);
  now += 1;
  await getLatestVersion("latest", { background: true });
  expect(exec).toHaveBeenCalledTimes(2);
  now += interval;
  await getLatestVersion("latest", { background: true });
  expect(exec).toHaveBeenCalledTimes(2);
  now += interval;
  exec.mockResolvedValue({ code: 0, stdout: "0.19.0\n", stderr: "" });
  expect(await getLatestVersion("latest", { background: true })).toBe("0.19.0");
  expect(exec).toHaveBeenCalledTimes(3);
  expect(await getLatestVersion("latest")).toBe("0.19.0");
  expect(exec).toHaveBeenCalledTimes(4);
});
