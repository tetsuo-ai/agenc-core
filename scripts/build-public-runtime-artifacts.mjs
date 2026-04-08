#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(repoRoot, "runtime");
const wrapperDir = path.join(repoRoot, "packages", "agenc");
const wrapperGeneratedDir = path.join(wrapperDir, "generated");
const supportedPlatformArch = new Set(["linux-x64"]);

function parseArgs(argv) {
  const options = {
    outDir: path.join(repoRoot, "artifacts", "public-runtime"),
    artifactBaseUrl: null,
    privateKeyFile: null,
    keyId: null,
    releaseRepository: "tetsuo-ai/agenc-core",
    releaseTag: null,
    runtimeVersionOverride: null,
    allowMissingBundledExternalPlugins: false,
    skipBuild: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--out-dir":
        options.outDir = path.resolve(argv[++index]);
        break;
      case "--artifact-base-url":
        options.artifactBaseUrl = argv[++index];
        break;
      case "--private-key-file":
        options.privateKeyFile = path.resolve(argv[++index]);
        break;
      case "--key-id":
        options.keyId = argv[++index];
        break;
      case "--release-repository":
        options.releaseRepository = argv[++index];
        break;
      case "--release-tag":
        options.releaseTag = argv[++index];
        break;
      case "--runtime-version-override":
        options.runtimeVersionOverride = argv[++index];
        break;
      case "--allow-missing-bundled-external-plugins":
        options.allowMissingBundledExternalPlugins = true;
        break;
      case "--skip-build":
        options.skipBuild = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function run(command, args, cwd, env = process.env) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function syncWrapperGeneratedRuntimeMetadata(outDir) {
  await mkdir(wrapperGeneratedDir, { recursive: true });
  const files = [
    "agenc-runtime-manifest.json",
    "agenc-runtime-manifest.json.sig",
    "agenc-runtime-public-key.pem",
    "agenc-runtime-trust-policy.json",
  ];
  for (const fileName of files) {
    await copyFile(
      path.join(outDir, fileName),
      path.join(wrapperGeneratedDir, fileName),
    );
  }
}

async function resolveLocalWorkspaceDependencyDirs(runtimePackage) {
  const dependencyEntries = Object.entries(runtimePackage.dependencies ?? {});
  if (dependencyEntries.length === 0) {
    return [];
  }

  const packageLock = await readJson(path.join(repoRoot, "package-lock.json"));
  const packages = packageLock.packages ?? {};
  const localWorkspaceDeps = [];

  for (const [dependencyName, dependencyVersion] of dependencyEntries) {
    const workspaceEntry = Object.entries(packages).find(([packagePath, pkg]) => {
      if (!packagePath || packagePath.startsWith("node_modules/")) {
        return false;
      }
      return (
        pkg &&
        typeof pkg === "object" &&
        pkg.name === dependencyName &&
        pkg.version === dependencyVersion
      );
    });
    if (!workspaceEntry) {
      continue;
    }
    localWorkspaceDeps.push({
      name: dependencyName,
      version: dependencyVersion,
      directory: path.join(repoRoot, workspaceEntry[0]),
    });
  }

  return localWorkspaceDeps;
}

async function resolveBundledExternalPlugins(
  runtimePackage,
  { allowMissing = false } = {},
) {
  const declared = runtimePackage.agenc?.bundledExternalPlugins ?? [];
  if (!Array.isArray(declared) || declared.length === 0) {
    return [];
  }

  const resolved = [];
  for (const entry of declared) {
    if (!entry || typeof entry !== "object") {
      throw new Error(
        `[public-runtime] runtime/package.json#agenc.bundledExternalPlugins entries must be objects with name + siblingRepoPath`,
      );
    }
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const siblingRepoPath =
      typeof entry.siblingRepoPath === "string"
        ? entry.siblingRepoPath.trim()
        : "";
    if (!name || !siblingRepoPath) {
      throw new Error(
        `[public-runtime] bundledExternalPlugins entry missing required name or siblingRepoPath: ${JSON.stringify(entry)}`,
      );
    }
    const directory = path.resolve(repoRoot, siblingRepoPath);
    if (!existsSync(directory)) {
      if (allowMissing) {
        process.stdout.write(
          `[public-runtime] skipping bundled external plugin "${name}" because ${directory} is not present in this checkout\n`,
        );
        continue;
      }
      throw new Error(
        `[public-runtime] bundled external plugin "${name}" expected at ${directory} but the directory does not exist. ` +
          `Clone the sibling repo next to agenc-core or remove the entry from runtime/package.json#agenc.bundledExternalPlugins.`,
      );
    }
    const pluginPackagePath = path.join(directory, "package.json");
    if (!existsSync(pluginPackagePath)) {
      throw new Error(
        `[public-runtime] bundled external plugin "${name}" at ${directory} is missing package.json`,
      );
    }
    const pluginPackage = await readJson(pluginPackagePath);
    if (pluginPackage.name !== name) {
      throw new Error(
        `[public-runtime] bundled external plugin name mismatch: runtime/package.json declares "${name}" but ${pluginPackagePath} reports "${pluginPackage.name}"`,
      );
    }
    resolved.push({
      name,
      directory,
      version: pluginPackage.version,
    });
  }
  return resolved;
}

function buildBundledExternalPlugin(plugin) {
  process.stdout.write(
    `[public-runtime] preparing bundled external plugin ${plugin.name} from ${plugin.directory}\n`,
  );
  run("npm", ["install", "--no-fund", "--no-audit"], plugin.directory);
  run("npm", ["run", "build"], plugin.directory);
}

async function buildKeys(options) {
  if (options.privateKeyFile) {
    const privateKeyPem = await readFile(options.privateKeyFile, "utf8");
    return {
      keyId: options.keyId ?? "release-signing-key",
      privateKeyPem,
      publicKeyPem: createPublicKey(privateKeyPem).export({
        type: "spki",
        format: "pem",
      }),
    };
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId: options.keyId ?? "local-dev",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runtimePackage = await readJson(path.join(runtimeDir, "package.json"));
  const wrapperPackage = await readJson(path.join(wrapperDir, "package.json"));
  const runtimeVersion =
    options.runtimeVersionOverride ?? runtimePackage.version;
  const platform = process.platform;
  const arch = process.arch;
  const platformArch = `${platform}-${arch}`;

  if (!supportedPlatformArch.has(platformArch)) {
    throw new Error(
      `unsupported build host ${platformArch}; supported public runtime artifact targets: ${Array.from(supportedPlatformArch).sort().join(", ")}`,
    );
  }

  const dashboardIndexPath = path.join(
    runtimeDir,
    "dist",
    "dashboard",
    "index.html",
  );

  if (!options.skipBuild) {
    process.stdout.write("[public-runtime] building @tetsuo-ai/runtime\n");
    run("npm", ["run", "build", "--workspace=@tetsuo-ai/runtime"], repoRoot);
    process.stdout.write("[public-runtime] building @tetsuo-ai/web\n");
    run(
      "npm",
      ["run", "build", "--workspace=@tetsuo-ai/web"],
      repoRoot,
      {
        ...process.env,
        AGENC_DASHBOARD_BASE: "/ui/",
      },
    );
    process.stdout.write("[public-runtime] syncing dashboard assets into runtime/dist/dashboard\n");
    run("node", ["scripts/sync-dashboard-assets.mjs"], repoRoot);
  } else if (!existsSync(dashboardIndexPath)) {
    throw new Error(
      `dashboard bundle missing at ${dashboardIndexPath}; build @tetsuo-ai/web and sync dashboard assets before using --skip-build`,
    );
  }

  await mkdir(options.outDir, { recursive: true });
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenc-public-runtime."));
  let runtimeTarballPath = null;
  const localDependencyTarballs = [];

  try {
    const packed = JSON.parse(run("npm", ["pack", "--json"], runtimeDir))[0];
    if (!packed?.filename) {
      throw new Error("npm pack did not return a tarball filename for @tetsuo-ai/runtime");
    }
    runtimeTarballPath = path.join(runtimeDir, packed.filename);

    const localWorkspaceDeps = await resolveLocalWorkspaceDependencyDirs(
      runtimePackage,
    );
    for (const dependency of localWorkspaceDeps) {
      const dependencyPack = JSON.parse(
        run("npm", ["pack", "--json"], dependency.directory),
      )[0];
      if (!dependencyPack?.filename) {
        throw new Error(`npm pack did not return a tarball filename for ${dependency.name}`);
      }
      localDependencyTarballs.push(
        path.join(dependency.directory, dependencyPack.filename),
      );
    }

    const bundledExternalPlugins = await resolveBundledExternalPlugins(
      runtimePackage,
      {
        allowMissing: options.allowMissingBundledExternalPlugins,
      },
    );
    if (!options.skipBuild) {
      for (const plugin of bundledExternalPlugins) {
        buildBundledExternalPlugin(plugin);
      }
    } else {
      for (const plugin of bundledExternalPlugins) {
        const distEntry = path.join(plugin.directory, "dist", "index.js");
        if (!existsSync(distEntry)) {
          throw new Error(
            `[public-runtime] bundled external plugin "${plugin.name}" has no dist/index.js at ${distEntry}; ` +
              `build it before using --skip-build`,
          );
        }
      }
    }

    const installRoot = path.join(tempRoot, "install-root");
    await mkdir(installRoot, { recursive: true });
    run("npm", ["init", "-y"], installRoot);
    // --install-links forces npm to materialize copies for any local file: or
    // directory installs (the bundled external plugin sibling repos) instead
    // of writing symlinks back to the source tree. Symlinks are unsafe here:
    // npm computes them relative to the temp install root, and once the
    // tarball is extracted on a user machine the symlink target is meaningless.
    run(
      "npm",
      [
        "install",
        "--install-links",
        "--omit=dev",
        "--no-fund",
        "--no-audit",
        ...localDependencyTarballs,
        runtimeTarballPath,
        ...bundledExternalPlugins.map((plugin) => plugin.directory),
      ],
      installRoot,
    );

    const metadata = {
      builtAt: new Date().toISOString(),
      runtimeVersion,
      wrapperVersion: wrapperPackage.version,
      platform,
      arch,
      nodeRange: runtimePackage.engines?.node ?? ">=18.0.0",
      bins: {
        agenc: "node_modules/@tetsuo-ai/runtime/dist/bin/agenc.js",
        "agenc-runtime": "node_modules/@tetsuo-ai/runtime/dist/bin/agenc-runtime.js",
        daemon: "node_modules/@tetsuo-ai/runtime/dist/bin/daemon.js",
        "agenc-watch": "node_modules/@tetsuo-ai/runtime/dist/bin/agenc-watch.js",
      },
      bundledExternalPlugins: bundledExternalPlugins.map((plugin) => ({
        name: plugin.name,
        version: plugin.version,
      })),
    };
    await writeFile(
      path.join(installRoot, "agenc-runtime-installation.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );

    const artifactFilename = `agenc-runtime-${runtimeVersion}-${platform}-${arch}.tar.gz`;
    const artifactPath = path.join(options.outDir, artifactFilename);
    run("tar", ["-czf", artifactPath, "-C", installRoot, "."], repoRoot);
    const artifactSha = sha256(await readFile(artifactPath));
    const artifactUrl = options.artifactBaseUrl
      ? `${options.artifactBaseUrl.replace(/\/+$/u, "")}/${artifactFilename}`
      : pathToFileURL(artifactPath).href;

    const keys = await buildKeys(options);
    const manifest = {
      manifestVersion: 1,
      wrapperVersion: wrapperPackage.version,
      keyId: keys.keyId,
      generatedAt: new Date().toISOString(),
      releaseChannel: options.artifactBaseUrl ? "github-releases" : "local-dev",
      releaseRepository: options.releaseRepository,
      releaseTag: options.releaseTag ?? `agenc-v${wrapperPackage.version}`,
      artifacts: [
        {
          platform,
          arch,
          nodeRange: runtimePackage.engines?.node ?? ">=18.0.0",
          runtimeVersion,
          url: artifactUrl,
          sha256: artifactSha,
          bins: metadata.bins,
        },
      ],
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const signature = sign(null, manifestBytes, keys.privateKeyPem).toString("base64");
    const trustPolicy = {
      wrapperVersion: wrapperPackage.version,
      keyId: keys.keyId,
      releaseChannel: manifest.releaseChannel,
      releaseRepository: manifest.releaseRepository,
      releaseTag: manifest.releaseTag,
      revokedManifestDigests: [],
      revokedRuntimeVersions: [],
    };

    await writeFile(
      path.join(options.outDir, "agenc-runtime-manifest.json"),
      manifestBytes,
    );
    await writeFile(
      path.join(options.outDir, "agenc-runtime-manifest.json.sig"),
      `${signature}\n`,
      "utf8",
    );
    await writeFile(
      path.join(options.outDir, "agenc-runtime-public-key.pem"),
      keys.publicKeyPem,
      "utf8",
    );
    await writeFile(
      path.join(options.outDir, "agenc-runtime-trust-policy.json"),
      `${JSON.stringify(trustPolicy, null, 2)}\n`,
      "utf8",
    );

    // Keep the wrapper's embedded runtime metadata in sync with the freshly
    // built public artifacts so local `agenc onboard` does not verify against
    // a stale generated manifest.
    await syncWrapperGeneratedRuntimeMetadata(options.outDir);

    process.stdout.write(
      `${JSON.stringify(
        {
          outDir: options.outDir,
          generatedDir: wrapperGeneratedDir,
          artifactFilename,
          artifactPath,
          manifestPath: path.join(options.outDir, "agenc-runtime-manifest.json"),
          trustPolicyPath: path.join(
            options.outDir,
            "agenc-runtime-trust-policy.json",
          ),
          publicKeyPath: path.join(
            options.outDir,
            "agenc-runtime-public-key.pem",
          ),
          releaseChannel: manifest.releaseChannel,
          releaseRepository: manifest.releaseRepository,
          releaseTag: manifest.releaseTag,
          platform,
          arch,
          runtimeVersion,
          wrapperVersion: wrapperPackage.version,
          artifactSha256: artifactSha,
          artifactUrl,
          bundledExternalPlugins: bundledExternalPlugins.map((plugin) => ({
            name: plugin.name,
            version: plugin.version,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    for (const tarballPath of localDependencyTarballs) {
      await unlink(tarballPath).catch(() => {});
    }
    if (runtimeTarballPath) {
      await unlink(runtimeTarballPath).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
