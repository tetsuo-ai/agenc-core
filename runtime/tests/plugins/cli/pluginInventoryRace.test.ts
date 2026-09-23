import { generateKeyPairSync, sign } from "node:crypto";
import { cp, mkdir, mkdtemp, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listInstalledPlugins } from "../../../src/plugins/cli/pluginOperations.js";
import { pluginSignaturePayloadBytes } from "../../../src/plugins/resolution.js";

const race = vi.hoisted(() => ({
  restore: undefined as undefined | (() => Promise<void>),
  beforeCopy: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, cp: async (...args: Parameters<typeof actual.cp>) => {
    await race.beforeCopy?.();
    return actual.cp(...args);
  } };
});
vi.mock("../../../src/plugins/registration/load-plugin-commands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/plugins/registration/load-plugin-commands.js")>();
  return { ...actual, loadPluginCommands: async (...args: Parameters<typeof actual.loadPluginCommands>) => {
    await race.restore?.();
    return actual.loadPluginCommands(...args);
  } };
});

describe("installed plugin inventory snapshot", () => {
  it("never labels the earlier tampered manifest as verified after a signed version is restored", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-plugin-inventory-race-"));
    const workspaceRoot = join(home, "workspace");
    const pluginStorageRoot = join(home, "plugins");
    const pluginRoot = join(pluginStorageRoot, "alpha");
    const manifestPath = join(pluginRoot, ".agenc-plugin", "plugin.json");
    await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
    await mkdir(workspaceRoot);
    const signedManifest = Buffer.from(JSON.stringify({ name: "alpha", version: "1.0.0" }));
    const tamperedManifest = Buffer.from(JSON.stringify({ name: "alpha", version: "99.0.0" }));
    const files = {};
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    await writeFile(join(home, "plugin-publishers.json"), JSON.stringify({ publishers: {
      team: { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64") },
    } }));
    await writeFile(join(pluginRoot, ".agenc-plugin", "signature.json"), JSON.stringify({
      publisher: "team", files,
      signature: sign(null, pluginSignaturePayloadBytes(signedManifest, files), privateKey).toString("base64"),
    }));
    await writeFile(join(pluginRoot, ".agenc-plugin", "agenc-install.json"), JSON.stringify({
      source: pluginRoot, resolutionKind: "local", signatureRequired: true,
    }));
    await writeFile(manifestPath, tamperedManifest);
    race.restore = async () => { await writeFile(manifestPath, signedManifest); race.restore = undefined; };
    try {
      const listed = await listInstalledPlugins({ agencHome: home, pluginStorageRoot,
        workspaceRoot, sessionTempRoot: join(home, "temp"), env: {} });
      expect(listed.plugins).toHaveLength(1);
      expect(listed.plugins[0]).not.toMatchObject({ version: "99.0.0", verificationState: "verified" });
    } finally {
      race.restore = undefined;
    }
  });

  it("rejects a source root replaced with a symlink between discovery and copy", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-plugin-root-race-"));
    const workspaceRoot = join(home, "workspace");
    const pluginStorageRoot = join(home, "plugins");
    const pluginRoot = join(pluginStorageRoot, "alpha");
    const signedManifest = Buffer.from(JSON.stringify({ name: "alpha", version: "1.0.0" }));
    const tamperedManifest = Buffer.from(JSON.stringify({ name: "alpha", version: "99.0.0" }));
    await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
    await mkdir(workspaceRoot);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    await writeFile(join(home, "plugin-publishers.json"), JSON.stringify({ publishers: {
      team: { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64") },
    } }));
    await writeFile(join(pluginRoot, ".agenc-plugin", "signature.json"), JSON.stringify({
      publisher: "team", files: {},
      signature: sign(null, pluginSignaturePayloadBytes(signedManifest, {}), privateKey).toString("base64"),
    }));
    await writeFile(join(pluginRoot, ".agenc-plugin", "agenc-install.json"), JSON.stringify({
      source: pluginRoot, resolutionKind: "local", signatureRequired: true,
    }));
    await writeFile(join(pluginRoot, ".agenc-plugin", "plugin.json"), signedManifest);
    const attackerRoot = join(home, "attacker");
    await cp(pluginRoot, attackerRoot, { recursive: true });
    await writeFile(join(attackerRoot, ".agenc-plugin", "plugin.json"), tamperedManifest);
    race.beforeCopy = async () => {
      race.beforeCopy = undefined;
      await rename(pluginRoot, join(home, "original"));
      await symlink(attackerRoot, pluginRoot, "dir");
    };
    race.restore = async () => {
      race.restore = undefined;
      await writeFile(join(attackerRoot, ".agenc-plugin", "plugin.json"), signedManifest);
    };
    try {
      const listed = await listInstalledPlugins({ agencHome: home, pluginStorageRoot,
        workspaceRoot, sessionTempRoot: join(home, "temp"), env: {} });
      expect(listed.plugins).toHaveLength(1);
      expect(listed.plugins[0]).not.toMatchObject({ version: "99.0.0", verificationState: "verified" });
      expect(listed.plugins[0]?.verificationState).toBe("failed");
    } finally {
      race.beforeCopy = undefined;
      race.restore = undefined;
    }
  });

  it("returns screenshot and icon paths under the installed root after snapshot cleanup", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-plugin-assets-"));
    const workspaceRoot = join(home, "workspace");
    const pluginStorageRoot = join(home, "plugins");
    const pluginRoot = join(pluginStorageRoot, "alpha");
    await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "assets"));
    await mkdir(workspaceRoot);
    for (const name of ["logo.png", "screen.png", "icon.png"]) {
      await writeFile(join(pluginRoot, "assets", name), name);
    }
    await writeFile(join(pluginRoot, ".agenc-plugin", "plugin.json"), JSON.stringify({
      name: "alpha", interface: { logo: "./assets/logo.png",
        screenshots: ["./assets/screen.png"], composerIcon: "./assets/icon.png" },
    }));
    const listed = await listInstalledPlugins({ agencHome: home, pluginStorageRoot,
      workspaceRoot, sessionTempRoot: join(home, "temp"), env: {} });
    expect(listed.plugins[0]?.interface?.screenshots).toEqual([join(pluginRoot, "assets", "screen.png")]);
    expect(listed.plugins[0]?.interface?.composerIcon).toBe(join(pluginRoot, "assets", "icon.png"));
    expect(listed.plugins[0]?.logoPath).toBe(join(pluginRoot, "assets", "logo.png"));
    expect((await stat(listed.plugins[0]!.interface!.screenshots[0]!)).isFile()).toBe(true);
  });
});
