import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../bin/agenc-main.js";

describe("agenc permissions top-level dispatch", () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
  });

  it("routes agenc permissions before prompt/TUI routing", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    process.argv = [
      "/usr/bin/node",
      "/opt/agenc/bin/agenc.js",
      "permissions",
      "--help",
    ];

    await expect(main()).resolves.toBe(0);
    const stdout = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(stdout).toContain("Usage: agenc permissions <command>");
    expect(stdout).toContain("approve [--persist user] <rule>");
    expect(stdout).not.toContain(
      "approve [--persist <user|project|local>] <rule>",
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
