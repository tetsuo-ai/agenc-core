import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vitest";
import { strToU8, zipSync } from "fflate";

import {
  classifyPluginSource,
  findPluginReverseDependents,
  pluginSignaturePayloadBytes,
  pluginSourceCacheRoot,
  qualifyPluginDependency,
  redactPluginSource,
  resolvePluginSource,
  resolvePluginDependencyClosure,
  verifyResolvedPluginSignature,
  verifyPluginDependencyState,
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

      const resolved = await resolvePluginSource("@tetsuo-ai/demo-plugin", {
        agencHome,
        workspaceRoot: root,
        runProcess,
        requireSignature: false,
      });

      expect(resolved.kind).toBe("npm");
      expect(calls[0]).toMatch(/^npm pack --json --pack-destination .+ -- @tetsuo-ai\/demo-plugin$/u);
      expect(calls.some((call) => call.startsWith("tar -xzf"))).toBe(true);
      await expect(access(join(resolved.pluginRoot, ".agenc-plugin", "plugin.json"))).resolves.toBeUndefined();
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

  test("direct resolver requires a trusted signature for remote sources by default", async () => {
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
        resolvePluginSource("@tetsuo-ai/unsigned-plugin", {
          agencHome: join(root, "home"),
          workspaceRoot: root,
          runProcess,
        }),
      ).rejects.toThrow(/plugin signature is required/u);
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

  test("loader uses installed remote dependency identities from install metadata", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const packSources: string[] = [];
      const runProcess: PluginProcessRunner = async (command, args) => {
        if (command === "npm") {
          const source = String(args.at(-1));
          packSources.push(source);
          const packDir = String(args[args.indexOf("--pack-destination") + 1]);
          const filename = `${source.replace(/[^a-z0-9._-]/giu, "-")}.tgz`;
          await writeFile(join(packDir, filename), "fixture");
          return {
            stdout: JSON.stringify([{ filename }]),
            stderr: "",
          };
        }
        if (command === "tar") {
          if (args[0] === "-tzf") return { stdout: safeTarListing("package"), stderr: "" };
          if (args[0] === "-tvzf") return { stdout: safeTarVerboseListing("package"), stderr: "" };
          const source = packSources.shift();
          const extractRoot = String(args[args.indexOf("-C") + 1]);
          await writePlugin(
            join(extractRoot, "package"),
            source === "app@main" ? "app" : "lib",
            source === "app@main" ? ["lib@main"] : [],
          );
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected process: ${command}`);
      };

      await installPluginOp({
        source: "lib@main",
        agencHome,
        workspaceRoot: root,
        runResolutionProcess: runProcess,
        requireSignature: false,
      });
      await installPluginOp({
        source: "app@main",
        agencHome,
        workspaceRoot: root,
        runResolutionProcess: runProcess,
        requireSignature: false,
      });

      const result = await loadPlugins({
        agencHome,
        workspaceRoot: root,
        config: {
          plugins: { enabled: true },
        },
      });

      expect(result.enabled.map((plugin) => plugin.name).sort()).toEqual(["app", "lib"]);
      expect(result.enabled.find((plugin) => plugin.name === "app")?.source).toBe("app@main");
      expect(result.enabled.find((plugin) => plugin.name === "lib")?.source).toBe("lib@main");
      expect(result.errors.filter((issue) => issue.type === "dependency")).toEqual([]);
    });
  });

  test("strips VCS metadata from installed plugin copies", async () => {
    await withTempDir(async (root) => {
      const sourceRoot = join(root, "source");
      await writePlugin(sourceRoot, "local-vcs");
      await mkdir(join(sourceRoot, ".git"), { recursive: true });
      await writeFile(join(sourceRoot, ".git", "config"), "[remote \"origin\"]\nurl = https://token@agenc.tech/private.git\n");

      const installed = await installPluginOp({
        source: sourceRoot,
        agencHome: join(root, "home"),
        workspaceRoot: root,
      });

      await expect(access(join(installed.destination, ".agenc-plugin", "plugin.json"))).resolves.toBeUndefined();
      await expect(access(join(installed.destination, ".git", "config"))).rejects.toThrow();
    });
  });

  test("rejects reserved internal install names", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const cacheRoot = join(agencHome, "plugins", "cache");
      await mkdir(cacheRoot, { recursive: true });
      await writeFile(join(cacheRoot, "marker"), "keep");
      const sourceRoot = join(root, "source");
      await writePlugin(sourceRoot, "cache");

      await expect(
        installPluginOp({
          source: sourceRoot,
          agencHome,
          workspaceRoot: root,
        }),
      ).rejects.toThrow(/reserved for AgenC internal storage/u);
      await expect(
        installPluginOp({
          source: sourceRoot,
          name: "cache",
          agencHome,
          workspaceRoot: root,
        }),
      ).rejects.toThrow(/reserved for AgenC internal storage/u);
      await expect(
        updatePluginOp({
          pluginId: "cache",
          source: sourceRoot,
          agencHome,
          workspaceRoot: root,
        }),
      ).rejects.toThrow(/reserved for AgenC internal storage/u);
      await expect(access(join(cacheRoot, "marker"))).resolves.toBeUndefined();
    });
  });

  test("redacts credential-bearing remote sources from metadata and errors", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const credentialSource = "https://opaque-token@agenc.tech/plugins/private.tgz?access_token=secretvalue";
      const runProcess: PluginProcessRunner = async (command, args) => {
        if (command === "tar") {
          if (args[0] === "-tzf") return { stdout: safeTarListing("package"), stderr: "" };
          if (args[0] === "-tvzf") return { stdout: safeTarVerboseListing("package"), stderr: "" };
          const extractRoot = String(args[args.indexOf("-C") + 1]);
          await writePlugin(join(extractRoot, "package"), "private-demo");
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected process: ${command}`);
      };

      const installed = await installPluginOp({
        source: credentialSource,
        agencHome,
        workspaceRoot: root,
        runResolutionProcess: runProcess,
        fetchResolutionBytes: async () => Buffer.from("fixture"),
        requireSignature: false,
      });
      const metadata = await readFile(
        join(installed.destination, ".agenc-plugin", "agenc-install.json"),
        "utf8",
      );

      expect(redactPluginSource(credentialSource)).toBe("https://redacted@agenc.tech/plugins/private.tgz?redacted=1");
      expect(metadata).toContain('"sourceRedacted": true');
      expect(metadata).toContain('"source": "https://redacted@agenc.tech/plugins/private.tgz?redacted=1"');
      expect(metadata).not.toContain("opaque-token");
      expect(metadata).not.toContain("secretvalue");
      await expect(
        updatePluginOp({
          pluginId: "private-demo",
          agencHome,
          workspaceRoot: root,
          runResolutionProcess: runProcess,
        }),
      ).rejects.toThrow(/no recorded source/u);

      let errorMessage = "";
      try {
        await resolvePluginSource("git+https://opaque-token@agenc.tech/private/repo.git?access_token=secretvalue", {
          agencHome,
          workspaceRoot: root,
          runProcess: async () => {
            throw new Error("fatal: https://opaque-token@agenc.tech/private/repo.git?access_token=secretvalue denied");
          },
        });
      } catch (error) {
        errorMessage = String((error as Error).message);
      }
      expect(errorMessage).toContain("https://redacted@agenc.tech/private/repo.git?redacted=1");
      expect(errorMessage).not.toContain("opaque-token");
      expect(errorMessage).not.toContain("secretvalue");
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
        requireSignature: false,
      });
      await first.cleanup();
      const second = await resolvePluginSource("git@github.com:tetsuo-ai/plugin.git", {
        agencHome,
        workspaceRoot: root,
        runProcess,
        requireSignature: false,
      });

      expect(first.pluginRoot).toBe(pluginSourceCacheRoot(agencHome, "git@github.com:tetsuo-ai/plugin.git"));
      expect(second.pluginRoot).toBe(first.pluginRoot);
      expect(runs).toBe(1);
      expect(calls[0]).toMatch(/^git clone --depth 1 -- git@github.com:tetsuo-ai\/plugin.git /u);
      await second.cleanup();
    });
  });

  test("rematerializes corrupt cache hits when signatures are optional", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const source = "git@github.com:tetsuo-ai/corrupt-cache.git";
      const cacheRoot = pluginSourceCacheRoot(agencHome, source);
      await mkdir(cacheRoot, { recursive: true });
      await writeFile(join(cacheRoot, "stale.txt"), "not a plugin");
      let runs = 0;
      const runProcess: PluginProcessRunner = async (command, args) => {
        if (command === "git") {
          runs += 1;
          await writePlugin(String(args.at(-1)), "corrupt-cache");
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected process: ${command}`);
      };

      const resolved = await resolvePluginSource(source, {
        agencHome,
        workspaceRoot: root,
        runProcess,
        requireSignature: false,
      });

      expect(resolved.pluginRoot).toBe(cacheRoot);
      expect(runs).toBe(1);
      await expect(access(join(cacheRoot, ".agenc-plugin", "plugin.json"))).resolves.toBeUndefined();
      await expect(access(join(cacheRoot, "stale.txt"))).rejects.toThrow();
      await resolved.cleanup();
    });
  });

  test("verifies signed git resolutions while ignoring repository metadata", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publishersPath = join(root, "plugin-publishers.json");
      await writeJson(publishersPath, {
        publishers: {
          tetsuo: {
            publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
          },
        },
      });
      const runProcess: PluginProcessRunner = async (command, args) => {
        if (command !== "git") throw new Error(`unexpected process: ${command}`);
        const target = String(args.at(-1));
        const manifestPath = await writePlugin(target, "signed-git");
        const files = await pluginPayloadFiles(target);
        const signature = sign(
          null,
          pluginSignaturePayloadBytes(await readFile(manifestPath), files),
          privateKey,
        ).toString("base64");
        await writeJson(join(target, ".agenc-plugin", "signature.json"), {
          publisher: "tetsuo",
          signature,
          files,
        });
        await mkdir(join(target, ".git"), { recursive: true });
        await writeFile(join(target, ".git", "config"), "[core]\nrepositoryformatversion = 0\n");
        return { stdout: "", stderr: "" };
      };

      const resolved = await resolvePluginSource("git@github.com:tetsuo-ai/signed-plugin.git", {
        agencHome,
        workspaceRoot: root,
        runProcess,
        publishersPath,
      });

      expect(resolved.kind).toBe("git");
      expect(resolved.signature).toMatchObject({
        required: true,
        present: true,
        verified: true,
        publisher: "tetsuo",
      });
      await expect(access(join(resolved.pluginRoot, ".git", "config"))).rejects.toThrow();
      await resolved.cleanup();
    });
  });

  test("keeps installed signed plugins verifiable after writing install metadata", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publishersPath = join(root, "plugin-publishers.json");
      await writeJson(publishersPath, {
        publishers: {
          tetsuo: {
            publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
          },
        },
      });
      const runProcess: PluginProcessRunner = async (command, args) => {
        if (command !== "git") throw new Error(`unexpected process: ${command}`);
        const target = String(args.at(-1));
        const manifestPath = await writePlugin(target, "signed-install");
        const files = await pluginPayloadFiles(target);
        const signature = sign(
          null,
          pluginSignaturePayloadBytes(await readFile(manifestPath), files),
          privateKey,
        ).toString("base64");
        await writeJson(join(target, ".agenc-plugin", "signature.json"), {
          publisher: "tetsuo",
          signature,
          files,
        });
        return { stdout: "", stderr: "" };
      };

      const installed = await installPluginOp({
        source: "git@github.com:tetsuo-ai/signed-install.git",
        agencHome,
        workspaceRoot: root,
        runResolutionProcess: runProcess,
        publishersPath,
      });

      await expect(access(join(installed.destination, ".agenc-plugin", "agenc-install.json"))).resolves.toBeUndefined();
      await expect(
        verifyResolvedPluginSignature(installed.destination, {
          publishersPath,
          requireSignature: true,
        }),
      ).resolves.toMatchObject({
        required: true,
        present: true,
        verified: true,
        publisher: "tetsuo",
      });
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
        requireSignature: false,
        fetchBytes: async () => new Uint8Array([1, 2, 3]),
      });
      const bundle = await resolvePluginSource("https://agenc.tech/plugins/bundle.mcpb", {
        agencHome,
        workspaceRoot: root,
        runProcess,
        requireSignature: false,
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

  test("rejects remote archive redirects to a different origin", async () => {
    await withTempDir(async (root) => {
      const fetchMock = vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: {
            location: "http://127.0.0.1/private.tgz",
          },
        })
      );
      vi.stubGlobal("fetch", fetchMock);
      try {
        await expect(
          resolvePluginSource("https://agenc.tech/plugins/redirect.tgz", {
            agencHome: join(root, "home"),
            workspaceRoot: root,
            requireSignature: false,
          }),
        ).rejects.toThrow(/redirects must stay on https:\/\/agenc\.tech/u);
        expect(fetchMock).toHaveBeenCalledWith(
          "https://agenc.tech/plugins/redirect.tgz",
          expect.objectContaining({ redirect: "manual" }),
        );
      } finally {
        vi.unstubAllGlobals();
      }
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
      await writeFile(zipPath, pluginZipBytes("real-archive"));

      const tarball = await resolvePluginSource("https://agenc.tech/plugins/real.tgz", {
        agencHome,
        workspaceRoot: root,
        requireSignature: false,
        fetchBytes: async () => await readFile(tarballPath),
      });
      const bundle = await resolvePluginSource("https://agenc.tech/plugins/real.mcpb", {
        agencHome,
        workspaceRoot: root,
        refreshCache: true,
        requireSignature: false,
        fetchBytes: async () => await readFile(zipPath),
      });
      const plainTar = await resolvePluginSource("https://agenc.tech/plugins/real.tar", {
        agencHome,
        workspaceRoot: root,
        refreshCache: true,
        requireSignature: false,
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
      const zipPath = join(root, "link.mcpb");
      await writeFile(zipPath, pluginZipBytes("zip-link", true));

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

  test("rejects unsupported tar entry types before extraction", async () => {
    await withTempDir(async (root) => {
      const calls: string[] = [];
      const runProcess: PluginProcessRunner = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "tar") {
          if (args[0] === "-tzf") {
            return {
              stdout: [
                "package/.agenc-plugin/plugin.json",
                "package/commands/hello.md",
                "package/runtime.pipe",
              ].join("\n"),
              stderr: "",
            };
          }
          if (args[0] === "-tvzf") {
            return {
              stdout: [
                "-rw-r--r-- 0/0 0 2026-05-05 00:00 package/.agenc-plugin/plugin.json",
                "prw-r--r-- 0/0 0 2026-05-05 00:00 package/runtime.pipe",
              ].join("\n"),
              stderr: "",
            };
          }
        }
        throw new Error(`unexpected process: ${command} ${args.join(" ")}`);
      };

      await expect(
        resolvePluginSource("https://agenc.tech/plugins/bad-entry.tgz", {
          agencHome: join(root, "home"),
          workspaceRoot: root,
          fetchBytes: async () => Buffer.from("fixture"),
          runProcess,
        }),
      ).rejects.toThrow(/unsupported tar entry type/u);
      expect(calls.some((call) => call.startsWith("tar -xzf"))).toBe(false);
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

  test("rejects archive quota metadata before extraction", async () => {
    await withTempDir(async (root) => {
      const calls: string[] = [];
      const runProcess: PluginProcessRunner = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "tar") {
          if (args[0] === "-tzf") return { stdout: safeTarListing("package"), stderr: "" };
          if (args[0] === "-tvzf") {
            return {
              stdout: [
                "-rw-r--r-- 0/0 2048 2026-05-05 00:00 package/.agenc-plugin/plugin.json",
                "-rw-r--r-- 0/0 2048 2026-05-05 00:00 package/commands/hello.md",
              ].join("\n"),
              stderr: "",
            };
          }
        }
        throw new Error(`unexpected process: ${command} ${args.join(" ")}`);
      };

      await expect(
        resolvePluginSource("https://agenc.tech/plugins/quota.tgz", {
          agencHome: join(root, "home"),
          workspaceRoot: root,
          fetchBytes: async () => Buffer.from("fixture"),
          runProcess,
          maxExtractedBytes: 128,
        }),
      ).rejects.toThrow(/maximum extracted size/u);
      expect(calls.some((call) => call.startsWith("tar -xzf"))).toBe(false);
    });
  });

  test("rejects bundle quota metadata before extraction", async () => {
    await withTempDir(async (root) => {
      const calls: string[] = [];
      const runProcess: PluginProcessRunner = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "unzip") {
          if (args[0] === "-Z1") return { stdout: safeZipListing(), stderr: "" };
          if (args[0] === "-Z" && args[1] === "-v") {
            return {
              stdout: [
                safeZipVerboseListing(),
                "  uncompressed size:                            2048 bytes",
              ].join("\n"),
              stderr: "",
            };
          }
        }
        throw new Error(`unexpected process: ${command} ${args.join(" ")}`);
      };

      await expect(
        resolvePluginSource("https://agenc.tech/plugins/quota.mcpb", {
          agencHome: join(root, "home"),
          workspaceRoot: root,
          fetchBytes: async () => Buffer.from("fixture"),
          runProcess,
          maxExtractedBytes: 128,
        }),
      ).rejects.toThrow(/maximum extracted size/u);
      expect(calls.some((call) => call.startsWith("unzip -q"))).toBe(false);
    });
  });

  test("resolves dependency closures and demotes plugins with unsatisfied dependencies", async () => {
    const lookup = async (id: string) => {
      const entries: Record<string, { dependencies: readonly string[]; version: string }> = {
        "app@main": { dependencies: ["lib"], version: "1.0.0" },
        "lib@main": { dependencies: [], version: "1.5.0" },
      };
      return entries[id] ?? null;
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
        version: "1.0.0",
      })),
    ).resolves.toMatchObject({
      ok: false,
      reason: "cycle",
      chain: ["app@main", "lib@main", "app@main"],
    });
    await expect(
      resolvePluginDependencyClosure("app@main", async (id) => {
        const entries: Record<string, { dependencies: readonly string[]; version: string }> = {
          "app@main": { dependencies: ["lib@^1.0.0"], version: "1.0.0" },
          "lib@main": { dependencies: [], version: "1.5.0" },
        };
        return entries[id] ?? null;
      }),
    ).resolves.toEqual({
      ok: true,
      closure: ["lib@main", "app@main"],
    });
    await expect(
      resolvePluginDependencyClosure("app@main", async (id) => {
        const entries: Record<string, { dependencies: readonly string[]; version: string }> = {
          "app@main": { dependencies: ["lib@=1.5.0"], version: "1.0.0" },
          "lib@main": { dependencies: [], version: "1.5.0" },
        };
        return entries[id] ?? null;
      }),
    ).resolves.toEqual({
      ok: true,
      closure: ["lib@main", "app@main"],
    });
    await expect(
      resolvePluginDependencyClosure("app@main", async (id) => {
        const entries: Record<string, { dependencies: readonly string[]; version: string }> = {
          "app@main": { dependencies: ["lib@~1.5.0"], version: "1.0.0" },
          "lib@main": { dependencies: [], version: "1.5.3" },
        };
        return entries[id] ?? null;
      }),
    ).resolves.toEqual({
      ok: true,
      closure: ["lib@main", "app@main"],
    });
    await expect(
      resolvePluginDependencyClosure("app@main", async (id) => {
        const entries: Record<string, { dependencies: readonly string[]; version: string }> = {
          "app@main": { dependencies: ["lib@>=1.4.0"], version: "1.0.0" },
          "lib@main": { dependencies: [], version: "1.5.0" },
        };
        return entries[id] ?? null;
      }),
    ).resolves.toEqual({
      ok: true,
      closure: ["lib@main", "app@main"],
    });
    await expect(
      resolvePluginDependencyClosure("app@main", async (id) => {
        const entries: Record<string, { dependencies: readonly string[]; version: string }> = {
          "app@main": { dependencies: ["lib@=1.5.0+build.1"], version: "1.0.0" },
          "lib@main": { dependencies: [], version: "1.5.0+build.2" },
        };
        return entries[id] ?? null;
      }),
    ).resolves.toEqual({
      ok: true,
      closure: ["lib@main", "app@main"],
    });
    await expect(
      resolvePluginDependencyClosure("app@main", async (id) => {
        const entries: Record<string, { dependencies: readonly string[]; version: string }> = {
          "app@main": { dependencies: ["lib@^2.0.0"], version: "1.0.0" },
          "lib@main": { dependencies: [], version: "1.5.0" },
        };
        return entries[id] ?? null;
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "version-mismatch",
      dependency: "lib@main",
      requiredVersion: "^2.0.0",
      actualVersion: "1.5.0",
    });
    await expect(
      resolvePluginDependencyClosure("app@main", async (id) => {
        const entries: Record<string, { dependencies: readonly string[]; version: string }> = {
          "app@main": { dependencies: ["lib@<1.5.0"], version: "1.0.0" },
          "lib@main": { dependencies: [], version: "1.5.0" },
        };
        return entries[id] ?? null;
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "version-mismatch",
      dependency: "lib@main",
      requiredVersion: "<1.5.0",
      actualVersion: "1.5.0",
    });
    await expect(
      resolvePluginDependencyClosure("app@main", async (id) => {
        const entries: Record<string, { dependencies: readonly string[]; version: string }> = {
          "app@main": { dependencies: ["lib@>=1.5.0"], version: "1.0.0" },
          "lib@main": { dependencies: [], version: "1.5.0-beta.1" },
        };
        return entries[id] ?? null;
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "version-mismatch",
      dependency: "lib@main",
      requiredVersion: ">=1.5.0",
      actualVersion: "1.5.0-beta.1",
    });
    await expect(
      resolvePluginDependencyClosure("app@main", async (id) => {
        const entries: Record<string, { dependencies: readonly string[]; version: string }> = {
          "app@main": { dependencies: ["lib@>=1.0.0"], version: "1.0.0" },
          "lib@main": { dependencies: [], version: "1.5.0-invalid!" },
        };
        return entries[id] ?? null;
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "version-mismatch",
      dependency: "lib@main",
      requiredVersion: ">=1.0.0",
      actualVersion: "1.5.0-invalid!",
    });
    await expect(
      resolvePluginDependencyClosure("app@main", async (id) => {
        const entries: Record<string, { dependencies: readonly string[]; version: string }> = {
          "app@main": { dependencies: ["lib@^0.0.3"], version: "1.0.0" },
          "lib@main": { dependencies: [], version: "0.0.3" },
        };
        return entries[id] ?? null;
      }),
    ).resolves.toEqual({
      ok: true,
      closure: ["lib@main", "app@main"],
    });
    await expect(
      resolvePluginDependencyClosure("app@main", async (id) => {
        const entries: Record<string, { dependencies: readonly string[]; version: string }> = {
          "app@main": { dependencies: ["lib@^0.0.3"], version: "1.0.0" },
          "lib@main": { dependencies: [], version: "0.0.4" },
        };
        return entries[id] ?? null;
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "version-mismatch",
      dependency: "lib@main",
      requiredVersion: "^0.0.3",
      actualVersion: "0.0.4",
    });

    expect(qualifyPluginDependency("lib", "app@main")).toBe("lib@main");
    expect(qualifyPluginDependency("lib@^1.0.0", "app@main")).toBe("lib@main");
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
    const duplicateNameState = verifyPluginDependencyState([
      loadedPlugin("app", "local-app", true, ["lib"]),
      loadedPlugin("lib", "local-lib-a", true),
      loadedPlugin("lib", "local-lib-b", true),
    ]);
    expect([...duplicateNameState.demoted]).toEqual(["local-app"]);
    expect(duplicateNameState.errors).toContainEqual(expect.objectContaining({
      source: "local-app",
      dependency: "lib",
      reason: "ambiguous",
    }));
    const localPathState = verifyPluginDependencyState([
      loadedPlugin("app", "/tmp/agenc@workspace/plugins/app", true, ["lib"]),
      loadedPlugin("lib", "/tmp/agenc@workspace/plugins/lib", true),
    ]);
    expect([...localPathState.demoted]).toEqual([]);
    expect(localPathState.errors).toEqual([]);
    const versionSatisfiedState = verifyPluginDependencyState([
      loadedPlugin("app", "app@main", true, ["lib@^1.0.0"]),
      loadedPlugin("lib", "lib@main", true, [], "1.5.0"),
    ]);
    expect([...versionSatisfiedState.demoted]).toEqual([]);
    expect(versionSatisfiedState.errors).toEqual([]);
    const versionMismatchState = verifyPluginDependencyState([
      loadedPlugin("app", "app@main", true, ["lib@^2.0.0"]),
      loadedPlugin("lib", "lib@main", true, [], "1.5.0"),
    ]);
    expect([...versionMismatchState.demoted]).toEqual(["app@main"]);
    expect(versionMismatchState.errors).toContainEqual(expect.objectContaining({
      source: "app@main",
      dependency: "lib@main",
      reason: "version-mismatch",
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
            enabled: true,
            plugins: {
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

  test("loader keeps local dependencies enabled when workspace paths contain at signs", async () => {
    await withTempDir(async (root) => {
      const workspaceRoot = join(root, "workspace@team");
      const appRoot = join(workspaceRoot, ".agents", "plugins", "app");
      const libRoot = join(workspaceRoot, ".agents", "plugins", "lib");
      await writePlugin(appRoot, "app", ["lib"]);
      await writePlugin(libRoot, "lib");

      const result = await loadPlugins({
        agencHome: join(root, "home"),
        workspaceRoot,
        config: {
          plugins: { enabled: true },
        },
      });

      expect(result.enabled.map((plugin) => plugin.name).sort()).toEqual(["app", "lib"]);
      expect(result.errors.filter((issue) => issue.type === "dependency")).toEqual([]);
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
            enabled: true,
            plugins: {
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
            enabled: true,
            plugins: {
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
        requireSignature: false,
      });

      expect(resolved.pluginRoot).toBe(cacheRoot);
      expect(runs).toBe(1);
      await expect(access(lockRoot)).rejects.toThrow();
      await resolved.cleanup();
    });
  });

  test("serializes concurrent same-source cache resolutions", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const source = "git@github.com:tetsuo-ai/concurrent-cache.git";
      const cacheRoot = pluginSourceCacheRoot(agencHome, source);
      let cloneStartedResolve!: () => void;
      let releaseClone!: () => void;
      const cloneStarted = new Promise<void>((resolve) => {
        cloneStartedResolve = resolve;
      });
      const cloneReleased = new Promise<void>((resolve) => {
        releaseClone = resolve;
      });
      let runs = 0;
      const runProcess: PluginProcessRunner = async (command, args) => {
        if (command === "git") {
          runs += 1;
          cloneStartedResolve();
          await cloneReleased;
          await writePlugin(String(args.at(-1)), "concurrent-cache");
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected process: ${command}`);
      };

      const firstPromise = resolvePluginSource(source, {
        agencHome,
        workspaceRoot: root,
        runProcess,
        requireSignature: false,
      });
      await cloneStarted;
      const secondPromise = resolvePluginSource(source, {
        agencHome,
        workspaceRoot: root,
        runProcess,
        requireSignature: false,
      });
      releaseClone();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      expect(first.pluginRoot).toBe(cacheRoot);
      expect(second.pluginRoot).toBe(cacheRoot);
      expect(runs).toBe(1);
      await first.cleanup();
      await second.cleanup();
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
      await expect(
        verifyResolvedPluginSignature(pluginRoot, {
          publishersPath,
          requireSignature: true,
          maxExtractedFiles: 0,
        }),
      ).rejects.toThrow(/signature payload exceeds maximum file count/u);

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
      await writeFile(join(root, "plugin.mcpb"), "fixture");

      await expect(classifyPluginSource("local", root)).resolves.toBe("local");
      await expect(classifyPluginSource("plugin.mcpb", root)).resolves.toBe("mcpb");
      await expect(classifyPluginSource("package-like.git", root)).resolves.toBe("npm");
      await expect(classifyPluginSource("package-like.mcpb", root)).resolves.toBe("npm");
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
  version?: string,
): LoadedPlugin {
  return {
    name,
    ...(version !== undefined ? { version } : {}),
    root: "",
    source,
    enabled,
    manifest: {
      name,
      ...(version !== undefined ? { version } : {}),
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

function pluginZipBytes(name: string, includeSymlink = false): Uint8Array {
  const regularFile = {
    attrs: (0o100644 << 16) >>> 0,
    mtime: new Date('2026-05-05T00:00:00Z'),
    os: 3,
  } as const;
  const files = {
    '.agenc-plugin/plugin.json': [
      strToU8(`${JSON.stringify({
        name,
        version: '1.0.0',
        commands: './commands',
      }, null, 2)}\n`),
      regularFile,
    ],
    'commands/hello.md': [strToU8('# Hello\n'), regularFile],
    ...(includeSymlink
      ? {
          'link.md': [
            strToU8('commands/hello.md'),
            {
              attrs: (0o120777 << 16) >>> 0,
              mtime: new Date('2026-05-05T00:00:00Z'),
              os: 3,
            } as const,
          ],
        }
      : {}),
  };
  return zipSync(files);
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
