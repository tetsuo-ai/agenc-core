import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

  it("rolls the published update forward after a crash before backup removal", async () => {
    const installed = await crashDemoUpdate(await installDemoV1(), "config-published");
    expect(await readPluginVersion(installed.destination)).toBe("2.0.0");
    expect(namesInclude(await storageNames(installed), ".bak-")).toBe(true);
    expect(await listedVersions(installed)).toEqual(["2.0.0"]);
    expect(await readPluginVersion(installed.destination)).toBe("2.0.0");
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
});
