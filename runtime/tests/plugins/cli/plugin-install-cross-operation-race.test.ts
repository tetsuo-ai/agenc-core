import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const rmGate = vi.hoisted(() => ({
  target: undefined as string | undefined,
  during: undefined as undefined | (() => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      const during = rmGate.during;
      if (during !== undefined && rmGate.target !== undefined && resolve(String(path)) === rmGate.target) {
        rmGate.during = undefined;
        await during();
      }
      return actual.rm(path, options);
    },
  };
});

import { PluginInstallTransactionSimulatedCrash } from "../../../src/plugins/cli/plugin-install-transaction.js";
import { installPluginOp, updatePluginOp } from "../../../src/plugins/cli/pluginOperations.js";
import { loadPlugins } from "../../../src/plugins/loader.js";

type Outcome =
  | { readonly ok: true; readonly version: string | undefined }
  | { readonly ok: false; readonly error: unknown };

interface DirectoryLockWaitModule {
  setPluginInstallDirectoryLockWaitHook(hook: (() => void) | undefined): void;
}

const DIRECTORY_LOCK_SPECIFIER = "../../../src/plugins/cli/plugin-install-directory-lock" + ".ts";

function directoryLockSourceExists(): boolean {
  return existsSync(fileURLToPath(new URL(DIRECTORY_LOCK_SPECIFIER, import.meta.url)));
}

async function writePlugin(root: string, version: string): Promise<string> {
  const pluginRoot = join(root, `demo-${version}`);
  await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".agenc-plugin", "plugin.json"),
    `${JSON.stringify({ name: "demo", version, description: `demo ${version}`, commands: "./commands" })}\n`,
  );
  await mkdir(join(pluginRoot, "commands"), { recursive: true });
  await writeFile(join(pluginRoot, "commands", "hello.md"), `# Hello ${version}\n`);
  return pluginRoot;
}

async function version(pluginRoot: string): Promise<string | undefined> {
  try {
    return (JSON.parse(await readFile(join(pluginRoot, ".agenc-plugin", "plugin.json"), "utf8")) as { version?: string }).version;
  } catch (error) {
    return `<${(error as NodeJS.ErrnoException).code}>`;
  }
}

describe("plugin install recovery vs a concurrent operation on the same plugin", () => {
  it("never reports a successful update whose result recovery then removes", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugin-race-"));
    const agencHome = join(root, "home");
    const workspaceRoot = join(root, "workspace");
    const pluginStorageRoot = join(agencHome, "plugins");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(pluginStorageRoot, { recursive: true });
    const authority = {
      agencHome,
      pluginStorageRoot,
      sessionTempRoot: join(agencHome, "tmp"),
      workspaceRoot,
      env: Object.freeze({}) as NodeJS.ProcessEnv,
    };

    const v1 = await installPluginOp({ ...authority, source: await writePlugin(root, "1.0.0") });
    const destination = resolve(v1.destination);

    await expect(updatePluginOp({
      ...authority,
      pluginId: "demo",
      source: await writePlugin(root, "2.0.0"),
      installTransactionHooks: {
        afterPhase: async (phase) => {
          if (phase === "config-published") throw new PluginInstallTransactionSimulatedCrash(phase);
        },
      },
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);
    expect(await version(destination)).toBe("2.0.0");

    // The second update starts inside recovery's identity-check → rm window.
    // With a directory lock, it blocks until recovery releases that lock.
    // Without one, it can finish inside the window and recovery then removes it.
    let second: Promise<Outcome> | undefined;
    let barrierError: unknown;
    const source3 = await writePlugin(root, "3.0.0");
    const lockReady = directoryLockSourceExists()
      ? await import(DIRECTORY_LOCK_SPECIFIER) as DirectoryLockWaitModule
      : undefined;
    rmGate.target = destination;
    rmGate.during = async () => {
      try {
        if (lockReady !== undefined) {
          const reached = new Promise<void>((resolveBarrier, rejectBarrier) => {
            const timer = setTimeout(() => {
              lockReady.setPluginInstallDirectoryLockWaitHook(undefined);
              rejectBarrier(new Error("did not reach the lock"));
            }, 10_000);
            lockReady.setPluginInstallDirectoryLockWaitHook(() => {
              clearTimeout(timer);
              lockReady.setPluginInstallDirectoryLockWaitHook(undefined);
              resolveBarrier();
            });
          });
          second = updatePluginOp({ ...authority, pluginId: "demo", source: source3 }).then(
            (result): Outcome => ({ ok: true, version: result.plugin.version }),
            (error: unknown): Outcome => ({ ok: false, error }),
          );
          await reached;
          return;
        }
        second = updatePluginOp({ ...authority, pluginId: "demo", source: source3 }).then(
          (result): Outcome => ({ ok: true, version: result.plugin.version }),
          (error: unknown): Outcome => ({ ok: false, error }),
        );
        await second;
      } catch (error) {
        barrierError = error;
        throw error;
      }
    };

    try {
      const loaded = await loadPlugins({
        pluginStorageRoot,
        workspaceRoot,
        config: { plugins: { enabled: true } },
        userConfigPath: join(agencHome, "config.toml"),
      });
      if (barrierError !== undefined) throw barrierError;
      expect(second).toBeDefined();
      const outcome = await second!;
      const finalVersion = await version(destination);

      console.log(JSON.stringify({
        secondUpdate: outcome.ok ? "resolved" : `rejected: ${String((outcome.error as Error)?.message ?? outcome.error)}`,
        recoveryIssues: loaded.errors.filter((issue) => issue.type === "install-recovery").map((issue) => issue.message),
        finalVersion,
      }, null, 2));

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw outcome.error;
      expect(outcome.version).toBe("3.0.0");
      expect(finalVersion).toBe("3.0.0");
    } finally {
      lockReady?.setPluginInstallDirectoryLockWaitHook(undefined);
    }
  });
});
