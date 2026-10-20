import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { SandboxExecutionBroker, attachSandboxExecutionBroker } from "../../../src/sandbox/execution-broker.js";
import { INHERITED_CWD_SANDBOX_PATH } from "../../../src/sandbox/linux-launcher/config.js";
import { createGlobTool } from "../../../src/tools/system/glob.js";
import { createGrepTool } from "../../../src/tools/system/grep.js";
import { __boundReadDirectLaunchesForTests, __disposeIdleReadHelpersForTests } from "../../../src/workspace/file-mutation-transaction.js";

const runtimeRoot = fileURLToPath(new URL("../../../", import.meta.url));
const launcherEntry = join(runtimeRoot, "bin", "agenc-linux-sandbox");

/**
 * Descriptor-bound Grep and Glob start bubblewrap from the authenticated
 * helper with the launch the daemon planned from the launcher's own
 * arguments: same filesystem view (narrow or whole-disk read), the held
 * directory from descriptor 4, the network seccomp program from descriptor 3,
 * no network, and ripgrep exec'd directly. An exchanged pathname still cannot
 * redirect the search.
 */
test.each([["narrow", false], ["narrow", true], ["whole-disk", false], ["whole-disk", true]] as const)(
  "runs production bound searches through a planned bubblewrap launch (%s read, exchange=%s)",
  { timeout: 60_000 },
  async (mode, exchange) => {
    await __disposeIdleReadHelpersForTests();
    const root = realpathSync(mkdtempSync("/var/tmp/agenc-bound-launch-kernel-"));
    const cwd = join(root, "workspace");
    const temporary = join(root, "temp");
    const outside = join(root, "outside");
    mkdirSync(cwd); mkdirSync(temporary); mkdirSync(outside);
    mkdirSync(join(cwd, "nested"));
    writeFileSync(join(cwd, "readable.txt"), "needle public\n");
    writeFileSync(join(cwd, "nested", "deeper.txt"), "needle nested\n");
    writeFileSync(join(outside, "outside.txt"), "needle outside\n");
    const environment = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, AGENC_HOME: join(root, "home") };
    try {
      const entries = mode === "narrow"
        ? [
            { path: { kind: "path" as const, path: cwd }, access: "write" as const },
            { path: { kind: "path" as const, path: dirname(runtimeRoot) }, access: "read" as const },
            { path: { kind: "path" as const, path: dirname(process.execPath) }, access: "read" as const },
            { path: { kind: "path" as const, path: temporary }, access: "write" as const },
          ]
        : [
            { path: { kind: "special" as const, value: { kind: "root" as const } }, access: "read" as const },
            { path: { kind: "path" as const, path: cwd }, access: "write" as const },
            { path: { kind: "path" as const, path: temporary }, access: "write" as const },
          ];
      const broker = new SandboxExecutionBroker({
        mode: "workspace_write", cwd, env: environment, sessionTempRoot: temporary, agencLinuxSandboxExe: launcherEntry,
        permissionProfile: { fileSystem: { kind: "restricted", includePlatformDefaults: true, entries }, network: "disabled" },
      });
      expect(broker.status().kind).toBe("ready");
      const before = __boundReadDirectLaunchesForTests().count;
      for (const name of ["Grep", "Glob"] as const) {
        const config = { allowedPaths: [cwd], ...(exchange ? { __testAfterFinalPathCheck: async () => {
          renameSync(cwd, join(root, "displaced"));
          symlinkSync(outside, cwd, "dir");
        } } : {}) };
        const tool = name === "Glob" ? createGlobTool(config) : createGrepTool(config);
        const args: Record<string, unknown> = { pattern: name === "Glob" ? "**/*.txt" : "needle", path: cwd,
          includeIgnored: true, ...(name === "Grep" ? { output_mode: "content" } : {}) };
        attachSandboxExecutionBroker(args, broker);
        const result = await tool.execute(args);
        if (exchange) {
          renameSync(cwd, join(root, `exchanged-${name}`));
          renameSync(join(root, "displaced"), cwd);
        }
        expect(result.isError, String(result.content)).not.toBe(true);
        expect(result.content).toContain("readable.txt");
        expect(result.content).toContain("deeper.txt");
        expect(result.content).not.toContain("outside.txt");
      }
      const launches = __boundReadDirectLaunchesForTests();
      expect(launches.count).toBe(before + 2);
      const args = launches.last!.args;
      const separator = args.indexOf("--");
      const flags = args.slice(0, separator);
      expect(args[separator + 1]).not.toBe(process.execPath);
      expect(args[separator + 1]).toMatch(/\/rg$/u);
      for (const required of [["--ro-bind-fd", "4", INHERITED_CWD_SANDBOX_PATH], ["--chdir", INHERITED_CWD_SANDBOX_PATH],
        ["--seccomp", "3"], ["--unshare-net"], ["--unshare-pid"], ["--unshare-user"], ["--die-with-parent"], ["--new-session"]]) {
        const at = flags.indexOf(required[0]!);
        expect(at, required.join(" ")).toBeGreaterThanOrEqual(0);
        expect(flags.slice(at, at + required.length)).toEqual(required);
      }
      expect(flags).not.toContain("--bind");
      expect(flags).not.toContain("--dev-bind");
      if (mode === "narrow") expect(flags.join(" ")).not.toContain("--ro-bind / /");
      else expect(flags.join(" ")).toContain("--ro-bind / /");
    } finally {
      await __disposeIdleReadHelpersForTests();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
