import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

import {
  classifyPluginSource,
  findPluginReverseDependents,
  pluginSignaturePayloadBytes,
  pluginSourceCacheRoot,
  qualifyPluginDependency,
  resolvePluginSource,
  resolvePluginDependencyClosure,
  verifyResolvedPluginSignature,
  verifyPluginDependencyState,
  type PluginFetchTelemetry,
  type PluginProcessRunner,
} from "./resolution.js";
import { installPluginOp, updatePluginOp } from "./cli/pluginOperations.js";
import { loadPlugins, type LoadedPlugin } from "./loader.js";

const execFileAsync = promisify(execFile);

describe("plugin source resolution", () => {
  test("resolves npm packages before using git, tarball, or bundle handlers", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const calls: string[] = [];
      const runProcess: PluginProcessRunner = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "npm") {
          const packDir = String(args[args.indexOf("--pack-destination") + 1]);
          await writeFile(join(packDir, "demo-1.0.0.tgz"), "fixture");
          return {
            stdout: JSON.stringify([{ filename: "demo-1.0.0.tgz" }]),
            stderr: "",
          };
        }
        if (command === "tar") {
          if (args[0] === "-tzf") {
            return { stdout: safeTarListing("package"), stderr: "" };
          }
          if (args[0] === "-tvzf") {
            return { stdout: safeTarVerboseListing("package"), stderr: "" };
          }
          const extractRoot = String(args[args.indexOf("-C") + 1]);
          await writePlugin(join(extractRoot, "package"), "demo");
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected process: ${command}`);
      };

      const events: PluginFetchTelemetry[] = [];
      const resolved = await resolvePluginSource("@tetsuo-ai/demo-plugin", {
        agencHome,
        workspaceRoot: root,
        runProcess,
        onTelemetry: (event) => events.push(event),
      });

      expect(resolved.kind).toBe("npm");
      expect(calls[0]).toMatch(/^npm pack --json --pack-destination .+ -- @tetsuo-ai\/demo-plugin$/u);
      expect(calls.some((call) => call.startsWith("tar -xzf"))).toBe(true);
      await expect(access(join(resolved.pluginRoot, ".agenc-plugin", "plugin.json"))).resolves.toBeUndefined();
      expect(events.at(-1)).toMatchObject({ kind: "npm", outcome: "success" });
      await resolved.cleanup();
    });
  });

  test("rejects unsafe remote sources before spawning package or git tools", async () => {
    await withTempDir(async (root) => {
      const runProcess: PluginProcessRunner = async (command, args) => {
        throw new Error(`unexpected process: ${command} ${args.join(" ")}`);
      };

      await expect(
        resolvePluginSource("-bad", {
          agencHome: join(root, "home"),
          workspaceRoot: root,
          runProcess,
        }),
      ).rejects.toThrow(/leading dashes/u);
      await expect(
        resolvePluginSource("git+--upload-pack=bad", {
          agencHome: join(root, "home"),
          workspaceRoot: root,
          runProcess,
        }),
      ).rejects.toThrow(/invalid git plugin source/u);
    });
  });

  test("install operation copies a resolved remote source into the plugin store", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      let npmPacks = 0;
      const runProcess: PluginProcessRunner = async (command, args) => {
        if (command === "npm") {
          npmPacks += 1;
          const packDir = String(args[args.indexOf("--pack-destination") + 1]);
          await writeFile(join(packDir, "remote-1.0.0.tgz"), "fixture");
          return {
            stdout: JSON.stringify([{ filename: "remote-1.0.0.tgz" }]),
            stderr: "",
          };
        }
        if (command === "tar") {
          if (args[0] === "-tzf") {
            return { stdout: safeTarListing("package"), stderr: "" };
          }
          if (args[0] === "-tvzf") {
            return { stdout: safeTarVerboseListing("package"), stderr: "" };
          }
          const extractRoot = String(args[args.indexOf("-C") + 1]);
          await writePlugin(join(extractRoot, "package"), "remote-demo");
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected process: ${command}`);
      };

      const installed = await installPluginOp({
        source: "@tetsuo-ai/remote-demo",
        agencHome,
        workspaceRoot: root,
        runResolutionProcess: runProcess,
        requireSignature: false,
        now: () => new Date("2026-05-05T00:00:00.000Z"),
      });

      expect(installed.resolutionKind).toBe("npm");
      expect(installed.signatureVerified).toBe(false);
      await expect(access(join(installed.destination, ".agenc-plugin", "plugin.json"))).resolves.toBeUndefined();
      await expect(
        readFile(join(installed.destination, ".agenc-plugin", "agenc-install.json"), "utf8"),
      ).resolves.toContain('"resolutionKind": "npm"');
      await expect(
        readFile(join(installed.destination, ".agenc-plugin", "agenc-install.json"), "utf8"),
      ).resolves.toContain('"source": "@tetsuo-ai/remote-demo"');

      const updated = await updatePluginOp({
        pluginId: "remote-demo",
        agencHome,
        workspaceRoot: root,
        runResolutionProcess: runProcess,
        requireSignature: false,
      });
      expect(updated.source).toBe("@tetsuo-ai/remote-demo");
      expect(updated.resolutionKind).toBe("npm");
      expect(npmPacks).toBe(2);
    });
  });

  test("install operation requires a trusted signature for remote sources by default", async () => {
    await withTempDir(async (root) => {
      const runProcess: PluginProcessRunner = async (command, args) => {
        if (command === "npm") {
          const packDir = String(args[args.indexOf("--pack-destination") + 1]);
          await writeFile(join(packDir, "unsigned-1.0.0.tgz"), "fixture");
          return {
            stdout: JSON.stringify([{ filename: "unsigned-1.0.0.tgz" }]),
            stderr: "",
          };
        }
        if (command === "tar") {
          if (args[0] === "-tzf") {
            return { stdout: safeTarListing("package"), stderr: "" };
          }
          if (args[0] === "-tvzf") {
            return { stdout: safeTarVerboseListing("package"), stderr: "" };
          }
          const extractRoot = String(args[args.indexOf("-C") + 1]);
          await writePlugin(join(extractRoot, "package"), "unsigned-demo");
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected process: ${command}`);
      };

      await expect(
        installPluginOp({
          source: "@tetsuo-ai/unsigned-demo",
          agencHome: join(root, "home"),
          workspaceRoot: root,
          runResolutionProcess: runProcess,
        }),
      ).rejects.toThrow(/plugin signature is required/u);
    });
  });

  test("uses the plugin cache on repeated remote resolutions", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      let runs = 0;
      const calls: string[] = [];
      const runProcess: PluginProcessRunner = async (command, args) => {
        runs += 1;
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "git") {
          const target = String(args.at(-1));
          await writePlugin(target, "git-demo");
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected process: ${command}`);
      };

      const first = await resolvePluginSource("git@github.com:tetsuo-ai/plugin.git", {
        agencHome,
        workspaceRoot: root,
        runProcess,
      });
      await first.cleanup();
      const events: PluginFetchTelemetry[] = [];
      const second = await resolvePluginSource("git@github.com:tetsuo-ai/plugin.git", {
        agencHome,
        workspaceRoot: root,
        runProcess,
        onTelemetry: (event) => events.push(event),
      });

      expect(first.pluginRoot).toBe(pluginSourceCacheRoot(agencHome, "git@github.com:tetsuo-ai/plugin.git"));
      expect(second.pluginRoot).toBe(first.pluginRoot);
      expect(runs).toBe(1);
      expect(calls[0]).toMatch(/^git clone --depth 1 -- git@github.com:tetsuo-ai\/plugin.git /u);
      expect(events.at(-1)).toMatchObject({ kind: "git", outcome: "cache_hit" });
      await second.cleanup();
    });
  });

  test("resolves registry tarballs and remote bundle archives", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const calls: string[] = [];
      const runProcess: PluginProcessRunner = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "tar") {
          if (args[0] === "-tzf") {
            return { stdout: safeTarListing("package"), stderr: "" };
          }
          if (args[0] === "-tvzf") {
            return { stdout: safeTarVerboseListing("package"), stderr: "" };
          }
          const extractRoot = String(args[args.indexOf("-C") + 1]);
          await writePlugin(join(extractRoot, "package"), "tarball-demo");
          return { stdout: "", stderr: "" };
        }
        if (command === "unzip") {
          if (args[0] === "-Z1") {
            return { stdout: safeZipListing(), stderr: "" };
          }
          if (args[0] === "-Z" && args[1] === "-v") {
            return { stdout: safeZipVerboseListing(), stderr: "" };
          }
          const extractRoot = String(args[args.indexOf("-d") + 1]);
          await writePlugin(extractRoot, "bundle-demo");
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected process: ${command}`);
      };

      const tarball = await resolvePluginSource("https://agenc.tech/plugins/demo.tgz", {
        agencHome,
        workspaceRoot: root,
        runProcess,
        fetchBytes: async () => new Uint8Array([1, 2, 3]),
      });
      const bundle = await resolvePluginSource("https://agenc.tech/plugins/bundle.mcpb", {
        agencHome,
        workspaceRoot: root,
        runProcess,
        fetchBytes: async () => new Uint8Array([4, 5, 6]),
      });

      expect(tarball.kind).toBe("tarball");
      expect(bundle.kind).toBe("mcpb");
      expect(calls.some((call) => call.startsWith("tar -xzf"))).toBe(true);
      expect(calls.some((call) => call.startsWith("unzip -q"))).toBe(true);
      await tarball.cleanup();
      await bundle.cleanup();
    });
  });

  test("extracts real tar and zip archives through the platform tools", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const sourceRoot = join(root, "source");
      await writePlugin(sourceRoot, "real-archive");
      const tarballPath = join(root, "real.tgz");
      await execFileAsync("tar", ["-czf", tarballPath, "-C", sourceRoot, "."]);
      const plainTarPath = join(root, "real.tar");
      await execFileAsync("tar", ["-cf", plainTarPath, "-C", sourceRoot, "."]);
      const zipPath = join(root, "real.mcpb");
      await execFileAsync("zip", ["-qr", zipPath, "."], { cwd: sourceRoot });

      const tarball = await resolvePluginSource("https://agenc.tech/plugins/real.tgz", {
        agencHome,
        workspaceRoot: root,
        fetchBytes: async () => await readFile(tarballPath),
      });
      const bundle = await resolvePluginSource("https://agenc.tech/plugins/real.mcpb", {
        agencHome,
        workspaceRoot: root,
        refreshCache: true,
        fetchBytes: async () => await readFile(zipPath),
      });
      const plainTar = await resolvePluginSource("https://agenc.tech/plugins/real.tar", {
        agencHome,
        workspaceRoot: root,
        refreshCache: true,
        fetchBytes: async () => await readFile(plainTarPath),
      });

      await expect(access(join(tarball.pluginRoot, ".agenc-plugin", "plugin.json"))).resolves.toBeUndefined();
      await expect(access(join(bundle.pluginRoot, ".agenc-plugin", "plugin.json"))).resolves.toBeUndefined();
      await expect(access(join(plainTar.pluginRoot, ".agenc-plugin", "plugin.json"))).resolves.toBeUndefined();
      await tarball.cleanup();
      await bundle.cleanup();
      await plainTar.cleanup();
    });
  });

  test("rejects zip symlink entries before extraction", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const sourceRoot = join(root, "source");
      await writePlugin(sourceRoot, "zip-link");
      await symlink("commands/hello.md", join(sourceRoot, "link.md"));
      const zipPath = join(root, "link.mcpb");
      await execFileAsync("zip", ["-qry", zipPath, "."], { cwd: sourceRoot });

      await expect(
        resolvePluginSource("https://agenc.tech/plugins/link.mcpb", {
          agencHome,
          workspaceRoot: root,
          fetchBytes: async () => await readFile(zipPath),
        }),
      ).rejects.toThrow(/unsafe zip entry type/u);
    });
  });

  test("rejects archive traversal entries before extraction", async () => {
    await withTempDir(async (root) => {
      const runProcess: PluginProcessRunner = async (command, args) => {
        if (command === "tar" && args[0] === "-tzf") {
          return { stdout: "../escape\n", stderr: "" };
        }
        throw new Error(`unexpected process: ${command} ${args.join(" ")}`);
      };

      await expect(
        resolvePluginSource("https://agenc.tech/plugins/bad.tgz", {
          agencHome: join(root, "home"),
          workspaceRoot: root,
          runProcess,
          fetchBytes: async () => new Uint8Array([1, 2, 3]),
        }),
      ).rejects.toThrow(/escapes extraction root/u);
    });
  });

  test("rejects archives that exceed extraction quotas", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const sourceRoot = join(root, "source");
      await writePlugin(sourceRoot, "quota-demo");
      const tarballPath = join(root, "quota.tgz");
      await execFileAsync("tar", ["-czf", tarballPath, "-C", sourceRoot, "."]);

      await expect(
        resolvePluginSource("https://agenc.tech/plugins/quota.tgz", {
          agencHome,
          workspaceRoot: root,
          fetchBytes: async () => await readFile(tarballPath),
          maxExtractedFiles: 0,
        }),
      ).rejects.toThrow(/maximum extracted file count/u);
    });
  });

  test("resolves dependency closures and demotes plugins with unsatisfied dependencies", async () => {
    const lookup = async (id: string) => {
      const dependencies: Record<string, readonly string[]> = {
        "app@main": ["lib"],
        "lib@main": [],
      };
      return id in dependencies ? { dependencies: dependencies[id] } : null;
    };

    await expect(
      resolvePluginDependencyClosure("app@main", lookup),
    ).resolves.toEqual({
      ok: true,
      closure: ["lib@main", "app@main"],
    });
    await expect(
      resolvePluginDependencyClosure("app@main", async () => ({ dependencies: ["lib@other"] })),
    ).resolves.toMatchObject({
      ok: false,
      reason: "cross-marketplace",
      dependency: "lib@other",
    });
    await expect(
      resolvePluginDependencyClosure(
        "app@main",
        async () => ({ dependencies: ["lib@other"] }),
        new Set(["lib@other"]),
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: "cross-marketplace",
      dependency: "lib@other",
    });
    await expect(
      resolvePluginDependencyClosure("app@main", async (id) => ({
        dependencies: id === "app@main" ? ["lib"] : ["app"],
      })),
    ).resolves.toMatchObject({
      ok: false,
      reason: "cycle",
      chain: ["app@main", "lib@main", "app@main"],
    });

    expect(qualifyPluginDependency("lib", "app@main")).toBe("lib@main");
    const state = verifyPluginDependencyState([
      loadedPlugin("app", "app@main", true, ["lib"]),
      loadedPlugin("lib", "lib@main", false),
      loadedPlugin("addon", "addon@main", true, ["app"]),
    ]);
    expect([...state.demoted].sort()).toEqual(["addon@main", "app@main"]);
    expect(state.errors.map((issue) => issue.reason)).toContain("not-enabled");
    const crossMarketplaceState = verifyPluginDependencyState([
      loadedPlugin("app", "app@main", true, ["lib@other"]),
      loadedPlugin("lib", "lib@other", true),
    ]);
    expect([...crossMarketplaceState.demoted]).toEqual(["app@main"]);
    expect(crossMarketplaceState.errors).toContainEqual(expect.objectContaining({
      source: "app@main",
      dependency: "lib@other",
      reason: "cross-marketplace",
    }));
    expect(findPluginReverseDependents("app@main", [
      loadedPlugin("app", "app@main", true),
      loadedPlugin("addon", "addon@main", true, ["app"]),
    ])).toEqual(["addon"]);
  });

  test("loader demotes configured plugins whose dependencies are disabled", async () => {
    await withTempDir(async (root) => {
      const workspaceRoot = join(root, "workspace");
      const appRoot = join(workspaceRoot, "vendor", "app");
      const libRoot = join(workspaceRoot, "vendor", "lib");
      await writePlugin(appRoot, "app", ["lib"]);
      await writePlugin(libRoot, "lib");

      const result = await loadPlugins({
        agencHome: join(root, "home"),
        workspaceRoot,
        config: {
          plugins: {
            enabled: {
              "app@main": { path: "vendor/app" },
              "lib@main": { path: "vendor/lib", enabled: false },
            },
          },
        },
      });

      expect(result.enabled.map((plugin) => plugin.name)).toEqual([]);
      expect(result.disabled.map((plugin) => plugin.name).sort()).toEqual(["app", "lib"]);
      expect(result.errors).toContainEqual(expect.objectContaining({
        type: "dependency",
        source: "app@main",
        plugin: "app",
      }));
    });
  });

  test("loader demotes configured plugins with cross-marketplace dependencies", async () => {
    await withTempDir(async (root) => {
      const workspaceRoot = join(root, "workspace");
      const appRoot = join(workspaceRoot, "vendor", "app");
      const libRoot = join(workspaceRoot, "vendor", "lib");
      await writePlugin(appRoot, "app", ["lib@other"]);
      await writePlugin(libRoot, "lib");

      const result = await loadPlugins({
        agencHome: join(root, "home"),
        workspaceRoot,
        config: {
          plugins: {
            enabled: {
              "app@main": { path: "vendor/app" },
              "lib@other": { path: "vendor/lib" },
            },
          },
        },
      });

      expect(result.enabled.map((plugin) => plugin.name)).toEqual(["lib"]);
      expect(result.disabled.map((plugin) => plugin.name)).toEqual(["app"]);
      expect(result.errors).toContainEqual(expect.objectContaining({
        type: "dependency",
        source: "app@main",
        plugin: "app",
        message: "Plugin dependency lib@other is cross-marketplace",
      }));
    });
  });

  test("loader demotes configured plugins with dependency cycles", async () => {
    await withTempDir(async (root) => {
      const workspaceRoot = join(root, "workspace");
      const appRoot = join(workspaceRoot, "vendor", "app");
      const libRoot = join(workspaceRoot, "vendor", "lib");
      await writePlugin(appRoot, "app", ["lib"]);
      await writePlugin(libRoot, "lib", ["app"]);

      const result = await loadPlugins({
        agencHome: join(root, "home"),
        workspaceRoot,
        config: {
          plugins: {
            enabled: {
              "app@main": { path: "vendor/app" },
              "lib@main": { path: "vendor/lib" },
            },
          },
        },
      });

      expect(result.enabled.map((plugin) => plugin.name)).toEqual([]);
      expect(result.disabled.map((plugin) => plugin.name).sort()).toEqual(["app", "lib"]);
      expect(result.errors.map((issue) => issue.message)).toContain("Plugin dependency app@main is cycle");
      expect(result.errors.map((issue) => issue.message)).toContain("Plugin dependency lib@main is cycle");
    });
  });

  test("stale cache locks are expired before a fresh resolution", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const source = "git@github.com:tetsuo-ai/stale-lock.git";
      const cacheRoot = pluginSourceCacheRoot(agencHome, source);
      const lockRoot = `${cacheRoot}.lock`;
      await mkdir(lockRoot, { recursive: true });
      const old = new Date(Date.now() - 120_000);
      await utimes(lockRoot, old, old);
      let runs = 0;
      const runProcess: PluginProcessRunner = async (command, args) => {
        runs += 1;
        if (command === "git") {
          await writePlugin(String(args.at(-1)), "stale-lock");
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected process: ${command}`);
      };

      const resolved = await resolvePluginSource(source, {
        agencHome,
        workspaceRoot: root,
        runProcess,
      });

      expect(resolved.pluginRoot).toBe(cacheRoot);
      expect(runs).toBe(1);
      await expect(access(lockRoot)).rejects.toThrow();
      await resolved.cleanup();
    });
  });

  test("verifies Ed25519 signatures against the publisher keyring", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "signed");
      const manifestPath = await writePlugin(pluginRoot, "signed-demo");
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const files = await pluginPayloadFiles(pluginRoot);
      const signature = sign(
        null,
        pluginSignaturePayloadBytes(await readFile(manifestPath), files),
        privateKey,
      ).toString("base64");
      await writeJson(join(pluginRoot, ".agenc-plugin", "signature.json"), {
        publisher: "tetsuo",
        signature,
        files,
      });
      const publishersPath = join(root, "plugin-publishers.json");
      await writeJson(publishersPath, {
        publishers: {
          tetsuo: {
            publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
          },
        },
      });

      await expect(
        verifyResolvedPluginSignature(pluginRoot, {
          publishersPath,
          requireSignature: true,
        }),
      ).resolves.toMatchObject({
        present: true,
        verified: true,
        publisher: "tetsuo",
        payloadFileCount: 1,
      });

      const emptyPublishersPath = join(root, "empty-publishers.json");
      await writeJson(emptyPublishersPath, { publishers: {} });
      await expect(
        verifyResolvedPluginSignature(pluginRoot, {
          publishersPath: emptyPublishersPath,
          requireSignature: true,
        }),
      ).rejects.toThrow(/not trusted/u);

      const extraPath = join(pluginRoot, "commands", "extra.md");
      await writeFile(extraPath, "# Extra\n");
      await expect(
        verifyResolvedPluginSignature(pluginRoot, {
          publishersPath,
          requireSignature: true,
        }),
      ).rejects.toThrow(/digest set does not match/u);
      await rm(extraPath);

      await writeFile(join(pluginRoot, "commands", "hello.md"), "# Tampered\n");
      await expect(
        verifyResolvedPluginSignature(pluginRoot, {
          publishersPath,
          requireSignature: true,
        }),
      ).rejects.toThrow(/digest mismatch/u);
    });
  });

  test("classifies local, bundle, git, tarball, and npm sources", async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, "local"), { recursive: true });

      await expect(classifyPluginSource("local", root)).resolves.toBe("local");
      await expect(classifyPluginSource("plugin.mcpb", root)).resolves.toBe("mcpb");
      await expect(classifyPluginSource("https://agenc.tech/plugin.mcpb", root)).resolves.toBe("mcpb");
      await expect(classifyPluginSource("git@github.com:tetsuo-ai/plugin.git", root)).resolves.toBe("git");
      await expect(classifyPluginSource("https://github.com/tetsuo-ai/plugin", root)).resolves.toBe("git");
      await expect(classifyPluginSource("https://agenc.tech/plugin.tgz", root)).resolves.toBe("tarball");
      await expect(classifyPluginSource("@tetsuo-ai/plugin", root)).resolves.toBe("npm");
    });
  });
});

function loadedPlugin(
  name: string,
  source: string,
  enabled: boolean,
  dependencies: readonly string[] = [],
): LoadedPlugin {
  return {
    name,
    root: "",
    source,
    enabled,
    manifest: {
      name,
      ...(dependencies.length > 0 ? { dependencies } : {}),
    },
    commandsPaths: [],
    commands: [],
    agentsPaths: [],
    skillsPaths: [],
    outputStylesPaths: [],
    hookSources: [],
    mcpServers: {},
    lspServers: {},
    appConnectorIds: [],
    errors: [],
  };
}

async function pluginPayloadFiles(root: string): Promise<Record<string, string>> {
  return {
    "commands/hello.md": `sha256:${createHash("sha256")
      .update(await readFile(join(root, "commands", "hello.md")))
      .digest("hex")}`,
  };
}

function safeTarListing(root: string): string {
  return [
    `${root}/.agenc-plugin/plugin.json`,
    `${root}/commands/hello.md`,
  ].join("\n");
}

function safeTarVerboseListing(root: string): string {
  return [
    `-rw-r--r-- 0/0 0 2026-05-05 00:00 ${root}/.agenc-plugin/plugin.json`,
    `-rw-r--r-- 0/0 0 2026-05-05 00:00 ${root}/commands/hello.md`,
  ].join("\n");
}

function safeZipListing(): string {
  return [
    ".agenc-plugin/plugin.json",
    "commands/hello.md",
  ].join("\n");
}

function safeZipVerboseListing(): string {
  return [
    "Central directory entry #1:",
    "  .agenc-plugin/plugin.json",
    "  Unix file attributes (100660 octal):            -rw-rw----",
    "Central directory entry #2:",
    "  commands/hello.md",
    "  Unix file attributes (100660 octal):            -rw-rw----",
  ].join("\n");
}

async function writePlugin(
  root: string,
  name: string,
  dependencies: readonly string[] = [],
): Promise<string> {
  const manifestPath = join(root, ".agenc-plugin", "plugin.json");
  await writeJson(manifestPath, {
    name,
    version: "1.0.0",
    ...(dependencies.length > 0 ? { dependencies } : {}),
    commands: "./commands",
  });
  await mkdir(join(root, "commands"), { recursive: true });
  await writeFile(join(root, "commands", "hello.md"), "# Hello\n");
  return manifestPath;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function withTempDir(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agenc-plugin-resolution-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
