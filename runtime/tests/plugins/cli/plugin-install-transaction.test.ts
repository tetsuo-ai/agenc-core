import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseToml } from "../../../src/config/loader.js";
import {
  PluginInstallTransactionSimulatedCrash,
  recoverPluginInstallTransactions,
  type PluginInstallTransactionPhase,
} from "../../../src/plugins/cli/plugin-install-transaction.js";
import {
  installPluginOp,
  listInstalledPlugins,
  updatePluginOp,
} from "../../../src/plugins/cli/pluginOperations.js";
import { loadPlugins } from "../../../src/plugins/loader.js";

interface ParsedPluginsConfig {
  readonly plugins?: {
    readonly enabled?: unknown;
    readonly plugins?: Readonly<Record<string, { readonly enabled?: unknown }>>;
  };
}

async function tempRuntime(): Promise<{
  readonly root: string;
  readonly agencHome: string;
  readonly workspaceRoot: string;
  readonly pluginStorageRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agenc-plugin-install-txn-"));
  const agencHome = join(root, "home");
  const workspaceRoot = join(root, "workspace");
  const pluginStorageRoot = join(agencHome, "plugins");
  await mkdir(agencHome, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(pluginStorageRoot, { recursive: true });
  return { root, agencHome, workspaceRoot, pluginStorageRoot };
}

async function writePlugin(
  root: string,
  name: string,
  version: string,
): Promise<string> {
  const pluginRoot = join(root, `${name}-${version}`);
  await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".agenc-plugin", "plugin.json"),
    JSON.stringify({
      name,
      version,
      description: `${name} ${version}`,
      commands: "./commands",
    }, null, 2),
  );
  await mkdir(join(pluginRoot, "commands"), { recursive: true });
  await writeFile(join(pluginRoot, "commands", "hello.md"), `# Hello ${version}\n`);
  return pluginRoot;
}

function pluginAuthority(
  agencHome: string,
  workspaceRoot: string,
  pluginStorageRoot: string,
) {
  return {
    agencHome,
    pluginStorageRoot,
    sessionTempRoot: join(agencHome, "tmp"),
    workspaceRoot,
    env: Object.freeze({}) as NodeJS.ProcessEnv,
  };
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

async function listChildNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function crashAfter(
  phase: PluginInstallTransactionPhase,
): {
  afterPhase: (
    current: PluginInstallTransactionPhase,
  ) => Promise<void>;
} {
  return {
    afterPhase: async (current) => {
      if (current === phase) {
        throw new PluginInstallTransactionSimulatedCrash(phase);
      }
    },
  };
}

describe("plugin install transaction", () => {
  it("keeps version 1 installed when metadata writing fails during update", async () => {
    const { root, agencHome, workspaceRoot, pluginStorageRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot, pluginStorageRoot);
    const first = await installPluginOp({
      ...authority,
      source: await writePlugin(root, "demo", "1.0.0"),
    });

    await expect(updatePluginOp({
      ...authority,
      pluginId: "demo",
      source: await writePlugin(root, "demo", "2.0.0"),
      installTransactionHooks: {
        beforeWriteMetadata: async () => {
          throw new Error("metadata write failed");
        },
      },
    })).rejects.toThrow(/metadata write failed/u);

    expect(await readPluginVersion(first.destination)).toBe("1.0.0");
    const listed = await listInstalledPlugins(authority);
    expect(listed.plugins.map((plugin) => plugin.version)).toEqual(["1.0.0"]);
    expect(listed.plugins.map((plugin) => plugin.id)).toEqual(["demo"]);
    expect((await listChildNames(pluginStorageRoot)).some((name) => name.includes(".stage-")))
      .toBe(false);
  });

  it("keeps version 1 installed when staged-copy validation fails during update", async () => {
    const { root, agencHome, workspaceRoot, pluginStorageRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot, pluginStorageRoot);
    const first = await installPluginOp({
      ...authority,
      source: await writePlugin(root, "demo", "1.0.0"),
    });

    await expect(updatePluginOp({
      ...authority,
      pluginId: "demo",
      source: await writePlugin(root, "demo", "2.0.0"),
      installTransactionHooks: {
        beforeValidate: async () => {
          throw new Error("installed plugin failed validation");
        },
      },
    })).rejects.toThrow(/installed plugin failed validation/u);

    expect(await readPluginVersion(first.destination)).toBe("1.0.0");
    const listed = await listInstalledPlugins(authority);
    expect(listed.plugins.map((plugin) => `${plugin.id}@${plugin.version}`)).toEqual([
      "demo@1.0.0",
    ]);
  });

  it("keeps version 1 installed when plugin-config persistence fails during update", async () => {
    const { root, agencHome, workspaceRoot, pluginStorageRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot, pluginStorageRoot);
    const first = await installPluginOp({
      ...authority,
      source: await writePlugin(root, "demo", "1.0.0"),
    });

    await expect(updatePluginOp({
      ...authority,
      pluginId: "demo",
      source: await writePlugin(root, "demo", "2.0.0"),
      installTransactionHooks: {
        beforePublishConfig: async () => {
          throw new Error("plugin config write failed");
        },
      },
    })).rejects.toThrow(/plugin config write failed/u);

    expect(await readPluginVersion(first.destination)).toBe("1.0.0");
    const listed = await listInstalledPlugins(authority);
    expect(listed.plugins.map((plugin) => plugin.version)).toEqual(["1.0.0"]);
    const parsed = parseToml(await readFile(join(agencHome, "config.toml"), "utf8")) as ParsedPluginsConfig;
    expect(parsed.plugins?.plugins?.demo?.enabled).toBe(true);
  });

  it("leaves no discoverable directory when first-install metadata, validation, or config writes fail", async () => {
    const { root, agencHome, workspaceRoot, pluginStorageRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot, pluginStorageRoot);
    const source = await writePlugin(root, "fresh", "1.0.0");

    for (const [hookName, hooks] of [
      ["metadata", { beforeWriteMetadata: async () => { throw new Error("metadata write failed"); } }],
      ["validation", { beforeValidate: async () => { throw new Error("installed plugin failed validation"); } }],
      ["config", { beforePublishConfig: async () => { throw new Error("plugin config write failed"); } }],
    ] as const) {
      await expect(installPluginOp({
        ...authority,
        source,
        name: `fresh-${hookName}`,
        installTransactionHooks: hooks,
      })).rejects.toThrow();

      const listed = await listInstalledPlugins(authority);
      expect(listed.plugins.map((plugin) => plugin.id), hookName).not.toContain(`fresh-${hookName}`);
      expect(
        (await listChildNames(pluginStorageRoot)).some((name) =>
          name.includes(`fresh-${hookName}`) || name.includes(".stage-") || name.includes(".bak-")
        ),
        hookName,
      ).toBe(false);
    }
  });

  it("removes the update backup only after the new directory and configuration are durable", async () => {
    const { root, agencHome, workspaceRoot, pluginStorageRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot, pluginStorageRoot);
    await installPluginOp({
      ...authority,
      source: await writePlugin(root, "demo", "1.0.0"),
    });

    let backupAtConfigPublished: string | undefined;
    let backupExistedAtConfigPublished = false;
    const updated = await updatePluginOp({
      ...authority,
      pluginId: "demo",
      source: await writePlugin(root, "demo", "2.0.0"),
      installTransactionHooks: {
        afterPhase: async (phase, context) => {
          if (phase !== "config-published") return;
          backupAtConfigPublished = context.backupPath;
          backupExistedAtConfigPublished = context.backupPath !== undefined &&
            await pathExists(context.backupPath);
        },
      },
    });

    expect(backupAtConfigPublished).toEqual(expect.stringContaining(".bak-"));
    expect(backupExistedAtConfigPublished).toBe(true);
    expect(backupAtConfigPublished !== undefined && await pathExists(backupAtConfigPublished))
      .toBe(false);
    expect(await readPluginVersion(updated.destination)).toBe("2.0.0");
    const parsed = parseToml(await readFile(join(agencHome, "config.toml"), "utf8")) as ParsedPluginsConfig;
    expect(parsed.plugins?.plugins?.demo?.enabled).toBe(true);
    expect((await listChildNames(pluginStorageRoot)).some((name) => name.includes(".bak-")))
      .toBe(false);
  });

  it("recovers version 1 after a crash between destination backup and replacement", async () => {
    const { root, agencHome, workspaceRoot, pluginStorageRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot, pluginStorageRoot);
    const first = await installPluginOp({
      ...authority,
      source: await writePlugin(root, "demo", "1.0.0"),
    });

    await expect(updatePluginOp({
      ...authority,
      pluginId: "demo",
      source: await writePlugin(root, "demo", "2.0.0"),
      installTransactionHooks: crashAfter("destination-backed-up"),
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);

    expect(await pathExists(first.destination)).toBe(false);
    expect((await listChildNames(pluginStorageRoot)).some((name) => name.includes(".bak-")))
      .toBe(true);

    const listed = await listInstalledPlugins(authority);
    expect(await readPluginVersion(first.destination)).toBe("1.0.0");
    expect(listed.plugins.map((plugin) => plugin.version)).toEqual(["1.0.0"]);
    expect((await listChildNames(pluginStorageRoot)).some((name) =>
      name.includes(".bak-") || name.includes(".stage-")
    )).toBe(false);
  });

  it("recovers version 1 after a crash between destination replacement and config publication", async () => {
    const { root, agencHome, workspaceRoot, pluginStorageRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot, pluginStorageRoot);
    const first = await installPluginOp({
      ...authority,
      source: await writePlugin(root, "demo", "1.0.0"),
    });

    await expect(updatePluginOp({
      ...authority,
      pluginId: "demo",
      source: await writePlugin(root, "demo", "2.0.0"),
      installTransactionHooks: crashAfter("destination-replaced"),
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);

    expect(await readPluginVersion(first.destination)).toBe("2.0.0");

    const listed = await listInstalledPlugins(authority);
    expect(await readPluginVersion(first.destination)).toBe("1.0.0");
    expect(listed.plugins.map((plugin) => plugin.version)).toEqual(["1.0.0"]);
    const parsed = parseToml(await readFile(join(agencHome, "config.toml"), "utf8")) as ParsedPluginsConfig;
    expect(parsed.plugins?.plugins?.demo?.enabled).toBe(true);
  });

  it("rolls the published update forward after a crash before backup removal", async () => {
    const { root, agencHome, workspaceRoot, pluginStorageRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot, pluginStorageRoot);
    const first = await installPluginOp({
      ...authority,
      source: await writePlugin(root, "demo", "1.0.0"),
    });

    await expect(updatePluginOp({
      ...authority,
      pluginId: "demo",
      source: await writePlugin(root, "demo", "2.0.0"),
      installTransactionHooks: crashAfter("config-published"),
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);

    expect(await readPluginVersion(first.destination)).toBe("2.0.0");
    expect((await listChildNames(pluginStorageRoot)).some((name) => name.includes(".bak-")))
      .toBe(true);

    const listed = await listInstalledPlugins(authority);
    expect(await readPluginVersion(first.destination)).toBe("2.0.0");
    expect(listed.plugins.map((plugin) => plugin.version)).toEqual(["2.0.0"]);
    expect((await listChildNames(pluginStorageRoot)).some((name) => name.includes(".bak-")))
      .toBe(false);
  });

  it("recovers a first install that crashed after destination replacement by removing it", async () => {
    const { root, agencHome, workspaceRoot, pluginStorageRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot, pluginStorageRoot);

    await expect(installPluginOp({
      ...authority,
      source: await writePlugin(root, "fresh", "1.0.0"),
      installTransactionHooks: crashAfter("destination-replaced"),
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);

    expect((await listChildNames(pluginStorageRoot)).some((name) => name.includes("fresh")))
      .toBe(true);

    const listed = await listInstalledPlugins(authority);
    expect(listed.plugins).toEqual([]);
    expect((await listChildNames(pluginStorageRoot)).some((name) =>
      name.includes("fresh") || name.includes(".stage-") || name.includes(".bak-")
    )).toBe(false);
  });

  it("recovers a first install that crashed after staging by removing the stage", async () => {
    const { root, agencHome, workspaceRoot, pluginStorageRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot, pluginStorageRoot);

    await expect(installPluginOp({
      ...authority,
      source: await writePlugin(root, "fresh", "1.0.0"),
      installTransactionHooks: crashAfter("stage-ready"),
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);

    expect((await listChildNames(pluginStorageRoot)).some((name) => name.includes(".stage-")))
      .toBe(true);

    const listed = await listInstalledPlugins(authority);
    expect(listed.plugins).toEqual([]);
    expect((await listChildNames(pluginStorageRoot)).some((name) =>
      name.includes("fresh") || name.includes(".stage-")
    )).toBe(false);
  });

  it("rejects a changed backup instead of restoring or deleting it", async () => {
    const { root, agencHome, workspaceRoot, pluginStorageRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot, pluginStorageRoot);
    const first = await installPluginOp({
      ...authority,
      source: await writePlugin(root, "demo", "1.0.0"),
    });

    await expect(updatePluginOp({
      ...authority,
      pluginId: "demo",
      source: await writePlugin(root, "demo", "2.0.0"),
      installTransactionHooks: crashAfter("destination-replaced"),
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);

    const backupName = (await listChildNames(pluginStorageRoot)).find((name) =>
      name.includes(".bak-")
    );
    expect(backupName).toBeDefined();
    const backupPath = join(pluginStorageRoot, backupName!);
    await writeFile(
      join(backupPath, ".agenc-plugin", "plugin.json"),
      JSON.stringify({
        name: "demo",
        version: "1.0.0-tampered",
        commands: "./commands",
      }, null, 2),
    );

    const recovery = await recoverPluginInstallTransactions({
      installRoots: [pluginStorageRoot],
    });
    expect(recovery.recovered).toBe(0);
    expect(recovery.issues.some((issue) => /identity changed/u.test(issue.message))).toBe(true);
    expect(await readPluginVersion(first.destination)).toBe("2.0.0");
    expect(await readPluginVersion(backupPath)).toBe("1.0.0-tampered");
    expect(await pathExists(backupPath)).toBe(true);
  });

  it("rejects a changed stage instead of deleting it", async () => {
    const { root, agencHome, workspaceRoot, pluginStorageRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot, pluginStorageRoot);
    const first = await installPluginOp({
      ...authority,
      source: await writePlugin(root, "demo", "1.0.0"),
    });

    await expect(updatePluginOp({
      ...authority,
      pluginId: "demo",
      source: await writePlugin(root, "demo", "2.0.0"),
      installTransactionHooks: crashAfter("stage-ready"),
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);

    const stageName = (await listChildNames(pluginStorageRoot)).find((name) =>
      name.includes(".stage-")
    );
    expect(stageName).toBeDefined();
    const stagePath = join(pluginStorageRoot, stageName!);
    await writeFile(join(stagePath, "commands", "hello.md"), "# tampered\n");
    await writeFile(
      join(stagePath, ".agenc-plugin", "plugin.json"),
      JSON.stringify({
        name: "demo",
        version: "2.0.0-tampered",
        commands: "./commands",
      }, null, 2),
    );

    const recovery = await recoverPluginInstallTransactions({
      installRoots: [pluginStorageRoot],
    });
    expect(recovery.recovered).toBe(0);
    expect(recovery.issues.some((issue) => /identity changed/u.test(issue.message))).toBe(true);
    expect(await readPluginVersion(first.destination)).toBe("1.0.0");
    expect(await pathExists(stagePath)).toBe(true);
    expect(await readPluginVersion(stagePath)).toBe("2.0.0-tampered");
  });

  it("does not discover stage or backup directories as installed plugins", async () => {
    const { root, agencHome, workspaceRoot, pluginStorageRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot, pluginStorageRoot);
    const first = await installPluginOp({
      ...authority,
      source: await writePlugin(root, "demo", "1.0.0"),
    });

    await expect(updatePluginOp({
      ...authority,
      pluginId: "demo",
      source: await writePlugin(root, "demo", "2.0.0"),
      installTransactionHooks: crashAfter("destination-replaced"),
    })).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);

    const children = await listChildNames(pluginStorageRoot);
    expect(children.some((name) => name.includes(".bak-"))).toBe(true);
    expect(await readPluginVersion(first.destination)).toBe("2.0.0");

    const loaded = await loadPlugins({
      pluginStorageRoot,
      workspaceRoot,
      config: { plugins: { enabled: true } },
      readOnly: true,
    });
    expect(loaded.enabled.map((plugin) => plugin.version)).toEqual(["2.0.0"]);
    expect(loaded.enabled).toHaveLength(1);
  });
});
