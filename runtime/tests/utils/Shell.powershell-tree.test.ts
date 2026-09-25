import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ConfigStore } from "../../src/config/store.js";
import { runWithCurrentRuntimeSession } from "../../src/session/current-session.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Session } from "../../src/session/session.js";
import { runWithCwdOverride } from "../../src/utils/cwd.js";
import { exec } from "../../src/utils/Shell.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { waitUntilProcessGone } from "../helpers/shell-backed-pty.js";

// The PowerShell provider spawned its shell without its own process group.
// Stopping the command then relied on the process-table snapshot to find the
// shell's children: when that snapshot failed (a full descriptor table, a
// missing ps), -pid did not exist, only the shell itself was killed, and
// everything it had started kept running. "pwsh" here is a small POSIX
// script that starts a background sleep and waits.

const { fakePwsh } = vi.hoisted(() => ({
  fakePwsh: { path: undefined as string | undefined },
}));

vi.mock("../../src/utils/shell/powershellDetection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/shell/powershellDetection.js")>()),
  getCachedPowerShellPath: async () => fakePwsh.path ?? null,
}));
// The process table cannot be read: ps fails on darwin, /proc on linux.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

const actualChildProcess = await vi.importActual<typeof import("node:child_process")>(
  "node:child_process",
);
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

function failProcessTableReads(): void {
  vi.mocked(childProcess.spawnSync).mockImplementation(((command: string, ...rest: unknown[]) =>
    command === "/bin/ps"
      ? {
          pid: 0,
          output: [],
          stdout: "",
          stderr: "",
          status: null,
          signal: null,
          error: Object.assign(new Error("spawnSync /bin/ps EMFILE"), { code: "EMFILE" }),
        }
      : (actualChildProcess.spawnSync as (...args: unknown[]) => unknown)(command, ...rest)) as typeof childProcess.spawnSync);
  vi.mocked(fs.readdirSync).mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
    if (String(path) === "/proc") {
      throw Object.assign(new Error("EMFILE: too many open files, scandir '/proc'"), {
        code: "EMFILE",
      });
    }
    return (actualFs.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readdirSync);
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.mocked(childProcess.spawnSync).mockImplementation(actualChildProcess.spawnSync);
  vi.mocked(fs.readdirSync).mockImplementation(actualFs.readdirSync);
  fakePwsh.path = undefined;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("PowerShell command termination", () => {
  test.skipIf(process.platform === "win32")(
    "kill() stops the command's children when the process table cannot be read",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agenc-pwsh-tree-"));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const pidFile = join(root, "child.pid");
      fakePwsh.path = join(root, "pwsh");
      await writeFile(
        fakePwsh.path,
        `#!/bin/sh\nsleep 30 >/dev/null 2>&1 &\necho $! > ${JSON.stringify(pidFile)}\nwait\n`,
        "utf8",
      );
      await chmod(fakePwsh.path, 0o755);
      const configStore = new ConfigStore({
        home: join(root, ".agenc-test-home"),
        env: {},
        cwd: root,
        projectRoot: root,
        projectTrusted: false,
      });
      const runtimeSession = {
        conversationId: "00000000-0000-4000-8000-000000000331",
        services: {
          configStore,
          runtimeOptions: resolveAgentRuntimeOptions({}),
          userShell: {
            path: "/bin/sh",
            commandWrapperArgv: [],
            childEnvironment: { ...process.env },
            deriveExecArgs: (input: string) => ["-c", input],
          },
        },
      } as unknown as Session;

      let grandchild: number | undefined;
      cleanups.push(() => {
        if (grandchild === undefined) return;
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          // Already gone.
        }
      });
      await runWithCanonicalSettingsAuthority(configStore, () =>
        runWithCurrentRuntimeSession(runtimeSession, () =>
          runWithCwdOverride(root, async () => {
            const shellCommand = await exec(
              "Start-Sleep 30",
              new AbortController().signal,
              "powershell",
              { preventCwdChanges: true },
            );
            await vi.waitFor(
              async () => {
                grandchild = Number((await readFile(pidFile, "utf8")).trim());
                expect(Number.isSafeInteger(grandchild)).toBe(true);
              },
              { timeout: 5_000, interval: 20 },
            );

            failProcessTableReads();
            shellCommand.kill();
            await shellCommand.result;

            expect(await waitUntilProcessGone(grandchild!, 3_000)).toBe(true);
            shellCommand.cleanup();
          }),
        ),
      );
    },
    20_000,
  );
});
