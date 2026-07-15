#!/usr/bin/env node

// Reproduce release-facing package outputs twice from Git's committed index.
// The second install is a fresh node_modules tree backed only by the first
// run's ephemeral npm cache. Docker is built twice from two additional
// pristine copies and both no-cache image identities must match.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { list as listTar } from "tar";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";
const PLAN = Object.freeze({
  version: 1,
  source: "committed Git index matching HEAD",
  cleanInstalls: 2,
  secondInstall: "fresh tree, ephemeral warm cache, npm offline mode",
  compared: [
    "installed dependency tree",
    "runtime dist and declarations",
    "SDK dist and declarations",
    "runtime release tarball and sidecar",
    "runtime, launcher, and SDK npm packages",
    "repository SPDX SBOM",
  ],
  docker:
    "two pristine-context no-cache builds with byte-identical recursive OCI layouts and hardened smokes",
});

function usage() {
  return `Usage: node scripts/check-clean-build.mjs [--skip-docker] [--keep-temp] [--plan]\n\n` +
    `Default behavior performs two clean, compared builds and two Docker builds.\n` +
    `--skip-docker is for focused development only and is not M0 acceptance.\n`;
}

function run(command, args, { cwd = repoRoot, env = process.env, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: capture ? "utf8" : undefined,
    shell: IS_WINDOWS,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `command failed (${result.status ?? result.signal}): ${command} ${args.join(" ")}`,
    );
  }
  return capture ? result.stdout.trim() : "";
}

function checkedJavaScriptProgram(program, label) {
  try {
    new Function(program);
  } catch (error) {
    throw new Error(`${label} is not valid JavaScript`, { cause: error });
  }
  return program;
}

function git(args, options = {}) {
  return run("git", args, { cwd: repoRoot, capture: true, ...options });
}

function ensureCleanCommittedSource() {
  run("git", ["diff", "--quiet", "--no-ext-diff", "HEAD", "--"], {
    cwd: repoRoot,
  });
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  if (untracked) {
    throw new Error(`clean-build source has untracked files:\n${untracked}`);
  }
  git(["ls-files", "--error-unmatch", "package-lock.json"]);
}

function checkoutIndex(destination, umask = 0o022) {
  const previousUmask = process.umask(umask);
  try {
    // The snapshot deliberately varies the checkout umask, while the security
    // tests require every mutable ancestor to remain private. Create the
    // snapshot root with an explicit mode inside the varied-umask boundary so
    // the test environment itself cannot invalidate that security invariant.
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    chmodSync(destination, 0o700);
    const prefix = destination.endsWith(sep) ? destination : `${destination}${sep}`;
    run("git", ["checkout-index", "--all", `--prefix=${prefix}`], {
      cwd: repoRoot,
    });
  } finally {
    process.umask(previousUmask);
  }
  for (const forbidden of [".git", "node_modules", join("runtime", "dist")]) {
    if (existsSync(join(destination, forbidden))) {
      throw new Error(`indexed source unexpectedly contains ${forbidden}`);
    }
  }
  assertTrackedSnapshot(destination);
}

function assertTrackedSnapshot(destination) {
  const expected = git(["ls-files", "--cached"])
    .split("\n")
    .filter(Boolean)
    .sort(utf8Compare);
  const actual = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), relativePath);
      } else {
        actual.push(relativePath);
      }
    }
  };
  visit(destination);
  actual.sort(utf8Compare);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const unexpected = actual.filter((entry) => !expectedSet.has(entry));
    const missing = expected.filter((entry) => !actualSet.has(entry));
    throw new Error(
      "clean-build source is not an exact tracked-index snapshot: " +
        `unexpected=${JSON.stringify(unexpected)}, missing=${JSON.stringify(missing)}`,
    );
  }
}

function pinnedNpmVersion(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const match = /^npm@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(pkg.packageManager ?? "");
  if (!match) throw new Error("packageManager must pin an exact npm version");
  return match[1];
}

function validateToolchain(expectedNpm) {
  const npmVersion = run("npm", ["--version"], { capture: true });
  if (npmVersion !== expectedNpm) {
    throw new Error(`clean build requires npm ${expectedNpm}; found ${npmVersion}`);
  }
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const releaseToolchain = JSON.parse(
    readFileSync(join(repoRoot, "release-toolchain.json"), "utf8"),
  );
  const range = rootPackage.devEngines?.runtime?.version ?? "";
  const rangeMatch = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.0\.0$/.exec(range);
  const nodeMatch = /^v([0-9]+)\./.exec(process.version);
  if (
    !rangeMatch ||
    Number(rangeMatch[4]) !== Number(rangeMatch[1]) + 1 ||
    !nodeMatch ||
    Number(nodeMatch[1]) !== Number(rangeMatch[1]) ||
    process.versions.node !== releaseToolchain.nodeVersion ||
    expectedNpm !== releaseToolchain.npmVersion
  ) {
    throw new Error(
      `clean build requires Node.js ${releaseToolchain.nodeVersion} and npm ${releaseToolchain.npmVersion}; ` +
        `found ${process.version} and npm ${expectedNpm}`,
    );
  }
  return { nodeVersion: process.version, npmVersion };
}

function sourceMetadata() {
  const sourceCommit = git(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40,64}$/.test(sourceCommit)) {
    throw new Error(`invalid source commit: ${sourceCommit}`);
  }
  const epochText = git(["show", "-s", "--format=%ct", "HEAD"]);
  if (!/^(0|[1-9][0-9]*)$/.test(epochText)) {
    throw new Error(`invalid source epoch: ${epochText}`);
  }
  const sourceDateEpoch = Number(epochText);
  return {
    sourceCommit,
    sourceDateEpoch,
    buildTime: new Date(sourceDateEpoch * 1000).toISOString(),
  };
}

function isolatedEnvironment({ root, cache, timezone, metadata, offline }) {
  const home = join(root, "home");
  const temp = join(root, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(temp, { recursive: true });
  const userConfig = join(home, ".npmrc");
  writeFileSync(userConfig, "");
  const nodePrefix = IS_WINDOWS
    ? process.env.npm_config_nodedir?.trim()
    : resolve(process.execPath, "..", "..");
  if (!nodePrefix || !isAbsolute(nodePrefix)) {
    throw new Error(
      "clean native builds require an absolute npm_config_nodedir on Windows",
    );
  }
  const nodeHeader = join(nodePrefix, "include", "node", "node.h");
  if (!existsSync(nodeHeader)) {
    throw new Error(`local Node.js headers are required for offline native builds: ${nodeHeader}`);
  }
  const inherited = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    if (process.env[name] !== undefined) inherited[name] = process.env[name];
  }
  return {
    ...inherited,
    AGENC_BUILD_COMMIT: metadata.sourceCommit,
    AGENC_BUILD_TIME: metadata.buildTime,
    AGENC_SKIP_POSTINSTALL: "1",
    CI: "true",
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    SOURCE_DATE_EPOCH: String(metadata.sourceDateEpoch),
    LANG: "C",
    LC_ALL: "C",
    TZ: timezone,
    npm_config_audit: "false",
    npm_config_build_from_source: "true",
    npm_config_cache: cache,
    npm_config_fund: "false",
    npm_config_offline: offline ? "true" : "false",
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_strict_allow_scripts: "true",
    npm_config_update_notifier: "false",
    npm_config_userconfig: userConfig,
    npm_config_nodedir: nodePrefix,
  };
}

function smokeExtractedRuntime({ artifact, root, env }) {
  const extracted = join(root, "runtime-smoke");
  mkdirSync(extracted, { recursive: true });
  run("tar", ["-xzf", artifact, "-C", extracted], { env });
  const script = String.raw`
    const { createRequire } = require("node:module");
    const { join } = require("node:path");
    const requireFromArtifact = createRequire(join(process.cwd(), "smoke.cjs"));
    const Database = requireFromArtifact("better-sqlite3");
    const db = new Database(":memory:");
    if (db.prepare("select 42 as value").get().value !== 42) process.exit(20);
    db.close();
    const pty = requireFromArtifact("node-pty");
    const child = pty.spawn(process.execPath, ["-e", "process.stdout.write('pty-ok')"], {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH || "" },
    });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); process.exit(21); }, 10000);
    child.onData((chunk) => { output += chunk; });
    child.onExit(() => {
      clearTimeout(timeout);
      if (!output.includes("pty-ok")) process.exit(22);
    });
  `;
  run(process.execPath, ["-e", script], { cwd: extracted, env });
}

function utf8Compare(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function treeManifest(root) {
  const entries = [];
  const visit = async (path) => {
    const names = readdirSync(path).sort(utf8Compare);
    for (const name of names) {
      const absolute = join(path, name);
      const display = relative(root, absolute).split(sep).join("/");
      const metadata = lstatSync(absolute);
      if (metadata.isDirectory()) {
        entries.push({ path: `${display}/` });
        await visit(absolute);
      } else if (metadata.isFile()) {
        entries.push({
          path: display,
          bytes: metadata.size,
          sha256: await sha256File(absolute),
        });
      } else if (metadata.isSymbolicLink()) {
        entries.push({
          path: display,
          link: readlinkSync(absolute).split(sep).join("/"),
        });
      } else {
        throw new Error(`unsupported build entry: ${absolute}`);
      }
    }
  };
  await visit(root);
  return entries;
}

function dependencyInventory(source) {
  const root = join(source, "node_modules");
  const inventory = [];
  const visitNodeModules = (directory, displayDirectory) => {
    for (const name of readdirSync(directory).sort(utf8Compare)) {
      if (name === ".bin" || name === ".package-lock.json") continue;
      const path = join(directory, name);
      if (name.startsWith("@")) {
        for (const scoped of readdirSync(path).sort(utf8Compare)) {
          visitPackage(join(path, scoped), `${displayDirectory}/${name}/${scoped}`);
        }
      } else {
        visitPackage(path, `${displayDirectory}/${name}`);
      }
    }
  };
  const visitPackage = (path, display) => {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      inventory.push({ path: display, link: readlinkSync(path).split(sep).join("/") });
      return;
    }
    const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    inventory.push({ path: display, name: pkg.name, version: pkg.version });
    const nested = join(path, "node_modules");
    if (existsSync(nested)) visitNodeModules(nested, `${display}/node_modules`);
  };
  visitNodeModules(root, "node_modules");
  return inventory;
}

function packageFilename(output) {
  let records;
  try {
    records = JSON.parse(output);
  } catch (error) {
    throw new Error("npm pack did not emit valid JSON", { cause: error });
  }
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error(`npm pack must report exactly one tarball: ${output}`);
  }
  const filename = records[0]?.filename;
  if (
    typeof filename !== "string" ||
    filename !== basename(filename) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(filename)
  ) {
    throw new Error(`npm pack reported an unsafe tarball name: ${JSON.stringify(filename)}`);
  }
  return filename;
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} was not produced: ${path}`);
  }
}

async function assertCanonicalNpmPackageModes(tarball, workspaceRoot) {
  const pkg = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8"));
  const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
  const executable = new Set(
    bins.map((path) => `package/${String(path).replace(/^\.\//, "")}`),
  );
  const invalid = [];
  await listTar({
    file: tarball,
    onReadEntry(entry) {
      const mode = (entry.mode ?? 0) & 0o777;
      const expected = entry.type === "Directory" || executable.has(entry.path) ? 0o755 : 0o644;
      if (entry.type !== "SymbolicLink" && mode !== expected) {
        invalid.push(`${entry.path}:${mode.toString(8)} (expected ${expected.toString(8)})`);
      }
    },
  });
  if (invalid.length > 0) {
    throw new Error(`non-canonical npm package modes in ${tarball}:\n${invalid.join("\n")}`);
  }
}

async function reproduce({ runRoot, source, cache, metadata, offline, timezone, umask }) {
  const previousUmask = process.umask(umask);
  try {
    const env = isolatedEnvironment({
      root: runRoot,
      cache,
      timezone,
      metadata,
      offline,
    });
    console.error(`[clean-build] npm ci (${offline ? "offline warm cache" : "cold cache"})`);
    run("npm", ["ci", "--no-audit", "--no-fund", ...(offline ? ["--offline"] : [])], {
      cwd: source,
      env,
    });
    const dependencyTree = dependencyInventory(source);

    console.error("[clean-build] build SDK + runtime declarations");
    run("npm", ["test", "--workspace=@tetsuo-ai/agenc"], {
      cwd: source,
      env,
    });
    run("npm", ["run", "build", "--workspace=@tetsuo-ai/agenc-sdk"], {
      cwd: source,
      env,
    });
    run("npm", ["run", "build", "--workspace=@tetsuo-ai/runtime"], {
      cwd: source,
      env,
    });
    requireFile(join(source, "runtime", "dist", "index.d.ts"), "runtime declaration");
    requireFile(join(source, "packages", "agenc-sdk", "dist", "index.d.ts"), "SDK declaration");

    const artifacts = join(runRoot, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const releaseEnv = {
      ...env,
      AGENC_ARTIFACT_PROFILE: "clean-local",
      AGENC_RELEASE_OUT_DIR: artifacts,
    };
    run("npm", ["--workspace=@tetsuo-ai/agenc", "run", "build:runtime-tarball"], {
      cwd: source,
      env: releaseEnv,
    });
    const runtimeMetaName = readdirSync(artifacts).find((name) => name.endsWith(".meta.json"));
    if (runtimeMetaName === undefined) {
      throw new Error("runtime artifact sidecar was not produced");
    }
    const runtimeMeta = JSON.parse(readFileSync(join(artifacts, runtimeMetaName), "utf8"));
    const runtimeArtifact = join(artifacts, runtimeMeta.artifact ?? "");
    requireFile(runtimeArtifact, "runtime artifact named by its sidecar");
    smokeExtractedRuntime({ artifact: runtimeArtifact, root: runRoot, env });

    const tag = `agenc-v${JSON.parse(readFileSync(join(source, "runtime", "package.json"), "utf8")).version}`;
    run(
      process.execPath,
      [
        "packages/agenc/scripts/gen-manifest.mjs",
        "--repo",
        "tetsuo-ai/agenc-releases",
        "--tag",
        tag,
        "--artifacts",
        artifacts,
        "--base-url",
        `https://example.invalid/releases/${tag}`,
        "--allow-partial",
      ],
      { cwd: source, env: releaseEnv },
    );

    run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "import { validateLauncherManifest } from './packages/agenc/scripts/check-package-ready.mjs'; validateLauncherManifest({ allowTestPartial: true });",
      ],
      { cwd: source, env: releaseEnv },
    );

    run(process.execPath, ["scripts/canonicalize-package-modes.mjs", "packages/agenc"], {
      cwd: source,
      env: releaseEnv,
    });

    // This gate runs inside exact, .git-free checkout-index snapshots before a
    // release tag exists. The build and package-readiness steps were executed
    // explicitly above, including the narrow clean-local manifest validator.
    // Skip npm lifecycle re-entry here because the launcher's production
    // prepack intentionally accepts only a complete hosted release manifest.
    // Production promotion uses the stricter tagged-source wrapper in
    // scripts/npm-release.mjs; this proof compares the complete resulting bytes
    // from both independent snapshots.
    for (const workspace of ["@tetsuo-ai/runtime", "@tetsuo-ai/agenc-sdk", "@tetsuo-ai/agenc"]) {
      const output = run(
        "npm",
        [
          "pack",
          "--json",
          "--silent",
          "--ignore-scripts=true",
          "--foreground-scripts=false",
          "--pack-destination",
          artifacts,
          `--workspace=${workspace}`,
        ],
        { cwd: source, env: releaseEnv, capture: true },
      );
      const packageTarball = join(artifacts, packageFilename(output));
      requireFile(packageTarball, `${workspace} npm package`);
      const workspaceRoot = workspace === "@tetsuo-ai/runtime"
        ? join(source, "runtime")
        : workspace === "@tetsuo-ai/agenc-sdk"
          ? join(source, "packages", "agenc-sdk")
          : join(source, "packages", "agenc");
      await assertCanonicalNpmPackageModes(packageTarball, workspaceRoot);
    }
    // A one-platform clean-local build can prove the v2 launcher manifest and
    // runtime artifact reproducible. The v1 compatibility bridge is defined
    // only for a complete five-platform release and must not be synthesized from --allow-partial output.
    run("npm", ["run", "sbom", "--", "--output", join(artifacts, "agenc-core.spdx.json")], {
      cwd: source,
      env,
    });

    const runtimeDist = await treeManifest(join(source, "runtime", "dist"));
    const sdkDist = await treeManifest(join(source, "packages", "agenc-sdk", "dist"));
    const artifactFiles = await treeManifest(artifacts);
    return { dependencyTree, runtimeDist, sdkDist, artifactFiles };
  } finally {
    process.umask(previousUmask);
  }
}

function compareReproductions(first, second) {
  for (const field of ["dependencyTree", "runtimeDist", "sdkDist", "artifactFiles"]) {
    const left = JSON.stringify(first[field]);
    const right = JSON.stringify(second[field]);
    if (left !== right) {
      const length = Math.max(first[field].length, second[field].length);
      let mismatch = 0;
      while (
        mismatch < length &&
        JSON.stringify(first[field][mismatch]) === JSON.stringify(second[field][mismatch])
      ) {
        mismatch += 1;
      }
      throw new Error(
        `${field} is not reproducible at entry ${mismatch}: ` +
          `${JSON.stringify(first[field][mismatch])} != ${JSON.stringify(second[field][mismatch])}`,
      );
    }
  }
}

const OCI_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const OCI_CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json";
const OCI_GZIP_LAYER_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar+gzip";

function nativeDockerPlatform() {
  if (process.platform !== "linux") {
    throw new Error(`Docker clean-build gate requires a Linux host; found ${process.platform}`);
  }
  const architecture = process.arch === "x64" ? "amd64" : process.arch;
  if (!new Set(["amd64", "arm64"]).has(architecture)) {
    throw new Error(`Docker clean-build gate does not support host architecture ${process.arch}`);
  }
  return { architecture, platform: `linux/${architecture}` };
}

async function installPinnedBuildx(dockerToolchain, architecture, work) {
  const asset = dockerToolchain?.buildx?.[`linux-${architecture}`];
  if (
    !asset ||
    asset.file !== `buildx-v${dockerToolchain.buildx.version}.linux-${architecture}` ||
    !/^https:\/\/github\.com\/docker\/buildx\/releases\/download\/v[^/]+\/[^/]+$/.test(
      asset.url ?? "",
    ) ||
    !/^[0-9a-f]{64}$/.test(asset.sha256 ?? "")
  ) {
    throw new Error(`no valid pinned Buildx asset for linux-${architecture}`);
  }
  const dockerConfig = join(work, "docker-config");
  const pluginDirectory = join(dockerConfig, "cli-plugins");
  const pluginPath = join(pluginDirectory, "docker-buildx");
  mkdirSync(pluginDirectory, { recursive: true, mode: 0o700 });
  const response = await fetch(asset.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`failed to fetch pinned Buildx: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== asset.sha256) {
    throw new Error(`pinned Buildx digest mismatch: ${actual} != ${asset.sha256}`);
  }
  writeFileSync(pluginPath, bytes, { mode: 0o755 });
  chmodSync(pluginPath, 0o755);
  return {
    env: { ...process.env, DOCKER_CONFIG: dockerConfig },
    pluginPath,
  };
}

async function validateOciLayout(root, { architecture, metadata }) {
  const layout = JSON.parse(readFileSync(join(root, "oci-layout"), "utf8"));
  if (layout?.imageLayoutVersion !== "1.0.0") {
    throw new Error(`invalid OCI layout version at ${root}`);
  }
  const rootIndex = JSON.parse(readFileSync(join(root, "index.json"), "utf8"));
  if (
    rootIndex?.schemaVersion !== 2 ||
    rootIndex?.mediaType !== OCI_INDEX_MEDIA_TYPE ||
    !Array.isArray(rootIndex?.manifests) ||
    rootIndex.manifests.length !== 1
  ) {
    throw new Error(`invalid single-platform OCI root index at ${root}`);
  }

  const reached = new Set();
  const imageManifests = [];
  const visitDescriptor = async (descriptor, inheritedPlatform = undefined) => {
    const match = /^sha256:([0-9a-f]{64})$/.exec(descriptor?.digest ?? "");
    if (!match || !Number.isSafeInteger(descriptor?.size) || descriptor.size < 0) {
      throw new Error(`invalid OCI descriptor in ${root}: ${JSON.stringify(descriptor)}`);
    }
    const digest = match[1];
    const blob = join(root, "blobs", "sha256", digest);
    requireFile(blob, `OCI blob ${descriptor.digest}`);
    if (statSync(blob).size !== descriptor.size) {
      throw new Error(`OCI descriptor size mismatch for ${descriptor.digest}`);
    }
    if ((await sha256File(blob)) !== digest) {
      throw new Error(`OCI descriptor digest mismatch for ${descriptor.digest}`);
    }
    if (reached.has(digest)) return;
    reached.add(digest);

    const platform = descriptor.platform ?? inheritedPlatform;
    if (descriptor.mediaType === OCI_INDEX_MEDIA_TYPE) {
      const index = JSON.parse(readFileSync(blob, "utf8"));
      if (
        index?.schemaVersion !== 2 ||
        index?.mediaType !== OCI_INDEX_MEDIA_TYPE ||
        !Array.isArray(index?.manifests) ||
        index.manifests.length === 0
      ) {
        throw new Error(`invalid OCI image index ${descriptor.digest}`);
      }
      for (const child of index.manifests) await visitDescriptor(child, platform);
      return;
    }
    if (descriptor.mediaType === OCI_MANIFEST_MEDIA_TYPE) {
      const manifest = JSON.parse(readFileSync(blob, "utf8"));
      if (
        manifest?.schemaVersion !== 2 ||
        manifest?.mediaType !== OCI_MANIFEST_MEDIA_TYPE ||
        manifest?.config?.mediaType !== OCI_CONFIG_MEDIA_TYPE ||
        !Array.isArray(manifest?.layers) ||
        manifest.layers.length === 0 ||
        manifest.layers.some((layer) => layer.mediaType !== OCI_GZIP_LAYER_MEDIA_TYPE)
      ) {
        throw new Error(`invalid OCI image manifest ${descriptor.digest}`);
      }
      imageManifests.push({ descriptor, manifest, platform });
      await visitDescriptor(manifest.config, platform);
      for (const layer of manifest.layers) await visitDescriptor(layer, platform);
      return;
    }
    if (
      descriptor.mediaType !== OCI_CONFIG_MEDIA_TYPE &&
      descriptor.mediaType !== OCI_GZIP_LAYER_MEDIA_TYPE
    ) {
      throw new Error(`unexpected OCI media type ${descriptor.mediaType}`);
    }
  };

  for (const descriptor of rootIndex.manifests) await visitDescriptor(descriptor);
  const blobNames = readdirSync(join(root, "blobs", "sha256")).sort(utf8Compare);
  const reachedNames = [...reached].sort(utf8Compare);
  if (JSON.stringify(blobNames) !== JSON.stringify(reachedNames)) {
    throw new Error(`OCI layout contains missing or unreachable blobs at ${root}`);
  }
  if (imageManifests.length !== 1) {
    throw new Error(`expected one OCI image manifest at ${root}; found ${imageManifests.length}`);
  }
  const [{ descriptor, manifest, platform }] = imageManifests;
  if (platform?.os !== "linux" || platform?.architecture !== architecture) {
    throw new Error(
      `OCI platform mismatch: ${platform?.os}/${platform?.architecture} != linux/${architecture}`,
    );
  }
  if (
    !manifest.layers.some(
      (layer) => layer.annotations?.["buildkit/rewritten-timestamp"] ===
        String(metadata.sourceDateEpoch),
    )
  ) {
    throw new Error("OCI image has no layer rewritten to SOURCE_DATE_EPOCH");
  }
  const configPath = join(
    root,
    "blobs",
    "sha256",
    manifest.config.digest.slice("sha256:".length),
  );
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (
    config?.architecture !== architecture ||
    config?.os !== "linux" ||
    config?.config?.User !== "10001:10001" ||
    new Date(config?.created ?? 0).getTime() !== metadata.sourceDateEpoch * 1000
  ) {
    throw new Error(`OCI image config identity mismatch at ${root}`);
  }
  return {
    config,
    configDigest: manifest.config.digest,
    imageManifestDigest: descriptor.digest,
    files: await treeManifest(root),
  };
}

function compareOciLayouts(first, second) {
  const left = JSON.stringify(first.files);
  const right = JSON.stringify(second.files);
  if (left === right) return;
  const length = Math.max(first.files.length, second.files.length);
  let mismatch = 0;
  while (
    mismatch < length &&
    JSON.stringify(first.files[mismatch]) === JSON.stringify(second.files[mismatch])
  ) {
    mismatch += 1;
  }
  throw new Error(
    `Docker OCI layout is not byte-reproducible at entry ${mismatch}: ` +
      `${JSON.stringify(first.files[mismatch])} != ${JSON.stringify(second.files[mismatch])}`,
  );
}

async function dockerSmoke({ sources, metadata, work }) {
  if (!Array.isArray(sources) || sources.length !== 2) {
    throw new Error("Docker reproducibility requires exactly two pristine source trees");
  }
  const suffix = `${metadata.sourceCommit.slice(0, 12)}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const builder = `agenc-clean-build-${suffix}`;
  const tag = `agenc-clean-build:${suffix}`;
  const container = `agenc-clean-build-${suffix}`;
  const layouts = [join(work, "docker-oci-first"), join(work, "docker-oci-second")];
  let builderCreated = false;
  let dockerEnv = process.env;
  try {
    const toolchain = JSON.parse(
      readFileSync(join(sources[0], "release-toolchain.json"), "utf8"),
    );
    const dockerToolchain = toolchain.docker;
    const { architecture, platform } = nativeDockerPlatform();
    const pinnedBuildx = await installPinnedBuildx(
      dockerToolchain,
      architecture,
      work,
    );
    dockerEnv = {
      ...pinnedBuildx.env,
      SOURCE_DATE_EPOCH: String(metadata.sourceDateEpoch),
    };
    run("docker", ["version", "--format", "{{.Server.Version}}"], {
      capture: true,
      env: dockerEnv,
    });
    const buildxVersion = run("docker", ["buildx", "version"], {
      capture: true,
      env: dockerEnv,
    });
    const versionMatch = /\bv(\d+\.\d+\.\d+)\b/.exec(buildxVersion);
    if (versionMatch?.[1] !== dockerToolchain?.buildx?.version) {
      throw new Error(
        `Docker reproducibility requires Buildx ${dockerToolchain?.buildx?.version}; ` +
          `found ${versionMatch?.[1] ?? buildxVersion}`,
      );
    }
    const plugins = JSON.parse(
      run("docker", ["info", "--format", "{{json .ClientInfo.Plugins}}"], {
        capture: true,
        env: dockerEnv,
      }),
    );
    const activeBuildx = plugins.find((plugin) => plugin?.Name === "buildx");
    if (resolve(activeBuildx?.Path ?? "") !== resolve(pinnedBuildx.pluginPath)) {
      throw new Error(
        `Docker CLI did not load the verified Buildx binary: ${activeBuildx?.Path ?? "missing"}`,
      );
    }
    if (
      !/^\d+\.\d+\.\d+$/.test(dockerToolchain?.buildkit?.version ?? "") ||
      !/^moby\/buildkit:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/.test(
        dockerToolchain?.buildkit?.image ?? "",
      ) ||
      !/^[1-9][0-9]*$/.test(dockerToolchain?.buildkit?.compatibilityVersion ?? "")
    ) {
      throw new Error("release-toolchain.json has no valid pinned BuildKit contract");
    }
    run(
      "docker",
      [
        "buildx",
        "create",
        "--name",
        builder,
        "--driver",
        "docker-container",
        "--driver-opt",
        `image=${dockerToolchain.buildkit.image}`,
      ],
      { env: dockerEnv },
    );
    builderCreated = true;
    const builderInspection = run(
      "docker",
      ["buildx", "inspect", "--bootstrap", builder],
      { capture: true, env: dockerEnv },
    );
    const buildkitMatch = /BuildKit version:\s+v(\d+\.\d+\.\d+)\b/.exec(
      builderInspection,
    );
    if (buildkitMatch?.[1] !== dockerToolchain.buildkit.version) {
      throw new Error(
        `Docker reproducibility requires BuildKit ${dockerToolchain.buildkit.version}; ` +
          `found ${buildkitMatch?.[1] ?? "unknown"}`,
      );
    }

    const imageVersion = JSON.parse(
      readFileSync(join(sources[0], "package.json"), "utf8"),
    ).version;
    if (
      sources.some(
        (source) =>
          JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version !==
          imageVersion,
      )
    ) {
      throw new Error("pristine Docker source trees disagree on package version");
    }
    const buildArguments = [
      "--build-arg",
      `AGENC_BUILD_COMMIT=${metadata.sourceCommit}`,
      "--build-arg",
      `SOURCE_DATE_EPOCH=${metadata.sourceDateEpoch}`,
      "--build-arg",
      `AGENC_BUILD_TIME=${metadata.buildTime}`,
      "--build-arg",
      `AGENC_VERSION=${imageVersion}`,
    ];
    const exporterContract =
      `rewrite-timestamp=true,compatibility-version=${dockerToolchain.buildkit.compatibilityVersion},` +
      "compression=gzip,compression-level=6,force-compression=true";
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      run("docker", [
        "buildx",
        "build",
        "--builder",
        builder,
        "--platform",
        platform,
        "--provenance=false",
        "--sbom=false",
        "--no-cache",
        "--output",
        `type=oci,dest=${layouts[index]},tar=false,${exporterContract},` +
          "name=agenc-clean-build:reproducible",
        "--file",
        join(source, "packaging", "docker", "Dockerfile"),
        "--build-arg",
        "BUILDKIT_MULTI_PLATFORM=1",
        ...buildArguments,
        source,
      ], { env: dockerEnv });
    }
    const firstOci = await validateOciLayout(layouts[0], { architecture, metadata });
    const secondOci = await validateOciLayout(layouts[1], { architecture, metadata });
    compareOciLayouts(firstOci, secondOci);
    if (
      firstOci.configDigest !== secondOci.configDigest ||
      firstOci.imageManifestDigest !== secondOci.imageManifestDigest
    ) {
      throw new Error("Docker OCI descriptor digests are not reproducible");
    }

    const source = sources[0];
    run("docker", [
      "buildx",
      "build",
      "--builder",
      builder,
      "--platform",
      platform,
      "--provenance=false",
      "--sbom=false",
      "--output",
      `type=docker,name=${tag},${exporterContract}`,
      "--file",
      join(source, "packaging", "docker", "Dockerfile"),
      ...buildArguments,
      source,
    ], { env: dockerEnv });

    const expectedLabels = {
      "org.opencontainers.image.created": metadata.buildTime,
      "org.opencontainers.image.licenses": "MIT",
      "org.opencontainers.image.revision": metadata.sourceCommit,
      "org.opencontainers.image.source": "https://github.com/tetsuo-ai/agenc-core",
      "org.opencontainers.image.version": imageVersion,
    };
    const inspect = JSON.parse(
      run("docker", ["image", "inspect", tag], { capture: true, env: dockerEnv }),
    )[0];
    if (
      inspect?.Id !== firstOci.configDigest ||
      inspect?.Config?.User !== "10001:10001" ||
      inspect?.Architecture !== architecture
    ) {
      throw new Error(
        `Docker image identity mismatch: user=${inspect?.Config?.User}, architecture=${inspect?.Architecture}`,
      );
    }
    for (const [name, expected] of Object.entries(expectedLabels)) {
      if (inspect?.Config?.Labels?.[name] !== expected) {
        throw new Error(
          `Docker image label ${name} mismatch: ${inspect?.Config?.Labels?.[name]} != ${expected}`,
        );
      }
    }
    if (
      JSON.stringify(inspect?.Config?.Healthcheck?.Test) !==
      JSON.stringify(["CMD", "agenc", "daemon", "status"])
    ) {
      throw new Error("Docker image has no daemon healthcheck");
    }
    run("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--tmpfs",
      "/data:rw,nosuid,nodev,noexec,mode=700,uid=10001,gid=10001",
      tag,
      "--version",
    ], { env: dockerEnv });
    run("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--tmpfs",
      "/data:rw,nosuid,nodev,noexec,mode=700,uid=10001,gid=10001",
      "--entrypoint",
      "node",
      "--env",
      `AGENC_EXPECTED_ABI=${toolchain.nodeModuleAbi}`,
      "--env",
      `AGENC_EXPECTED_PACKAGES=${JSON.stringify(toolchain.docker.runtimePackages)}`,
      tag,
      "-e",
      checkedJavaScriptProgram(
       `const { readFileSync, statSync } = require("node:fs");
       const { createRequire } = require("node:module");
       if (process.getuid?.() !== 10001 || process.getgid?.() !== 10001) throw new Error("container is not the dedicated non-root identity");
       const runtimeRoot = statSync("/opt/agenc");
       if (runtimeRoot.uid !== 0 || runtimeRoot.gid !== 0 || (runtimeRoot.mode & 0o022) !== 0) throw new Error("runtime tree is not root-owned and immutable");
       const peerAddon = statSync("/usr/lib/agenc/agenc-peer-credentials.node");
       if (peerAddon.uid !== 0 || peerAddon.gid !== 0 || (peerAddon.mode & 0o777) !== 0o555) throw new Error("peer credential addon is not root-owned and immutable");
       if (readFileSync("/usr/lib/agenc/peer-credentials-required", "utf8") !== "required\\n") throw new Error("peer credential system requirement marker is missing");
       if (typeof require("/usr/lib/agenc/agenc-peer-credentials.node")?.getPeerUid !== "function") throw new Error("peer credential native smoke failed");
       for (const compiler of ["/usr/bin/cc", "/usr/bin/c++", "/usr/bin/gcc", "/usr/bin/g++", "/usr/bin/clang", "/usr/bin/make", "/usr/local/bin/cc"]) {
         try { statSync(compiler); throw new Error("runtime compiler unexpectedly present: " + compiler); } catch (error) { if (error?.code !== "ENOENT") throw error; }
       }
       const inventory = new Set(readFileSync("/usr/share/agenc/debian-packages.txt", "utf8").trim().split("\\n"));
       for (const forbidden of ["gcc", "g++", "make", "libc6-dev", "linux-libc-dev"]) {
         if ([...inventory].some((entry) => entry.startsWith(forbidden + "=") || entry.startsWith(forbidden + ":"))) throw new Error("runtime build package unexpectedly present: " + forbidden);
       }
       if (process.versions.modules !== process.env.AGENC_EXPECTED_ABI) throw new Error("container Node ABI mismatch");
       for (const [name, version] of Object.entries(JSON.parse(process.env.AGENC_EXPECTED_PACKAGES))) {
         const debArch = process.arch === "x64" ? "amd64" : process.arch;
         if (![name + "=" + version, name + ":" + debArch + "=" + version].some((entry) => inventory.has(entry))) {
           throw new Error("missing pinned Debian package: " + name + "=" + version);
         }
       }
       const runtimeRequire = createRequire("/opt/agenc/node_modules/@tetsuo-ai/runtime/package.json");
       const Database = runtimeRequire("better-sqlite3");
       const db = new Database(":memory:");
       if (db.prepare("select 42 as value").get().value !== 42) throw new Error("SQLite native smoke failed");
       db.close();
       const pty = runtimeRequire("node-pty");
       const child = pty.spawn(process.execPath, ["-e", "process.stdout.write('pty-ok')"], {
         cols: 80, rows: 24, cwd: "/data", env: { PATH: process.env.PATH || "" },
       });
       let output = "";
       const timeout = setTimeout(() => { child.kill(); process.exit(21); }, 10000);
       child.onData((chunk) => { output += chunk; });
       child.onExit(() => {
         clearTimeout(timeout);
         if (!output.includes("pty-ok")) process.exit(22);
       });`,
       "hardened container runtime smoke",
      ),
    ], { env: dockerEnv });

    run("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--entrypoint",
      "node",
      tag,
      "-e",
      `const { accessSync, appendFileSync, constants, lstatSync, readdirSync } = require("node:fs");
       const { join } = require("node:path");
       const writable = [];
       const visit = (path) => {
         const stat = lstatSync(path);
         if (stat.isSymbolicLink()) return;
         try { accessSync(path, constants.W_OK); writable.push(path); } catch {}
         if (stat.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry));
       };
       visit("/opt/agenc");
       if (writable.length) throw new Error("runtime descendants writable by daemon UID: " + writable.slice(0, 10).join(", "));
       try {
         appendFileSync("/opt/agenc/node_modules/@tetsuo-ai/runtime/dist/VERSION", "tamper");
         throw new Error("runtime mutation unexpectedly succeeded");
       } catch (error) {
         if (!["EACCES", "EPERM", "EROFS"].includes(error?.code)) throw error;
       }`,
    ], { env: dockerEnv });

    run("docker", [
      "run",
      "--detach",
      "--name",
      container,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--env",
      "AGENC_NATIVE_PEER_CREDENTIAL_ADDON=/data/evil.node",
      "--env",
      "AGENC_AUTH_BACKEND=local",
      "--tmpfs",
      "/data:rw,nosuid,nodev,noexec,mode=700,uid=10001,gid=10001",
      tag,
    ], { env: dockerEnv });
    const daemonProbe = `
      const { lstatSync } = require("node:fs");
      const { createConnection } = require("node:net");
      const socket = "/data/.agenc/daemon.sock";
      if (!lstatSync(socket).isSocket()) process.exit(30);
      const socketStat = lstatSync(socket);
      if ((socketStat.mode & 0o777) !== 0o600 || socketStat.uid !== 10001 || socketStat.gid !== 10001) process.exit(31);
      const addon = "/usr/lib/agenc/agenc-peer-credentials.node";
      const addonStat = lstatSync(addon);
      if ((addonStat.mode & 0o777) !== 0o555 || addonStat.uid !== 0 || addonStat.gid !== 0) process.exit(32);
      if (typeof require(addon)?.getPeerUid !== "function") process.exit(33);
      const client = createConnection(socket);
      let buffer = "";
      const timer = setTimeout(() => { client.destroy(); process.exit(34); }, 5000);
      client.setEncoding("utf8");
      client.on("connect", () => {
        client.write(JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: {
            protocolVersion: "1.0.0",
            protocol: { version: "1.0.0" },
            clientName: "agenc-container-peer-proof",
            authCookie: "intentionally-wrong-cookie",
            capabilities: {},
          },
        }) + "\\n" + JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "auth.whoami", params: {},
        }) + "\\n");
      });
      client.on("data", (chunk) => {
        buffer += chunk;
        const parts = buffer.split("\\n");
        buffer = parts.pop() ?? "";
        const lines = parts.filter(Boolean).map((line) => JSON.parse(line));
        const whoami = lines.find((message) => message.id === 2);
        if (!whoami) return;
        clearTimeout(timer);
        const daemon = whoami.result?.identity?.daemon;
        if (daemon?.verifiedBy !== "peerUid" || daemon.peerUid !== process.getuid?.()) process.exit(35);
        client.end();
      });
      client.on("error", () => process.exit(36));
    `;
    let daemonReady = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const probe = spawnSync("docker", ["exec", container, "node", "-e", daemonProbe], {
        encoding: "utf8",
        env: dockerEnv,
        shell: IS_WINDOWS,
        stdio: "pipe",
      });
      if (probe.status === 0) {
        daemonReady = true;
        break;
      }
      const running = spawnSync(
        "docker",
        ["container", "inspect", "--format", "{{.State.Running}}", container],
        {
          encoding: "utf8",
          env: dockerEnv,
          shell: IS_WINDOWS,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      if (running.status !== 0 || running.stdout.trim() !== "true") break;
      await delay(100);
    }
    if (daemonReady) {
      run("docker", ["exec", container, "agenc", "daemon", "status"], {
        env: dockerEnv,
      });
      run("docker", ["stop", "--time", "10", container], { env: dockerEnv });
    }
    const stoppedState = daemonReady
      ? JSON.parse(
          run(
            "docker",
            ["container", "inspect", "--format", "{{json .State}}", container],
            { capture: true, env: dockerEnv },
          ),
        )
      : null;
    const logResult = spawnSync("docker", ["logs", container], {
      encoding: "utf8",
      env: dockerEnv,
      shell: IS_WINDOWS,
      stdio: "pipe",
    });
    const daemonLogs = `${logResult.stdout ?? ""}${logResult.stderr ?? ""}`;
    if (
      !daemonReady ||
      logResult.status !== 0 ||
      daemonLogs.includes("peer credential native binding unavailable") ||
      stoppedState?.Running !== false ||
      stoppedState?.ExitCode !== 0
    ) {
      throw new Error(
        `hardened Docker daemon/native-binding smoke failed:\n${daemonLogs.trim()}`,
      );
    }
  } finally {
    const cleanup = [
      ["container", "rm", "--force", container],
      ["image", "rm", tag],
      ...(builderCreated ? [["buildx", "rm", "--force", builder]] : []),
    ];
    for (const args of cleanup) {
      const result = spawnSync("docker", args, {
        encoding: "utf8",
        env: dockerEnv,
        shell: IS_WINDOWS,
        stdio: "pipe",
      });
      if (result.status !== 0) {
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        if (!/(No such (container|image)|not found|failed to find)/i.test(output)) {
          console.error(`[clean-build] Docker cleanup failed: docker ${args.join(" ")}\n${output}`);
        }
      }
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (!["--help", "-h", "--plan", "--skip-docker", "--keep-temp"].includes(arg)) {
      throw new Error(`unknown argument: ${arg}\n${usage()}`);
    }
  }
  if (args.has("--help") || args.has("-h")) {
    process.stdout.write(usage());
    return;
  }
  if (args.has("--plan")) {
    process.stdout.write(`${JSON.stringify(PLAN, null, 2)}\n`);
    return;
  }

  ensureCleanCommittedSource();
  const expectedNpm = pinnedNpmVersion(repoRoot);
  const toolchain = validateToolchain(expectedNpm);
  const metadata = sourceMetadata();
  const work = mkdtempSync(join(tmpdir(), "agenc-clean-build-"));
  const keepTemp = args.has("--keep-temp");
  try {
    const cache = join(work, "npm-cache");
    const firstRoot = join(work, "first");
    const secondRoot = join(work, "second");
    const firstSource = join(firstRoot, "source");
    const secondSource = join(secondRoot, "source");
    checkoutIndex(firstSource, 0o022);
    checkoutIndex(secondSource, 0o077);

    console.error(
      `[clean-build] ${metadata.sourceCommit} with ${toolchain.nodeVersion} / npm ${toolchain.npmVersion}`,
    );
    const first = await reproduce({
      runRoot: firstRoot,
      source: firstSource,
      cache,
      metadata,
      offline: false,
      timezone: "UTC",
      umask: 0o022,
    });
    const second = await reproduce({
      runRoot: secondRoot,
      source: secondSource,
      cache,
      metadata,
      offline: true,
      timezone: "Pacific/Honolulu",
      umask: 0o077,
    });
    compareReproductions(first, second);

    if (!args.has("--skip-docker")) {
      const dockerSources = [
        join(work, "docker-source-first"),
        join(work, "docker-source-second"),
      ];
      checkoutIndex(dockerSources[0], 0o022);
      checkoutIndex(dockerSources[1], 0o077);
      await dockerSmoke({ sources: dockerSources, metadata, work });
    }
    process.stdout.write(
      `clean build reproducible (${first.dependencyTree.length} installed packages, ` +
        `${first.artifactFiles.filter((entry) => !entry.path.endsWith("/")).length} artifacts)\n`,
    );
  } finally {
    if (keepTemp) {
      console.error(`[clean-build] retained ${work}`);
    } else {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

await main().catch((error) => {
  console.error(`[clean-build] FAILED: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
