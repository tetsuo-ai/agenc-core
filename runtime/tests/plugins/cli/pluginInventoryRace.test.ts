import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listInstalledPlugins } from "../../../src/plugins/cli/pluginOperations.js";
import { pluginSignaturePayloadBytes } from "../../../src/plugins/resolution.js";

const race = vi.hoisted(() => ({ restore: undefined as undefined | (() => Promise<void>) }));
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
});
