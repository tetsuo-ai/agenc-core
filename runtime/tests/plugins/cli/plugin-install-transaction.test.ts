import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const durableControl = vi.hoisted(() => ({
  failRecordPath: undefined as string | undefined,
}));

const renameGate = vi.hoisted(() => ({
  before: undefined as undefined | ((from: string, to: string) => Promise<void>),
}));

vi.mock("../../../src/utils/durable-atomic-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/utils/durable-atomic-file.js")>();
  return {
    ...actual,
    writeDurableAtomicFile: async (
      ...args: Parameters<typeof actual.writeDurableAtomicFile>
    ) => {
      if (durableControl.failRecordPath !== undefined && args[0] === durableControl.failRecordPath) {
        durableControl.failRecordPath = undefined;
        throw Object.assign(new Error("injected EIO writing committed record"), { code: "EIO" });
      }
      return actual.writeDurableAtomicFile(...args);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (
      from: Parameters<typeof actual.rename>[0],
      to: Parameters<typeof actual.rename>[1],
    ) => {
      if (renameGate.before === undefined) return actual.rename(from, to);
      return (async () => {
        await renameGate.before?.(String(from), String(to));
        await actual.rename(from, to);
      })();
    },
  };
});

import { parseToml } from "../../../src/config/loader.js";
import {
  PluginInstallTransactionSimulatedCrash,
  recoverPluginInstallTransactions,
  type PluginInstallTransactionHooks,
  type PluginInstallTransactionPhase,
} from "../../../src/plugins/cli/plugin-install-transaction.js";
import {
  installPluginOp,
  listInstalledPlugins,
  updatePluginOp,
  type PluginOperationOptions,
} from "../../../src/plugins/cli/pluginOperations.js";
import { loadPlugins } from "../../../src/plugins/loader.js";

interface ParsedPluginsConfig {
  readonly plugins?: {
    readonly enabled?: unknown;
    readonly plugins?: Readonly<Record<string, { readonly enabled?: unknown }>>;
  };
}

interface TxnWorld {
  readonly root: string;
  readonly agencHome: string;
  readonly workspaceRoot: string;
  readonly pluginStorageRoot: string;
  readonly authority: PluginOperationOptions;
}

interface InstalledDemo extends TxnWorld {
  readonly destination: string;
}

type UpdateFailureKind = "no-stage" | "id-version" | "config-enabled";

function throwBefore(
  hook: "beforeWriteMetadata" | "beforeValidate" | "beforePublishConfig",
  message: string,
): PluginInstallTransactionHooks {
  return { [hook]: async () => { throw new Error(message); } };
}

const UPDATE_PRECOMMIT_FAILURES: readonly {
  readonly title: string;
  readonly error: RegExp;
  readonly hooks: PluginInstallTransactionHooks;
  readonly assertExtra: UpdateFailureKind;
}[] = [
  {
    title: "keeps version 1 installed when metadata writing fails during update",
    error: /metadata write failed/u,
    hooks: throwBefore("beforeWriteMetadata", "metadata write failed"),
    assertExtra: "no-stage",
  },
  {
    title: "keeps version 1 installed when staged-copy validation fails during update",
    error: /installed plugin failed validation/u,
    hooks: throwBefore("beforeValidate", "installed plugin failed validation"),
    assertExtra: "id-version",
  },
  {
    title: "keeps version 1 installed when plugin-config persistence fails during update",
    error: /plugin config write failed/u,
    hooks: throwBefore("beforePublishConfig", "plugin config write failed"),
    assertExtra: "config-enabled",
  },
];

const FIRST_INSTALL_PRECOMMIT_FAILURES: readonly {
  readonly hookName: string;
  readonly hooks: PluginInstallTransactionHooks;
}[] = [
  { hookName: "metadata", hooks: throwBefore("beforeWriteMetadata", "metadata write failed") },
  { hookName: "validation", hooks: throwBefore("beforeValidate", "installed plugin failed validation") },
  { hookName: "config", hooks: throwBefore("beforePublishConfig", "plugin config write failed") },
];

async function symlinkedStorageWorld(): Promise<TxnWorld> {
  const world = await createWorld();
  const realStorage = join(world.root, "real-plugins");
  await mkdir(realStorage, { recursive: true });
  await rm(world.pluginStorageRoot, { recursive: true });
  await symlink(realStorage, world.pluginStorageRoot);
  return world;
}

async function loadRecoveryIssues(world: TxnWorld) {
  const loaded = await loadPlugins({
    pluginStorageRoot: world.pluginStorageRoot,
    workspaceRoot: world.workspaceRoot,
    config: { plugins: { enabled: true } },
    userConfigPath: join(world.agencHome, "config.toml"),
  });
  return loaded.errors.filter((issue) => issue.type === "install-recovery");
}

async function createWorld(): Promise<TxnWorld> {
  const root = await mkdtemp(join(tmpdir(), "agenc-plugin-install-txn-"));
  const agencHome = join(root, "home");
  const workspaceRoot = join(root, "workspace");
  const pluginStorageRoot = join(agencHome, "plugins");
  await mkdir(agencHome, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(pluginStorageRoot, { recursive: true });
  return {
    root,
    agencHome,
    workspaceRoot,
    pluginStorageRoot,
    authority: {
      agencHome,
      pluginStorageRoot,
      sessionTempRoot: join(agencHome, "tmp"),
      workspaceRoot,
      env: Object.freeze({}) as NodeJS.ProcessEnv,
    },
  };
}

async function writeArtworkPlugin(root: string, version: string): Promise<string> {
  const source = join(root, `alpha-${version}`);
  await mkdir(join(source, ".agenc-plugin"), { recursive: true });
  await mkdir(join(source, "assets"), { recursive: true });
  await mkdir(join(source, "commands"), { recursive: true });
  await writeFile(join(source, "commands", "hello.md"), "# Hello\n");
  for (const name of ["logo.png", "screen.png", "icon.png"]) {
    await writeFile(join(source, "assets", name), name);
  }
  await writeFile(join(source, ".agenc-plugin", "plugin.json"), `${JSON.stringify({
    name: "alpha",
    version,
    commands: "./commands",
    interface: {
      logo: "./assets/logo.png",
      screenshots: ["./assets/screen.png"],
      composerIcon: "./assets/icon.png",
    },
  })}\n`);
  return source;
}

async function writeManifest(
  pluginRoot: string,
  name: string,
  version: string,
  description?: string,
): Promise<void> {
  await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".agenc-plugin", "plugin.json"),
    `${JSON.stringify({
      name,
      version,
      ...(description === undefined ? {} : { description }),
      commands: "./commands",
    }, null, 2)}\n`,
  );
}

async function writePlugin(
  root: string,
  name: string,
  version: string,
): Promise<string> {
  const pluginRoot = join(root, `${name}-${version}`);
  await writeManifest(pluginRoot, name, version, `${name} ${version}`);
  await mkdir(join(pluginRoot, "commands"), { recursive: true });
  await writeFile(join(pluginRoot, "commands", "hello.md"), `# Hello ${version}\n`);
  return pluginRoot;
}

async function installDemoV1(): Promise<InstalledDemo> {
  const world = await createWorld();
  const first = await installPluginOp({
    ...world.authority,
    source: await writePlugin(world.root, "demo", "1.0.0"),
  });
  return { ...world, destination: first.destination };
}

async function updateDemo(
  world: TxnWorld,
  hooks?: PluginInstallTransactionHooks,
) {
  return updatePluginOp({
    ...world.authority,
    pluginId: "demo",
    source: await writePlugin(world.root, "demo", "2.0.0"),
    ...(hooks === undefined ? {} : { installTransactionHooks: hooks }),
  });
}

async function installFresh(
  world: TxnWorld,
  name: string,
  hooks: PluginInstallTransactionHooks,
) {
  return installPluginOp({
    ...world.authority,
    source: await writePlugin(world.root, "fresh", "1.0.0"),
    name,
    installTransactionHooks: hooks,
  });
}

function crashAfter(
  phase: PluginInstallTransactionPhase,
): PluginInstallTransactionHooks {
  return {
    afterPhase: async (current) => {
      if (current === phase) {
        throw new PluginInstallTransactionSimulatedCrash(phase);
      }
    },
  };
}

async function crashDemoUpdate(
  installed: InstalledDemo,
  phase: PluginInstallTransactionPhase,
): Promise<InstalledDemo> {
  await expect(updateDemo(installed, crashAfter(phase)))
    .rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);
  return installed;
}

async function expectIdentityChangeRejected(
  installed: InstalledDemo,
  path: string,
  destinationVersion: string,
  tamperedVersion: string,
): Promise<void> {
  const recovery = await recoverLocal(installed);
  expect(recovery.recovered).toBe(0);
  expect(recovery.issues.some((issue) => /identity changed/u.test(issue.message))).toBe(true);
  expect(await readPluginVersion(installed.destination)).toBe(destinationVersion);
  expect(await readPluginVersion(path)).toBe(tamperedVersion);
  expect(await pathExists(path)).toBe(true);
}

async function readPluginVersion(pluginRoot: string): Promise<string | undefined> {
  const raw = JSON.parse(
    await readFile(join(pluginRoot, ".agenc-plugin", "plugin.json"), "utf8"),
  ) as { readonly version?: string };
  return raw.version;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function storageNames(world: TxnWorld): Promise<string[]> {
  try {
    return (await readdir(world.pluginStorageRoot)).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function namesInclude(names: readonly string[], ...tokens: readonly string[]): boolean {
  return names.some((name) => tokens.some((token) => name.includes(token)));
}

async function listedVersions(world: TxnWorld): Promise<string[]> {
  const listed = await listInstalledPlugins(world.authority);
  return listed.plugins.map((plugin) => plugin.version).filter((version): version is string =>
    version !== undefined
  );
}

async function demoEnabledInConfig(world: TxnWorld): Promise<boolean> {
  const parsed = parseToml(
    await readFile(join(world.agencHome, "config.toml"), "utf8"),
  ) as ParsedPluginsConfig;
  return parsed.plugins?.plugins?.demo?.enabled === true;
}

async function requireStorageChild(world: TxnWorld, token: string): Promise<string> {
  const name = (await storageNames(world)).find((child) => child.includes(token));
  expect(name).toBeDefined();
  return join(world.pluginStorageRoot, name!);
}

async function tamperManifest(pluginRoot: string, version: string): Promise<void> {
  await writeManifest(pluginRoot, "demo", version);
}

async function recoverLocal(world: TxnWorld) {
  return recoverPluginInstallTransactions({
    installRoots: [world.pluginStorageRoot],
  });
}

async function assertUpdateFailureExtra(
  installed: InstalledDemo,
  kind: UpdateFailureKind,
): Promise<void> {
  switch (kind) {
    case "no-stage":
      expect(namesInclude(await storageNames(installed), ".stage-")).toBe(false);
      return;
    case "id-version": {
      const listed = await listInstalledPlugins(installed.authority);
      expect(listed.plugins.map((plugin) => `${plugin.id}@${plugin.version}`)).toEqual([
        "demo@1.0.0",
      ]);
      return;
    }
    case "config-enabled":
      expect(await demoEnabledInConfig(installed)).toBe(true);
      return;
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled update failure assertion: ${String(exhaustive)}`);
    }
  }
}

describe("plugin install transaction", () => {
  for (const failure of UPDATE_PRECOMMIT_FAILURES) {
    it(failure.title, async () => {
      const installed = await installDemoV1();
      await expect(updateDemo(installed, failure.hooks)).rejects.toThrow(failure.error);
      expect(await readPluginVersion(installed.destination)).toBe("1.0.0");
      expect(await listedVersions(installed)).toEqual(["1.0.0"]);
      await assertUpdateFailureExtra(installed, failure.assertExtra);
    });
  }

  it("leaves no discoverable directory when first-install metadata, validation, or config writes fail", async () => {
    const world = await createWorld();
    for (const failure of FIRST_INSTALL_PRECOMMIT_FAILURES) {
      await expect(installFresh(world, `fresh-${failure.hookName}`, failure.hooks)).rejects.toThrow();
      const listed = await listInstalledPlugins(world.authority);
      expect(listed.plugins.map((plugin) => plugin.id), failure.hookName)
        .not.toContain(`fresh-${failure.hookName}`);
      expect(
        namesInclude(await storageNames(world), `fresh-${failure.hookName}`, ".stage-", ".bak-"),
        failure.hookName,
      ).toBe(false);
    }
  });

  it("removes the update backup only after the new directory and configuration are durable", async () => {
    const installed = await installDemoV1();
    let backupAtConfigPublished: string | undefined;
    let backupExistedAtConfigPublished = false;
    const updated = await updateDemo(installed, {
      afterPhase: async (phase, context) => {
        if (phase !== "config-published") return;
        backupAtConfigPublished = context.backupPath;
        backupExistedAtConfigPublished = context.backupPath !== undefined &&
          await pathExists(context.backupPath);
      },
    });

    expect(backupAtConfigPublished).toEqual(expect.stringContaining(".bak-"));
    expect(backupExistedAtConfigPublished).toBe(true);
    expect(backupAtConfigPublished !== undefined && await pathExists(backupAtConfigPublished))
      .toBe(false);
    expect(await readPluginVersion(updated.destination)).toBe("2.0.0");
    expect(await demoEnabledInConfig(installed)).toBe(true);
    expect(namesInclude(await storageNames(installed), ".bak-")).toBe(false);
  });

  it("recovers version 1 after a crash between destination backup and replacement", async () => {
    const installed = await crashDemoUpdate(await installDemoV1(), "destination-backed-up");
    expect(await pathExists(installed.destination)).toBe(false);
    expect(namesInclude(await storageNames(installed), ".bak-")).toBe(true);
    expect(await listedVersions(installed)).toEqual(["1.0.0"]);
    expect(await readPluginVersion(installed.destination)).toBe("1.0.0");
    expect(namesInclude(await storageNames(installed), ".bak-", ".stage-")).toBe(false);
  });

  it("recovers version 1 after a crash between destination replacement and config publication", async () => {
    const installed = await crashDemoUpdate(await installDemoV1(), "destination-replaced");
    expect(await readPluginVersion(installed.destination)).toBe("2.0.0");
    expect(await listedVersions(installed)).toEqual(["1.0.0"]);
    expect(await readPluginVersion(installed.destination)).toBe("1.0.0");
    expect(await demoEnabledInConfig(installed)).toBe(true);
  });

  it("restores version 1 after a crash once config is published but before the commit record", async () => {
    const installed = await crashDemoUpdate(await installDemoV1(), "config-published");
    expect(await readPluginVersion(installed.destination)).toBe("2.0.0");
    expect(namesInclude(await storageNames(installed), ".bak-")).toBe(true);
    expect(await listedVersions(installed)).toEqual(["1.0.0"]);
    expect(await readPluginVersion(installed.destination)).toBe("1.0.0");
    expect(await demoEnabledInConfig(installed)).toBe(true);
    expect(namesInclude(await storageNames(installed), ".bak-")).toBe(false);
  });

  for (
    const crash of [
      {
        title: "recovers a first install that crashed after destination replacement by removing it",
        phase: "destination-replaced" as const,
        leftoverBefore: "fresh",
        leftoverAfter: [".stage-", ".bak-", "fresh"] as const,
      },
      {
        title: "recovers a first install that crashed after staging by removing the stage",
        phase: "stage-ready" as const,
        leftoverBefore: ".stage-",
        leftoverAfter: [".stage-", "fresh"] as const,
      },
    ]
  ) {
    it(crash.title, async () => {
      const world = await createWorld();
      await expect(installFresh(world, "fresh", crashAfter(crash.phase)))
        .rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);
      expect(namesInclude(await storageNames(world), crash.leftoverBefore)).toBe(true);
      expect((await listInstalledPlugins(world.authority)).plugins).toEqual([]);
      expect(namesInclude(await storageNames(world), ...crash.leftoverAfter)).toBe(false);
    });
  }

  it("rejects a changed backup instead of restoring or deleting it", async () => {
    const installed = await crashDemoUpdate(await installDemoV1(), "destination-replaced");
    const backupPath = await requireStorageChild(installed, ".bak-");
    await tamperManifest(backupPath, "1.0.0-tampered");
    await expectIdentityChangeRejected(installed, backupPath, "2.0.0", "1.0.0-tampered");
  });

  it("rejects a changed stage instead of deleting it", async () => {
    const installed = await crashDemoUpdate(await installDemoV1(), "stage-ready");
    const stagePath = await requireStorageChild(installed, ".stage-");
    await writeFile(join(stagePath, "commands", "hello.md"), "# tampered\n");
    await tamperManifest(stagePath, "2.0.0-tampered");
    await expectIdentityChangeRejected(installed, stagePath, "1.0.0", "2.0.0-tampered");
  });

  it("does not discover stage or backup directories as installed plugins", async () => {
    const installed = await crashDemoUpdate(await installDemoV1(), "destination-replaced");
    expect(namesInclude(await storageNames(installed), ".bak-")).toBe(true);
    expect(await readPluginVersion(installed.destination)).toBe("2.0.0");
    const loaded = await loadPlugins({
      pluginStorageRoot: installed.pluginStorageRoot,
      workspaceRoot: installed.workspaceRoot,
      config: { plugins: { enabled: true } },
      readOnly: true,
    });
    expect(loaded.enabled.map((plugin) => plugin.version)).toEqual(["2.0.0"]);
    expect(loaded.enabled).toHaveLength(1);
  });

  it("does not roll back an install that still holds its lease", async () => {
    const installed = await installDemoV1();
    let recovery: Awaited<ReturnType<typeof recoverLocal>> | undefined;
    const updated = await updateDemo(installed, {
      beforeValidate: async () => {
        recovery = await recoverLocal(installed);
      },
    });
    expect(recovery?.recovered).toBe(0);
    expect(recovery?.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining("lease is still live"),
    ]);
    expect(updated.plugin.version).toBe("2.0.0");
    expect(await readPluginVersion(installed.destination)).toBe("2.0.0");
  });

  it("restores plugin config when publication is rolled back", async () => {
    const installed = await installDemoV1();
    expect(await demoEnabledInConfig(installed)).toBe(true);
    await expect(updateDemo(installed, {
      beforePublishConfig: async () => {
        const configPath = join(installed.agencHome, "config.toml");
        const raw = await readFile(configPath, "utf8");
        await writeFile(configPath, raw.replace("enabled = true", "enabled = false"));
        throw new Error("plugin config write failed");
      },
    })).rejects.toThrow(/plugin config write failed/u);
    expect(await readPluginVersion(installed.destination)).toBe("1.0.0");
    expect(await demoEnabledInConfig(installed)).toBe(true);
  });

  it("reports an unreadable install operation directory as a load issue", async () => {
    const world = await createWorld();
    await writeFile(join(world.pluginStorageRoot, ".plugin-install-ops"), "not-a-directory");
    const loaded = await loadPlugins({
      pluginStorageRoot: world.pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    expect(loaded.errors.some((issue) => issue.type === "install-recovery")).toBe(true);
  });

  it("ignores forged recovery records that escape the plugin storage root", async () => {
    const world = await createWorld();
    const outside = await mkdtemp(join(world.root, "outside-"));
    await writeFile(join(outside, "keep"), "stay");
    const traversal = join(world.pluginStorageRoot, "..", "outside-dotdot");
    await mkdir(traversal, { recursive: true });
    await writeFile(join(traversal, "keep"), "stay");
    const linkOutside = await mkdtemp(join(world.root, "link-target-"));
    await writeFile(join(linkOutside, "keep"), "stay");
    const linkPath = join(world.pluginStorageRoot, "linked-plugin");
    await symlink(linkOutside, linkPath);

    await writeForgedRecord(world, "absolute", outside);
    await writeForgedRecord(world, "traversal", traversal);
    await writeForgedRecord(world, "symlink", linkPath);
    const recovery = await recoverLocal(world);
    expect(recovery.recovered).toBe(0);
    expect(recovery.issues.map((issue) => issue.message).join("\n")).toMatch(/outside the plugin storage root/u);
    await expect(readFile(join(outside, "keep"), "utf8")).resolves.toBe("stay");
    await expect(readFile(join(traversal, "keep"), "utf8")).resolves.toBe("stay");
    await expect(readFile(join(linkOutside, "keep"), "utf8")).resolves.toBe("stay");
  });

  it("keeps the lease until in-process rollback finishes", async () => {
    const installed = await installDemoV1();
    let releaseRollback: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRollback = resolve;
    });
    let opened = () => {};
    const openedGate = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const pending = updateDemo(installed, {
      beforePublishConfig: async () => {
        throw new Error("hold rollback");
      },
      beforeRollback: async () => {
        opened();
        await gate;
      },
    });
    await openedGate;
    const during = await recoverLocal(installed);
    expect(during.recovered).toBe(0);
    expect(during.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining("lease is still live"),
    ]);
    expect(await readPluginVersion(installed.destination)).toBe("2.0.0");
    releaseRollback();
    await expect(pending).rejects.toThrow(/hold rollback/u);
    expect(await readPluginVersion(installed.destination)).toBe("1.0.0");
  });

  it("restores version 1 after a crash at destination-replace-intended", async () => {
    const installed = await crashDemoUpdate(await installDemoV1(), "destination-replace-intended");
    expect(await listedVersions(installed)).toEqual(["1.0.0"]);
    expect(await readPluginVersion(installed.destination)).toBe("1.0.0");
    expect(namesInclude(await storageNames(installed), ".bak-", ".stage-")).toBe(false);
  });

  it("rolls back when the stage rename fails in process", async () => {
    const installed = await installDemoV1();
    await expect(updateDemo(installed, {
      beforeRename: async (phase) => {
        if (phase === "destination-replace-intended") throw new Error("stage rename failed");
      },
    })).rejects.toThrow(/stage rename failed/u);
    expect(await readPluginVersion(installed.destination)).toBe("1.0.0");
    expect(namesInclude(await storageNames(installed), ".bak-", ".stage-")).toBe(false);
  });

  it("restores version 1 after a backup rename and after a crash before that rename", async () => {
    const afterRename = await installDemoV1();
    await expect(updateDemo(afterRename, {
      afterDirectoryRename: async (phase) => {
        if (phase === "destination-backup-intended") {
          throw new PluginInstallTransactionSimulatedCrash("destination-backup-intended");
        }
      },
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);
    expect(await listedVersions(afterRename)).toEqual(["1.0.0"]);
    expect(await readPluginVersion(afterRename.destination)).toBe("1.0.0");

    const beforeRename = await crashDemoUpdate(await installDemoV1(), "destination-backup-intended");
    expect(await listedVersions(beforeRename)).toEqual(["1.0.0"]);
    expect(await readPluginVersion(beforeRename.destination)).toBe("1.0.0");
    expect(namesInclude(await storageNames(beforeRename), ".stage-")).toBe(false);
  });

  it("finishes a backup restore that crashed after the new destination was removed", async () => {
    const installed = await crashDemoUpdate(await installDemoV1(), "destination-replaced");
    await expect(recoverPluginInstallTransactions({
      installRoots: [installed.pluginStorageRoot],
      hooks: {
        afterRollbackDestinationRemoved: async () => {
          throw new PluginInstallTransactionSimulatedCrash("rollback-restore-intended");
        },
      },
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);
    expect(await pathExists(installed.destination)).toBe(false);
    expect(namesInclude(await storageNames(installed), ".bak-")).toBe(true);
    const finished = await recoverLocal(installed);
    expect(finished.recovered).toBe(1);
    expect(await readPluginVersion(installed.destination)).toBe("1.0.0");
    expect(namesInclude(await storageNames(installed), ".bak-", ".stage-")).toBe(false);
  });

  it("reports a recovery throw from loadPlugins instead of rejecting", async () => {
    const world = await createWorld();
    await expect(installFresh(world, "fresh", crashAfter("destination-replaced")))
      .rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);
    await chmod(world.pluginStorageRoot, 0o555);
    try {
      const loaded = await loadPlugins({
        pluginStorageRoot: world.pluginStorageRoot,
        workspaceRoot: world.workspaceRoot,
        config: { plugins: { enabled: true } },
      });
      expect(loaded.errors.some((issue) => issue.type === "install-recovery")).toBe(true);
    } finally {
      await chmod(world.pluginStorageRoot, 0o700);
    }
  });

  it("restores a false global enabled flag after a failed first install", async () => {
    const world = await createWorld();
    await writeFile(join(world.agencHome, "config.toml"), "config_version = 2\n\n[plugins]\nenabled = false\n");
    await expect(installFresh(world, "fresh", {
      afterPublishConfig: async () => {
        throw new Error("publish failed");
      },
    })).rejects.toThrow(/publish failed/u);
    const raw = await readFile(join(world.agencHome, "config.toml"), "utf8");
    expect(raw).not.toContain("fresh");
    expect(raw).toContain("\"enabled\" = false");
    expect(raw).not.toContain("\"enabled\" = true");
    expect(raw).not.toContain("[\"plugins\".\"plugins\"]");
  });

  it("restores an absent global enabled flag without leaving empty plugin tables", async () => {
    const world = await createWorld();
    await writeFile(join(world.agencHome, "config.toml"), "config_version = 2\n");
    await expect(installFresh(world, "fresh", {
      afterPublishConfig: async () => {
        throw new Error("publish failed");
      },
    })).rejects.toThrow(/publish failed/u);
    const raw = await readFile(join(world.agencHome, "config.toml"), "utf8");
    expect(raw).not.toContain("fresh");
    expect(raw).not.toContain("enabled");
    expect(raw).not.toContain("[\"plugins\"]");
  });

  it("does not invent a config path when the storage root is outside the AgenC home", async () => {
    const world = await createWorld();
    const pluginStorageRoot = join(world.root, "separate-storage");
    await mkdir(pluginStorageRoot, { recursive: true });
    const separated = {
      ...world,
      pluginStorageRoot,
      authority: { ...world.authority, pluginStorageRoot },
    };
    const userConfig = join(world.agencHome, "config.toml");
    await writeFile(userConfig, "config_version = 2\n");
    await expect(installFresh(separated, "fresh", {
      afterPublishConfig: async () => {
        throw new PluginInstallTransactionSimulatedCrash("destination-replaced");
      },
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);
    const stray = join(world.root, "config.toml");
    await expect(access(stray)).rejects.toThrow();
    const untouched = await loadPlugins({
      pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    expect(untouched.errors.some((issue) =>
      issue.type === "install-recovery" && /plugin config not restored/u.test(issue.message),
    )).toBe(true);
    expect(await readFile(userConfig, "utf8")).toContain("fresh");
    const restoredWorld = await createWorld();
    const restoredStorage = join(restoredWorld.root, "separate-storage");
    await mkdir(restoredStorage, { recursive: true });
    const restoredHomeConfig = join(restoredWorld.agencHome, "config.toml");
    await writeFile(restoredHomeConfig, "config_version = 2\n");
    await expect(installFresh({
      ...restoredWorld,
      pluginStorageRoot: restoredStorage,
      authority: { ...restoredWorld.authority, pluginStorageRoot: restoredStorage },
    }, "fresh", {
      afterPublishConfig: async () => {
        throw new PluginInstallTransactionSimulatedCrash("destination-replaced");
      },
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);
    const restored = await loadPlugins({
      pluginStorageRoot: restoredStorage,
      workspaceRoot: restoredWorld.workspaceRoot,
      config: { plugins: { enabled: true } },
      userConfigPath: restoredHomeConfig,
    });
    expect(restored.errors.filter((issue) => issue.type === "install-recovery")).toEqual([]);
    expect(await readFile(restoredHomeConfig, "utf8")).not.toContain("fresh");
    await expect(access(join(restoredWorld.root, "config.toml"))).rejects.toThrow();
  });

  it("does not restore user config when the storage root is the workspace plugin directory", async () => {
    const world = await createWorld();
    const pluginStorageRoot = join(world.workspaceRoot, ".agents", "plugins");
    await mkdir(pluginStorageRoot, { recursive: true });
    const projectRooted = {
      ...world,
      pluginStorageRoot,
      authority: { ...world.authority, pluginStorageRoot },
    };
    const userConfig = join(world.agencHome, "config.toml");
    await writeFile(userConfig, "config_version = 2\n");
    await expect(installFresh(projectRooted, "fresh", {
      afterPublishConfig: async () => {
        throw new PluginInstallTransactionSimulatedCrash("destination-replaced");
      },
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);
    const afterCrash = await readFile(userConfig, "utf8");
    const loaded = await loadPlugins({
      pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
      userConfigPath: userConfig,
    });
    expect(loaded.errors.some((issue) =>
      issue.type === "install-recovery" && /plugin config not restored/u.test(issue.message),
    )).toBe(true);
    expect(await readFile(userConfig, "utf8")).toBe(afterCrash);
    await expect(access(join(world.workspaceRoot, ".agents", "config.toml"))).rejects.toThrow();
  });

  it("deletes a dead-pid lease and the emptied ops directory after recovery", async () => {
    const world = await createWorld();
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    const ops = join(world.pluginStorageRoot, ".plugin-install-ops");
    await mkdir(ops, { recursive: true });
    const operationId = "00000000-0000-4000-8000-deadpid00001";
    const recordPath = join(ops, `${operationId}.json`);
    await writeFile(recordPath, `${JSON.stringify({
      version: 1,
      operationId,
      kind: "install",
      pluginId: "fresh",
      destination: join(world.pluginStorageRoot, "fresh"),
      stagePath: join(world.pluginStorageRoot, `fresh.stage-${operationId}`),
      phase: "record-created",
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`);
    await writeFile(`${recordPath}.lease`, `${JSON.stringify({ pid: child.pid, nonce: randomUUID() })}\n`);
    const loaded = await loadPlugins({
      pluginStorageRoot: world.pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    expect(loaded.errors.filter((issue) => issue.type === "install-recovery")).toEqual([]);
    await expect(access(recordPath)).rejects.toThrow();
    await expect(access(`${recordPath}.lease`)).rejects.toThrow();
    await expect(access(ops)).rejects.toThrow();
  });

  it("does not rmdir the ops directory after a concurrent lease appears", async () => {
    const world = await createWorld();
    const ops = join(world.pluginStorageRoot, ".plugin-install-ops");
    await writeDeadRecord(world, "00000000-0000-4000-8000-rmdir0000001");
    const liveLease = join(ops, "00000000-0000-4000-8000-rmdir0000002.json.lease");
    await recoverPluginInstallTransactions({
      installRoots: [world.pluginStorageRoot],
      hooks: {
        beforeRemoveEmptyOpsDirectory: async (opsDir) => {
          await writeFile(liveLease, `${JSON.stringify({ pid: process.pid })}\n`);
          expect(opsDir).toBe(ops);
        },
      },
    });
    expect(await readFile(liveLease, "utf8")).toContain(String(process.pid));
    expect((await readdir(ops)).some((name) => name.endsWith(".lease"))).toBe(true);
  });

  it("keeps a live lease when another dead record is recovered", async () => {
    const world = await createWorld();
    const ops = join(world.pluginStorageRoot, ".plugin-install-ops");
    await writeDeadRecord(world, "00000000-0000-4000-8000-deadrec00001");
    const liveId = "00000000-0000-4000-8000-liverec00001";
    const liveRecord = join(ops, `${liveId}.json`);
    await writeFile(liveRecord, deadRecordJson(world, liveId));
    await writeFile(`${liveRecord}.lease`, `${JSON.stringify({ pid: process.pid })}\n`);
    const loaded = await loadPlugins({
      pluginStorageRoot: world.pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    expect(loaded.errors.filter((issue) => issue.type === "install-recovery").map((issue) => issue.message))
      .toEqual([expect.stringContaining(`inspect and remove it manually: ${liveRecord}.lease`)]);
    expect(await readFile(liveRecord, "utf8")).toContain(liveId);
    expect(await readFile(`${liveRecord}.lease`, "utf8")).toContain(String(process.pid));
    expect((await readdir(ops)).length).toBeGreaterThan(0);
  });

  it("skips a record whose recovery lease is held by a live pid", async () => {
    const world = await createWorld();
    const operationId = "00000000-0000-4000-8000-claim0000001";
    const recordPath = await writeDeadRecord(world, operationId);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened: () => void = () => {};
    const openedGate = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const first = recoverPluginInstallTransactions({
      installRoots: [world.pluginStorageRoot],
      hooks: {
        afterLeaseClaimed: async () => {
          opened();
          await gate;
        },
      },
    });
    await openedGate;
    const second = await recoverPluginInstallTransactions({
      installRoots: [world.pluginStorageRoot],
    });
    expect(second.recovered).toBe(0);
    expect(await readFile(recordPath, "utf8")).toContain(operationId);
    release();
    await expect(first).resolves.toMatchObject({ recovered: 1 });
    await expect(access(recordPath)).rejects.toThrow();
  });

  it("lets one child-process recovery win and keeps that lease through the loser", async () => {
    const world = await createWorld();
    const operationId = "00000000-0000-4000-8000-child0000001";
    const recordPath = await writeDeadRecord(world, operationId);
    const hold = join(world.root, "child-hold");
    const done = join(world.root, "child-done");
    const script = join(world.root, "recover-child.ts");
    const modulePath = join(import.meta.dirname, "../../../src/plugins/cli/plugin-install-transaction.ts");
    let child: ReturnType<typeof spawn> | undefined;
    await writeFile(script, `
      import { readFile, writeFile } from "node:fs/promises";
      import { recoverPluginInstallTransactions } from ${JSON.stringify(modulePath)};
      async function main() {
        const result = await recoverPluginInstallTransactions({
          installRoots: [${JSON.stringify(world.pluginStorageRoot)}],
          hooks: {
            afterLeaseClaimed: async () => {
              await writeFile(${JSON.stringify(hold)}, String(process.pid));
              for (;;) {
                try {
                  await readFile(${JSON.stringify(hold)});
                } catch {
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
            },
          },
        });
        await writeFile(${JSON.stringify(done)}, JSON.stringify(result));
      }
      main().catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
    `);
    let childLog = "";
    let childPid = "";
    const parent = recoverPluginInstallTransactions({
      installRoots: [world.pluginStorageRoot],
      hooks: {
        beforeLeaseRename: async () => {
          child = spawn(process.execPath, [
            join(import.meta.dirname, "../../../../node_modules/tsx/dist/cli.mjs"),
            script,
          ], { cwd: join(import.meta.dirname, "../../.."), stdio: ["ignore", "pipe", "pipe"] });
          child.stdout?.on("data", (chunk: Buffer) => {
            childLog += chunk.toString();
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            childLog += chunk.toString();
          });
          const started = Date.now();
          for (;;) {
            try {
              childPid = await readFile(hold, "utf8");
              break;
            } catch (error) {
              if (Date.now() - started > 10_000) throw new Error(`child did not claim\n${childLog}`);
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
        },
      },
    });
    const parentResult = await parent;
    expect(parentResult.recovered, childLog).toBe(0);
    const held = await readFile(`${recordPath}.lease`, "utf8");
    expect(held, childLog).toContain(childPid);
    await rm(hold);
    if (child === undefined) throw new Error("competing recovery did not start");
    const exit = await new Promise<number>((resolve, reject) => {
      child.once("exit", (code) => resolve(code ?? 1));
      child.once("error", reject);
    });
    expect(exit, childLog).toBe(0);
    expect(JSON.parse(await readFile(done, "utf8"))).toMatchObject({ recovered: 1 });
    await expect(access(recordPath)).rejects.toThrow();
  });

  it.each([
    ["claim", (operationId: string, pid: number) =>
      `${operationId}.json.lease.claim-${pid}-01234567-89ab-4cde-8fab-0123456789ab`],
    ["partial", (operationId: string, pid: number) =>
      `${operationId}.json.lease.tmp-${pid}-01234567-89ab-4cde-8fab-0123456789ab.partial-01234567-89ab-4cde-8fab-0123456789ab`],
  ])("sweeps a dead %s file and removes the emptied ops directory", async (label, artifactName) => {
    const world = await createWorld();
    const operationId = `00000000-0000-4000-8000-sweep${label}0001`;
    const recordPath = await writeDeadRecord(world, operationId);
    const pid = (JSON.parse(await readFile(`${recordPath}.lease`, "utf8")) as { pid: number }).pid;
    const ops = join(world.pluginStorageRoot, ".plugin-install-ops");
    await writeFile(join(ops, artifactName(operationId, pid)), "stale\n");
    const loaded = await loadPlugins({
      pluginStorageRoot: world.pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    expect(loaded.errors.filter((issue) => issue.type === "install-recovery")).toEqual([]);
    await expect(access(ops)).rejects.toThrow();
  });

  it("leaves near-miss lease names in the ops directory", async () => {
    const world = await createWorld();
    const operationId = "00000000-0000-4000-8000-nearmiss0001";
    const recordPath = await writeDeadRecord(world, operationId);
    const pid = (JSON.parse(await readFile(`${recordPath}.lease`, "utf8")) as { pid: number }).pid;
    const uuid = "01234567-89ab-4cde-8fab-0123456789ab";
    const ops = join(world.pluginStorageRoot, ".plugin-install-ops");
    const kept = [
      `${operationId}.json.lease.claim-${pid}-not-a-uuid`,
      `${operationId}.json.lease.claim-${pid}-${uuid}.partial-${uuid}`,
      `${operationId}.json.lease.tmp-${pid}-01234567-89AB-4CDE-8FAB-0123456789AB`,
      "00000000-0000-4000-8000-baremiss00001.json.lease",
      "kept-record.json",
    ];
    await Promise.all(kept.map((name) => writeFile(join(ops, name), "keep\n")));
    const loaded = await loadPlugins({
      pluginStorageRoot: world.pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    expect(loaded.errors.filter((issue) => issue.type === "install-recovery").map((issue) => issue.message))
      .toEqual([expect.stringContaining("kept-record.json")]);
    await expect(access(recordPath)).rejects.toThrow();
    for (const name of kept) {
      expect(await readFile(join(ops, name), "utf8")).toBe("keep\n");
    }
  });

  it("does not follow a symlinked lease when recovering a dead record", async () => {
    const world = await createWorld();
    const operationId = "00000000-0000-4000-8000-symlink00001";
    const recordPath = await writeDeadRecord(world, operationId);
    await rm(`${recordPath}.lease`);
    await symlink("/dev/zero", `${recordPath}.lease`);
    const loaded = await loadPlugins({
      pluginStorageRoot: world.pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    const issues = loaded.errors.filter((issue) => issue.type === "install-recovery");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("inspect and remove it manually");
    expect(issues[0]?.message).toContain(`${recordPath}.lease`);
    expect(await readFile(recordPath, "utf8")).toContain(operationId);
    await expect(lstat(`${recordPath}.lease`)).resolves.toMatchObject({});
  });

  it("treats two spellings of a missing config file as the same target", async () => {
    const world = await createWorld();
    const realHome = join(world.root, "real-home");
    await mkdir(realHome, { recursive: true });
    const linkParent = join(world.root, "home-link");
    await mkdir(linkParent, { recursive: true });
    await symlink(realHome, join(linkParent, "home"));
    const linkedHome = join(linkParent, "home");
    const linked = {
      ...world,
      agencHome: linkedHome,
      authority: { ...world.authority, agencHome: linkedHome },
    };
    await writeFile(join(linkedHome, "config.toml"), "config_version = 2\n\n[plugins]\nenabled = false\n");
    await expect(installFresh(linked, "fresh", {
      afterPublishConfig: async () => {
        throw new PluginInstallTransactionSimulatedCrash("destination-replaced");
      },
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);
    await rm(join(realHome, "config.toml"));
    const loaded = await loadPlugins({
      pluginStorageRoot: world.pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
      userConfigPath: join(linkedHome, "config.toml"),
    });
    expect(loaded.errors.filter((issue) => issue.type === "install-recovery")).toEqual([]);
    const restored = await readFile(join(realHome, "config.toml"), "utf8");
    expect(restored).toContain("\"enabled\" = false");
    expect(restored).not.toContain("fresh");
  });

  it("does not restore user config when the workspace plugin root cannot be resolved", async () => {
    const world = await createWorld();
    const agents = join(world.workspaceRoot, ".agents");
    await symlink(agents, agents);
    const userConfig = join(world.agencHome, "config.toml");
    const before = "config_version = 2\n\n[plugins]\nenabled = true\n";
    await writeFile(userConfig, before);
    await writeForgedRecord(world, "eloop", join(world.pluginStorageRoot, "demo"), {
      phase: "record-created",
      previousPluginConfig: {
        entryPresent: false,
        pluginsEnabledPresent: true,
        pluginsEnabled: false,
      },
      configTargetPath: userConfig,
    });
    const loaded = await loadPlugins({
      pluginStorageRoot: world.pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
      userConfigPath: userConfig,
    });
    expect(await readFile(userConfig, "utf8")).toBe(before);
    expect(loaded.errors.some((issue) =>
      issue.type === "install-recovery" && /plugin config not restored/u.test(issue.message),
    )).toBe(true);
    await expect(access(join(world.pluginStorageRoot, ".plugin-install-ops"))).rejects.toThrow();
  });

  it.each([
    ["symlinked parent", async (world: TxnWorld) => {
      const repoPlugins = join(world.workspaceRoot, ".agents", "plugins");
      await mkdir(repoPlugins, { recursive: true });
      const linkParent = join(world.root, "link-parent");
      await mkdir(linkParent, { recursive: true });
      await symlink(join(world.workspaceRoot, ".agents"), join(linkParent, "link"));
      return join(linkParent, "link", "plugins");
    }],
    ["trailing slash", async (world: TxnWorld) => `${join(world.workspaceRoot, ".agents", "plugins")}/`],
    ["parent segment", async (world: TxnWorld) => join(world.workspaceRoot, ".agents", "x", "..", "plugins")],
  ])("does not restore user config for a repository storage root via %s", async (_label, storagePath) => {
    const world = await createWorld();
    const pluginStorageRoot = await storagePath(world);
    await mkdir(join(world.workspaceRoot, ".agents", "plugins"), { recursive: true });
    const userConfig = join(world.agencHome, "config.toml");
    const before = "config_version = 2\n\n[plugins]\nenabled = true\n";
    await writeFile(userConfig, before);
    await writeForgedRecord({ ...world, pluginStorageRoot }, "repocfg", join(pluginStorageRoot, "demo"), {
      phase: "record-created",
      previousPluginConfig: {
        entryPresent: false,
        pluginsEnabledPresent: true,
        pluginsEnabled: false,
      },
      configTargetPath: userConfig,
    });
    const loaded = await loadPlugins({
      pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
      userConfigPath: userConfig,
    });
    expect(await readFile(userConfig, "utf8")).toBe(before);
    expect(loaded.errors.some((issue) =>
      issue.type === "install-recovery" && /plugin config not restored/u.test(issue.message),
    )).toBe(true);
    await expect(access(join(world.workspaceRoot, ".agents", "config.toml"))).rejects.toThrow();
  });

  it("does not restore a snapshot into a different user config", async () => {
    const world = await createWorld();
    const userConfig = join(world.agencHome, "config.toml");
    await writeFile(userConfig, "config_version = 2\n");
    await expect(installFresh(world, "fresh", {
      afterPublishConfig: async () => {
        throw new PluginInstallTransactionSimulatedCrash("destination-replaced");
      },
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);
    const afterCrash = await readFile(userConfig, "utf8");
    const otherHome = join(world.root, "other-home");
    await mkdir(otherHome, { recursive: true });
    const otherConfig = join(otherHome, "config.toml");
    await writeFile(otherConfig, "config_version = 2\n");
    const wrong = await loadPlugins({
      pluginStorageRoot: world.pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
      userConfigPath: otherConfig,
    });
    expect(wrong.errors.some((issue) =>
      issue.type === "install-recovery" && /plugin config not restored/u.test(issue.message),
    )).toBe(true);
    expect(await readFile(otherConfig, "utf8")).toBe("config_version = 2\n");
    expect(await readFile(userConfig, "utf8")).toBe(afterCrash);
    const right = await loadPlugins({
      pluginStorageRoot: world.pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
      userConfigPath: userConfig,
    });
    expect(right.errors.filter((issue) => issue.type === "install-recovery")).toEqual([]);
    expect(await readFile(userConfig, "utf8")).not.toContain("fresh");
    expect(await readFile(otherConfig, "utf8")).toBe("config_version = 2\n");
  });

  it("restores the previous plugin entry exactly, including extra fields", async () => {
    const installed = await installDemoV1();
    const configPath = join(installed.agencHome, "config.toml");
    const original = await readFile(configPath, "utf8");
    await writeFile(configPath, original.replace(
      "[\"plugins\".\"plugins\".\"demo\"]\n\"enabled\" = true",
      "[\"plugins\".\"plugins\".\"demo\"]\n\"enabled\" = true\n\"path\" = \"/plugin/extra\"",
    ));
    await expect(updateDemo(installed, {
      beforePublishConfig: async () => {
        const current = await readFile(configPath, "utf8");
        await writeFile(configPath, current.replace("\"path\" = \"/plugin/extra\"\n", ""));
      },
      afterPublishConfig: async () => {
        throw new Error("publish failed");
      },
    })).rejects.toThrow(/publish failed/u);
    expect(await readFile(configPath, "utf8")).toContain("\"path\" = \"/plugin/extra\"");
    expect(await readPluginVersion(installed.destination)).toBe("1.0.0");
  });

  it("does not copy a project plugin config value into the user config on rollback", async () => {
    const installed = await installDemoV1();
    await mkdir(join(installed.workspaceRoot, ".agenc"), { recursive: true });
    await writeFile(
      join(installed.workspaceRoot, ".agenc", "config.toml"),
      "config_version = 2\n\n[plugins.plugins.demo]\npath = \"/from/project/config\"\n",
    );
    await expect(updateDemo(installed, {
      afterPublishConfig: async () => {
        throw new Error("publish failed");
      },
    })).rejects.toThrow(/publish failed/u);
    const userConfig = await readFile(join(installed.agencHome, "config.toml"), "utf8");
    expect(userConfig).not.toContain("/from/project/config");
  });

  it("restores user config from loadPlugins after a crash before config-published", async () => {
    const installed = await installDemoV1();
    const configPath = join(installed.agencHome, "config.toml");
    const original = await readFile(configPath, "utf8");
    await writeFile(configPath, original.replace(
      "[\"plugins\".\"plugins\".\"demo\"]\n\"enabled\" = true",
      "[\"plugins\".\"plugins\".\"demo\"]\n\"enabled\" = true\n\"path\" = \"/plugin/crash-keep\"",
    ));
    await expect(updateDemo(installed, {
      beforePublishConfig: async () => {
        const current = await readFile(configPath, "utf8");
        await writeFile(configPath, current.replace("\"path\" = \"/plugin/crash-keep\"\n", ""));
      },
      afterPublishConfig: async () => {
        throw new PluginInstallTransactionSimulatedCrash("destination-replaced");
      },
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);
    expect(await readFile(configPath, "utf8")).not.toContain("/plugin/crash-keep");
    const loaded = await loadPlugins({
      pluginStorageRoot: installed.pluginStorageRoot,
      workspaceRoot: installed.workspaceRoot,
      config: { plugins: { enabled: true } },
      userConfigPath: configPath,
    });
    expect(loaded.errors.filter((issue) => issue.type === "install-recovery")).toEqual([]);
    expect(await readFile(configPath, "utf8")).toContain("\"path\" = \"/plugin/crash-keep\"");
    expect(await readPluginVersion(installed.destination)).toBe("1.0.0");
  });

  it("does not apply a forged project-root config snapshot", async () => {
    const world = await createWorld();
    await writeFile(join(world.agencHome, "config.toml"), "config_version = 2\n\n[plugins]\nenabled = true\n\n[plugins.plugins.demo]\nenabled = true\n");
    const before = await readFile(join(world.agencHome, "config.toml"), "utf8");
    const repoPlugins = join(world.workspaceRoot, ".agents", "plugins");
    await writeForgedRecord({ ...world, pluginStorageRoot: repoPlugins }, "projectcfg", join(repoPlugins, "demo"), {
      previousPluginConfig: {
        entryPresent: false,
        pluginsEnabledPresent: true,
        pluginsEnabled: false,
      },
    });
    const loaded = await loadPlugins({
      pluginStorageRoot: world.pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    expect(await readFile(join(world.agencHome, "config.toml"), "utf8")).toBe(before);
    const issues = loaded.errors.filter((issue) => issue.type === "install-recovery");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("remove them manually");
    expect(await pathExists(join(repoPlugins, ".plugin-install-ops", "00000000-0000-4000-8000-projectcfg00.json"))).toBe(true);
  });

  it("loadPlugins ignores forged workspace records that would delete outside files", async () => {
    const world = await createWorld();
    const repoPlugins = join(world.workspaceRoot, ".agents", "plugins");
    await mkdir(repoPlugins, { recursive: true });
    const outside = await mkdtemp(join(world.root, "outside-load-"));
    await writeFile(join(outside, "keep"), "stay");
    const traversal = join(repoPlugins, "..", "outside-dotdot");
    await mkdir(traversal, { recursive: true });
    await writeFile(join(traversal, "keep"), "stay");
    const linkTarget = await mkdtemp(join(world.root, "link-load-"));
    await writeFile(join(linkTarget, "keep"), "stay");
    await symlink(linkTarget, join(repoPlugins, "linked-plugin"));
    const opsTarget = await mkdtemp(join(world.root, "ops-target-"));
    await writeFile(join(opsTarget, "keep"), "stay");

    const identity = await directoryIdentity(outside);
    await writeForgedRecord({ ...world, pluginStorageRoot: repoPlugins }, "absolute", outside, {
      phase: "destination-replaced",
      stageIdentity: identity,
    });
    await writeForgedRecord({ ...world, pluginStorageRoot: repoPlugins }, "traversal", traversal, {
      phase: "destination-replaced",
      stageIdentity: await directoryIdentity(traversal),
    });
    await writeForgedRecord({ ...world, pluginStorageRoot: repoPlugins }, "symlink", join(repoPlugins, "linked-plugin"), {
      phase: "destination-replaced",
      stageIdentity: await directoryIdentity(linkTarget),
    });
    const confined = await loadPlugins({
      pluginStorageRoot: world.pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    const confinedIssues = confined.errors.filter((issue) => issue.type === "install-recovery");
    expect(confinedIssues).toHaveLength(1);
    expect(confinedIssues[0]?.message).toContain("remove them manually");
    expect(confinedIssues[0]?.message).toContain("absolute0000.json");
    await rm(join(repoPlugins, ".plugin-install-ops"), { recursive: true, force: true });
    await writeFile(join(opsTarget, "00000000-0000-4000-8000-opsdir000000.json"), `${JSON.stringify({
      version: 1,
      operationId: "00000000-0000-4000-8000-opsdir000000",
      kind: "install",
      pluginId: "forged",
      destination: outside,
      stagePath: join(outside, "stage"),
      phase: "committed",
      backupPath: join(opsTarget, "keep"),
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`);
    await symlink(opsTarget, join(repoPlugins, ".plugin-install-ops"));
    const linkedOps = await loadPlugins({
      pluginStorageRoot: world.pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    const linkedIssues = linkedOps.errors.filter((issue) => issue.type === "install-recovery");
    expect(linkedIssues).toHaveLength(1);
    expect(linkedIssues[0]?.message).toContain("not a real directory");
    await expect(readFile(join(outside, "keep"), "utf8")).resolves.toBe("stay");
    await expect(readFile(join(traversal, "keep"), "utf8")).resolves.toBe("stay");
    await expect(readFile(join(linkTarget, "keep"), "utf8")).resolves.toBe("stay");
    await expect(readFile(join(opsTarget, "keep"), "utf8")).resolves.toBe("stay");
  });

  it("does not roll back an install that commits before recovery claims the lease", async () => {
    const world = await createWorld();
    const destination = join(world.pluginStorageRoot, "fresh");
    await mkdir(destination, { recursive: true });
    const operationId = "00000000-0000-4000-8000-staleread0001";
    const recordPath = await writeDeadRecord(world, operationId);
    const identity = await directoryIdentity(destination);
    await writeFile(recordPath, `${JSON.stringify({
      version: 1,
      operationId,
      kind: "install",
      pluginId: "fresh",
      destination,
      stagePath: join(world.pluginStorageRoot, `fresh.stage-${operationId}`),
      phase: "destination-replaced",
      stageIdentity: identity,
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`);
    const recovered = await recoverPluginInstallTransactions({
      installRoots: [world.pluginStorageRoot],
      hooks: {
        afterLeaseClaimed: async () => {
          await rm(recordPath, { force: true });
        },
      },
    });
    expect(recovered.recovered).toBe(0);
    expect(recovered.issues).toEqual([]);
    expect(await pathExists(destination)).toBe(true);
  });

  it("does not delete lease artifacts through a symlinked operations directory", async () => {
    const world = await createWorld();
    const outside = await mkdtemp(join(world.root, "outside-ops-"));
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const sentinel = join(
      outside,
      `sentinel.json.lease.tmp-${dead.pid}-${randomUUID()}`,
    );
    await writeFile(sentinel, "preserve this outside file");
    await symlink(outside, join(world.pluginStorageRoot, ".plugin-install-ops"));
    const swept = await recoverPluginInstallTransactions({
      installRoots: [world.pluginStorageRoot],
    });
    expect(await pathExists(sentinel)).toBe(true);
    expect(swept.recovered).toBe(0);
    expect(swept.issues.some((issue) => /not a real directory/u.test(issue.message))).toBe(true);
  });

  it("does not build a reclaim path from a non-uuid lease nonce", async () => {
    const world = await createWorld();
    const operationId = "00000000-0000-4000-8000-badnonce0001";
    const recordPath = await writeDeadRecord(world, operationId);
    const leasePath = `${recordPath}.lease`;
    const current = JSON.parse(await readFile(leasePath, "utf8")) as { readonly pid: number };
    await writeFile(leasePath, `${JSON.stringify({ pid: current.pid, nonce: "../escaped" })}\n`);
    const recovered = await recoverPluginInstallTransactions({
      installRoots: [world.pluginStorageRoot],
    });
    expect(recovered.recovered).toBe(0);
    expect(recovered.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining(`inspect and remove it manually: ${leasePath}`),
    ]);
    expect(await pathExists(join(world.pluginStorageRoot, "escaped"))).toBe(false);
    expect((await readdir(join(world.pluginStorageRoot, ".plugin-install-ops")))
      .some((name) => name.includes("reclaim-"))).toBe(false);
    expect(await readFile(recordPath, "utf8")).toContain(operationId);
  });

  it("restores a backed-up plugin when this pid is reused without the lease token", async () => {
    const installed = await crashDemoUpdate(await installDemoV1(), "destination-backed-up");
    expect(await pathExists(installed.destination)).toBe(false);
    const ops = join(installed.pluginStorageRoot, ".plugin-install-ops");
    const records = (await readdir(ops)).filter((name) => name.endsWith(".json"));
    expect(records).toHaveLength(1);
    const recordPath = join(ops, records[0] ?? "");
    await writeFile(`${recordPath}.lease`, `${JSON.stringify({ pid: process.pid, nonce: randomUUID() })}\n`);
    const load = () => loadPlugins({
      pluginStorageRoot: installed.pluginStorageRoot,
      workspaceRoot: installed.workspaceRoot,
      config: { plugins: { enabled: true } },
      userConfigPath: join(installed.agencHome, "config.toml"),
    });
    const loaded = await load();
    expect(loaded.errors.filter((issue) => issue.type === "install-recovery")).toEqual([]);
    expect(await readPluginVersion(installed.destination)).toBe("1.0.0");
    expect(namesInclude(await storageNames(installed), ".bak-")).toBe(false);
    await expect(access(recordPath)).rejects.toThrow();
    expect((await load()).errors.filter((issue) => issue.type === "install-recovery")).toEqual([]);
  });

  it("does not reclaim a lease owned by live pid 1", async () => {
    const world = await createWorld();
    const operationId = "00000000-0000-4000-8000-pidone000001";
    const ops = join(world.pluginStorageRoot, ".plugin-install-ops");
    await mkdir(ops, { recursive: true });
    const recordPath = join(ops, `${operationId}.json`);
    await writeFile(recordPath, deadRecordJson(world, operationId));
    await writeFile(`${recordPath}.lease`, `${JSON.stringify({ pid: 1, nonce: "pid-one" })}\n`);
    const recovered = await recoverPluginInstallTransactions({
      installRoots: [world.pluginStorageRoot],
    });
    expect(recovered.recovered).toBe(0);
    expect(recovered.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining("lease is still live"),
    ]);
    expect(await readFile(recordPath, "utf8")).toContain(operationId);
    expect(await readFile(`${recordPath}.lease`, "utf8")).toContain('"pid":1');
  });

  it("restores version 1 when the committed record write fails after config publication", async () => {
    const installed = await installDemoV1();
    try {
      await expect(updateDemo(installed, {
        afterPhase: async (phase, context) => {
          if (phase !== "config-published") return;
          durableControl.failRecordPath = context.recordPath;
        },
      })).rejects.toThrow(/injected EIO writing committed record/u);
    } finally {
      durableControl.failRecordPath = undefined;
    }
    expect(await readPluginVersion(installed.destination)).toBe("1.0.0");
    expect(await listedVersions(installed)).toEqual(["1.0.0"]);
    expect(await demoEnabledInConfig(installed)).toBe(true);
    expect(namesInclude(await storageNames(installed), ".bak-")).toBe(false);
  });

  it("does not recover install records under the workspace plugin root", async () => {
    const world = await createWorld();
    const repoPlugins = join(world.workspaceRoot, ".agents", "plugins");
    const operationId = "00000000-0000-4000-8000-workspaceroot";
    const recordPath = join(repoPlugins, ".plugin-install-ops", `${operationId}.json`);
    await mkdir(join(repoPlugins, ".plugin-install-ops"), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify({
      version: 1,
      operationId,
      kind: "install",
      pluginId: "fresh",
      destination: join(repoPlugins, "fresh"),
      stagePath: join(repoPlugins, `fresh.stage-${operationId}`),
      phase: "record-created",
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`);
    const loaded = await loadPlugins({
      pluginStorageRoot: world.pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    const issues = loaded.errors.filter((issue) => issue.type === "install-recovery");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("remove them manually");
    expect(issues[0]?.message).toContain(recordPath);
    expect(await pathExists(recordPath)).toBe(true);
  });

  it("does not reject a symlinked storage root when no install operation directory exists", async () => {
    const world = await createWorld();
    const linkedRoot = join(world.root, "plugins-link");
    await symlink(world.pluginStorageRoot, linkedRoot);
    const idle = await loadPlugins({
      pluginStorageRoot: linkedRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    expect(idle.errors.filter((issue) => issue.type === "install-recovery")).toEqual([]);
    const ops = join(linkedRoot, ".plugin-install-ops");
    await mkdir(ops);
    const operationId = "00000000-0000-4000-8000-symlinkroot01";
    await writeFile(join(ops, `${operationId}.json`), deadRecordJson(
      { ...world, pluginStorageRoot: world.pluginStorageRoot },
      operationId,
    ));
    const pending = await recoverPluginInstallTransactions({ installRoots: [linkedRoot] });
    expect(pending.recovered).toBe(1);
    expect(pending.issues.some((issue) => /not a real directory/u.test(issue.message))).toBe(false);
  });

  it("keeps the committed record when backup removal does not match its identity", async () => {
    const installed = await installDemoV1();
    let recordPath = "";
    let backupPath = "";
    const updated = await updateDemo(installed, {
      afterPhase: async (phase, context) => {
        if (phase !== "committed" || context.backupPath === undefined) return;
        recordPath = context.recordPath;
        backupPath = context.backupPath;
        await writeManifest(backupPath, "demo", "9.9.9");
      },
    });
    expect(await readPluginVersion(updated.destination)).toBe("2.0.0");
    expect(await pathExists(backupPath)).toBe(true);
    expect(await pathExists(recordPath)).toBe(true);
    const recovered = await recoverLocal(installed);
    expect(recovered.issues.some((issue) => /identity changed/u.test(issue.message))).toBe(true);
    expect(await pathExists(backupPath)).toBe(true);
    expect(await pathExists(recordPath)).toBe(true);
  });

  it("keeps plugin id and destination on a recovery throw after the record parses", async () => {
    const world = await createWorld();
    const destination = join(world.pluginStorageRoot, "fresh");
    await mkdir(destination, { recursive: true });
    const operationId = "00000000-0000-4000-8000-parsedthrow01";
    const recordPath = await writeDeadRecord(world, operationId);
    const userConfig = join(world.agencHome, "config.toml");
    await writeFile(userConfig, "config_version = 2\n");
    await writeFile(recordPath, `${JSON.stringify({
      version: 1,
      operationId,
      kind: "install",
      pluginId: "fresh",
      destination,
      stagePath: join(world.pluginStorageRoot, `fresh.stage-${operationId}`),
      phase: "destination-replaced",
      stageIdentity: await directoryIdentity(destination),
      previousPluginConfig: { entryPresent: false },
      configTargetPath: userConfig,
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`);
    const recovered = await recoverPluginInstallTransactions({
      installRoots: [world.pluginStorageRoot],
      userConfigPath: userConfig,
      restorePluginConfig: async () => {
        throw new Error("restore blew up");
      },
    });
    expect(recovered.recovered).toBe(0);
    expect(recovered.issues).toEqual([expect.objectContaining({
      pluginId: "fresh",
      destination,
      message: "restore blew up",
    })]);
  });

  it("documents install recovery for the default storage root, not only the env override", async () => {
    const repoRoot = join(import.meta.dirname, "../../../..");
    const envDoc = await readFile(join(repoRoot, "docs/reference/env.md"), "utf8");
    expect(envDoc).toContain(
      "Interrupted install recovery runs only for the plugin storage root (this directory when set, else the default)",
    );
    const skills = await readFile(join(repoRoot, "docs/reference/skills-plugins.md"), "utf8");
    expect(skills).toContain(
      "Interrupted install recovery runs only for that storage root. It does not recover `<workspace>/.agents/plugins` unless that path is the storage root.",
    );
    expect(skills).toContain("Remove that directory manually.");
  });

  it("does not let a second recovery claim a symlinked dead lease", async () => {
    const world = await createWorld();
    const operationId = "00000000-0000-4000-8000-symlinkrace1";
    const ops = join(world.pluginStorageRoot, ".plugin-install-ops");
    await mkdir(ops, { recursive: true });
    const recordPath = join(ops, `${operationId}.json`);
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    const leaseBody = join(world.root, "lease-body");
    await writeFile(leaseBody, `${JSON.stringify({ pid: child.pid, nonce: "dead-nonce-value" })}\n`);
    await symlink(leaseBody, `${recordPath}.lease`);
    await writeFile(recordPath, `${JSON.stringify({
      version: 1,
      operationId,
      kind: "install",
      pluginId: "fresh",
      destination: join(world.pluginStorageRoot, "fresh"),
      stagePath: join(world.pluginStorageRoot, `fresh.stage-${operationId}`),
      phase: "record-created",
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`);
    await mkdir(join(world.pluginStorageRoot, "fresh"), { recursive: true });
    const owners: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstMayRename = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond: () => void = () => {};
    const secondMayRename = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let arrivals = 0;
    renameGate.before = async (from, to) => {
      if (!to.endsWith(".json.lease") || !from.includes(".tmp-")) return;
      arrivals += 1;
      if (arrivals === 1) await firstMayRename;
      else {
        releaseFirst();
        await secondMayRename;
      }
    };
    let r2Entered: () => void = () => {};
    const r2EnteredGate = new Promise<void>((resolve) => {
      r2Entered = resolve;
    });
    let r2: Promise<{ readonly recovered: number }> = Promise.resolve({ recovered: 0 });
    const result = await recoverPluginInstallTransactions({
      installRoots: [world.pluginStorageRoot],
      hooks: {
        beforeLeaseReplace: async () => {
          r2 = recoverPluginInstallTransactions({
            installRoots: [world.pluginStorageRoot],
            hooks: {
              beforeLeaseReplace: async () => {
                r2Entered();
              },
              afterLeaseClaimed: async () => {
                owners.push("r2");
                if (owners.length === 1) releaseSecond();
              },
            },
          });
          await r2EnteredGate;
        },
        afterLeaseClaimed: async () => {
          owners.push("r1");
          if (owners.length === 1) releaseSecond();
        },
      },
    });
    let second: { readonly recovered: number };
    try {
      second = await r2;
    } finally {
      renameGate.before = undefined;
    }
    expect(owners).toEqual([]);
    expect(result.recovered + second.recovered).toBe(0);
    expect(result.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining(`inspect and remove it manually: ${recordPath}.lease`),
    ]);
    expect(await readFile(recordPath, "utf8")).toContain(operationId);
  });

  it.skipIf(process.platform === "win32")("does not block on a fifo install lease", async () => {
    const world = await createWorld();
    const operationId = "00000000-0000-4000-8000-fifolease001";
    const ops = join(world.pluginStorageRoot, ".plugin-install-ops");
    await mkdir(ops, { recursive: true });
    const recordPath = join(ops, `${operationId}.json`);
    const leasePath = `${recordPath}.lease`;
    const made = spawnSync("mkfifo", [leasePath]);
    expect(made.status).toBe(0);
    await writeFile(recordPath, deadRecordJson(world, operationId));
    const result = await recoverPluginInstallTransactions({
      installRoots: [world.pluginStorageRoot],
    });
    expect(result.recovered).toBe(0);
    expect(result.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining(`inspect and remove it manually: ${leasePath}`),
    ]);
    expect(await readFile(recordPath, "utf8")).toContain(operationId);
    expect((await lstat(leasePath)).isFIFO()).toBe(true);
  }, 3_000);

  it("reports one untouched project-scope install leftover", async () => {
    const world = await createWorld();
    const ops = join(world.workspaceRoot, ".agents", "plugins", ".plugin-install-ops");
    await mkdir(ops, { recursive: true });
    const record = join(ops, "00000000-0000-4000-8000-project00001.json");
    const body = "{\"phase\":\"record-created\"}\n";
    await writeFile(record, body);
    const before = await stat(record);
    const loaded = await loadPlugins({
      pluginStorageRoot: world.pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    const issues = loaded.errors.filter((issue) => issue.type === "install-recovery");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("remove them manually");
    expect(issues[0]?.message).toContain(record);
    expect(await readFile(record, "utf8")).toBe(body);
    expect((await stat(record)).mtimeMs).toBe(before.mtimeMs);
  });

  it("reports install artwork under the installed root", async () => {
    const world = await createWorld();
    const source = await writeArtworkPlugin(world.root, "1.0.0");
    const result = await installPluginOp({ ...world.authority, source });
    const dest = result.destination;
    expect(result.plugin.logoPath).toBe(join(dest, "assets", "logo.png"));
    expect(result.plugin.interface?.screenshots).toEqual([join(dest, "assets", "screen.png")]);
    expect(result.plugin.interface?.composerIcon).toBe(join(dest, "assets", "icon.png"));
    await expect(stat(String(result.plugin.interface?.composerIcon))).resolves.toBeTruthy();
  });

  it("reports update artwork under the installed root", async () => {
    const world = await createWorld();
    await installPluginOp({ ...world.authority, source: await writeArtworkPlugin(world.root, "1.0.0") });
    const result = await updatePluginOp({
      ...world.authority,
      pluginId: "alpha",
      source: await writeArtworkPlugin(world.root, "2.0.0"),
    });
    const dest = result.destination;
    expect(result.plugin.version).toBe("2.0.0");
    expect(result.plugin.logoPath).toBe(join(dest, "assets", "logo.png"));
    expect(result.plugin.interface?.composerIcon).toBe(join(dest, "assets", "icon.png"));
    await expect(stat(String(result.plugin.interface?.composerIcon))).resolves.toBeTruthy();
  });

  it.each([
    "stage-ready",
    "destination-replaced",
    "committed",
  ] as const)("recovers a first install that crashed at %s under a symlinked storage root", async (phase) => {
    const world = await symlinkedStorageWorld();
    await expect(installFresh(world, "fresh", crashAfter(phase)))
      .rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);
    const issues = await loadRecoveryIssues(world);
    expect(issues).toEqual([]);
    const names = await readdir(world.pluginStorageRoot);
    expect(names.some((name) => name.includes(".stage-"))).toBe(false);
    const records = await readdir(join(world.pluginStorageRoot, ".plugin-install-ops")).catch(() => [] as string[]);
    expect(records.some((name) => name.endsWith(".json"))).toBe(false);
    const listed = await listInstalledPlugins(world.authority);
    expect(listed.plugins).toHaveLength(phase === "committed" ? 1 : 0);
    expect(await loadRecoveryIssues(world)).toEqual([]);
  });

  it("a successful install under a symlinked storage root leaves no load issue", async () => {
    const world = await createWorld();
    const realStorage = join(world.root, "real-plugins");
    await mkdir(realStorage, { recursive: true });
    const pluginStorageRoot = join(world.root, "plugins-link");
    await symlink(realStorage, pluginStorageRoot);
    const source = await writeArtworkPlugin(world.root, "1.0.0");
    await installPluginOp({ ...world.authority, pluginStorageRoot, source });
    const loaded = await loadPlugins({
      pluginStorageRoot,
      workspaceRoot: world.workspaceRoot,
      config: { plugins: { enabled: true } },
    });
    expect(loaded.errors.filter((issue) => issue.type === "install-recovery")).toEqual([]);
  });
});

async function directoryIdentity(path: string): Promise<{
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly mode: number;
  readonly manifestSha256: string;
  readonly metadataSha256: string;
}> {
  const info = await stat(path);
  return {
    path,
    dev: String(info.dev),
    ino: String(info.ino),
    mode: info.mode,
    manifestSha256: "",
    metadataSha256: "",
  };
}

function deadRecordJson(world: TxnWorld, operationId: string): string {
  return `${JSON.stringify({
    version: 1,
    operationId,
    kind: "install",
    pluginId: "fresh",
    destination: join(world.pluginStorageRoot, "fresh"),
    stagePath: join(world.pluginStorageRoot, `fresh.stage-${operationId}`),
    phase: "record-created",
    createdAt: "2026-01-01T00:00:00.000Z",
  })}\n`;
}

async function writeDeadRecord(world: TxnWorld, operationId: string): Promise<string> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  const ops = join(world.pluginStorageRoot, ".plugin-install-ops");
  await mkdir(ops, { recursive: true });
  const recordPath = join(ops, `${operationId}.json`);
  await writeFile(recordPath, deadRecordJson(world, operationId));
  await writeFile(`${recordPath}.lease`, `${JSON.stringify({ pid: child.pid, nonce: randomUUID() })}\n`);
  return recordPath;
}

async function writeForgedRecord(
  world: TxnWorld,
  label: string,
  destination: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const ops = join(world.pluginStorageRoot, ".plugin-install-ops");
  await mkdir(ops, { recursive: true });
  const operationId = `00000000-0000-4000-8000-${label.padEnd(12, "0").slice(0, 12)}`;
  await writeFile(join(ops, `${operationId}.json`), `${JSON.stringify({
    version: 1,
    operationId,
    kind: "install",
    pluginId: "forged",
    destination,
    stagePath: `${destination}.stage-${operationId}`,
    phase: "stage-ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  })}\n`);
}
