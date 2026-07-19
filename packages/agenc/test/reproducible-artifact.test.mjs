import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import test from "node:test";
import { list as listTar } from "tar";

import {
  assertNoLocalPathLeaks,
  assertHostedRunnerContract,
  assertRootLockSnapshot,
  canonicalizeRpmContentInventory,
  installedNativeModuleSmokeProgram,
  maximumGlibcVersion,
  maximumMacosDeploymentVersion,
  maximumRequiredSymbolVersion,
  pruneNativeBuildIntermediates,
  resolveBuildExecutables,
  withPinnedExecutablePath,
  withWindowsReproducibleNativeFlags,
  windowsReproducibleNativeFlagProvenance,
  writeCanonicalArchive,
} from "../scripts/build-runtime-tarball.mjs";
import { prepareWindowsCommonGypiBytes } from "../scripts/prepare-windows-node-headers.mjs";
import { validateRuntimeArchive } from "../lib/runtime-archive.mjs";

function fixture(root, reverse) {
  const modules = join(root, "node_modules");
  mkdirSync(modules, { recursive: true });
  const entries = reverse ? ["z-package", "a-package"] : ["a-package", "z-package"];
  for (const name of entries) {
    const packageRoot = join(modules, name);
    mkdirSync(packageRoot);
    writeFileSync(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ name, version: "1.0.0" })}\n`,
    );
    writeFileSync(join(packageRoot, "index.js"), `export default ${JSON.stringify(name)};\n`);
  }
  mkdirSync(join(modules, ".bin"));
  symlinkSync("../a-package/index.js", join(modules, ".bin", "a-package"));
  chmodSync(join(modules, "a-package", "index.js"), reverse ? 0o700 : 0o755);
  chmodSync(join(modules, "z-package", "index.js"), reverse ? 0o600 : 0o644);
  const time = new Date(reverse ? "2037-01-01T00:00:00Z" : "2001-01-01T00:00:00Z");
  for (const name of entries) {
    utimesSync(join(modules, name, "index.js"), time, time);
  }
}

test("canonical runtime archives ignore creation order, mtimes, and umask modes", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-canonical-tar-test-"));
  try {
    const first = join(work, "first");
    const second = join(work, "second");
    fixture(first, false);
    fixture(second, true);
    const firstArchive = join(work, "first.tar.gz");
    const secondArchive = join(work, "second.tar.gz");
    await writeCanonicalArchive({ installRoot: first, artifactPath: firstArchive, epoch: 1_700_000_000 });
    await writeCanonicalArchive({ installRoot: second, artifactPath: secondArchive, epoch: 1_700_000_000 });
    assert.ok(readFileSync(firstArchive).length > 29, "archive must contain a real gzip payload");
    assert.deepEqual(readFileSync(firstArchive), readFileSync(secondArchive));
    const gzip = readFileSync(firstArchive);
    assert.deepEqual([...gzip.subarray(4, 8)], [0, 0, 0, 0], "gzip mtime must be zero");
    const paths = [];
    await listTar({ file: firstArchive, onReadEntry: (entry) => paths.push(entry.path) });
    assert.ok(paths.includes("node_modules/a-package/package.json"));
    assert.ok(paths.includes("node_modules/z-package/index.js"));
    assert.ok(validateRuntimeArchive(firstArchive).entries > 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("canonical long-path PAX archives pass the install-side validator", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-canonical-pax-test-"));
  try {
    const root = join(work, "root");
    const longPath = join(
      root,
      "node_modules",
      "long-package",
      "nested-".repeat(22),
    );
    mkdirSync(longPath, { recursive: true });
    writeFileSync(join(longPath, "index.js"), "export default true;\n");
    symlinkSync("./index.js", join(longPath, "current.js"));
    const archive = join(work, "runtime.tar.gz");
    await writeCanonicalArchive({ installRoot: root, artifactPath: archive, epoch: 0 });
    const validated = validateRuntimeArchive(archive);
    assert.ok(validated.entries >= 5);
    const paxBytes = gunzipSync(readFileSync(archive));
    const pathKey = paxBytes.indexOf(Buffer.from(" path="));
    assert.ok(pathKey >= 0, "long canonical archive must contain a PAX path record");
    paxBytes.write(" xath=", pathKey, 6, "ascii");
    const unknownPax = join(work, "runtime-unknown-pax.tar.gz");
    writeFileSync(unknownPax, gzipSync(paxBytes));
    assert.throws(
      () => validateRuntimeArchive(unknownPax),
      /unsupported PAX key: xath/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("reproducibility mismatch identifies the exact archive member", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-repro-diff-test-"));
  try {
    const first = join(work, "first");
    const second = join(work, "second");
    const output = join(work, "output");
    const artifact = "agenc-runtime-1.0.0-win-x64-node25-abi141.tar.gz";
    for (const [root, installName, payload] of [
      [first, "install-first", "first-native"],
      [second, "install-second", "other-native"],
    ]) {
      mkdirSync(root, { recursive: true });
      const installRoot = join(work, installName);
      const nativeRoot = join(
        installRoot,
        "node_modules",
        "native",
        "build",
        "Release",
      );
      mkdirSync(nativeRoot, { recursive: true });
      writeFileSync(join(nativeRoot, "addon.node"), payload);
      const artifactPath = join(root, artifact);
      await writeCanonicalArchive({ installRoot, artifactPath, epoch: 1_700_000_000 });
      const bytes = readFileSync(artifactPath);
      writeFileSync(
        `${artifactPath}.meta.json`,
        `${JSON.stringify({
          artifact,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
          artifactProfile: "release",
          nativeToolchain: { schemaVersion: 1, builder: "fixture" },
        }, null, 2)}\n`,
      );
    }
    const verifier = join(
      import.meta.dirname,
      "..",
      "scripts",
      "verify-reproducible-artifacts.mjs",
    );
    const result = spawnSync(process.execPath, [
      verifier, "--first", first, "--second", second, "--output", output,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archiveEntryDifferences=/);
    assert.match(result.stderr, /node_modules\/native\/build\/Release\/addon\.node/);
    assert.match(result.stderr, /contentSha256/);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("local-path scan ignores generic roots but rejects a unique build path", () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-local-path-test-"));
  try {
    writeFileSync(
      join(work, "legitimate.d.ts"),
      "export type AssumeRootCommand = '/root' | '/src' | '/Users/runner' | " +
        "'/home/builder' | 'C:\\\\src' | 'C:\\\\Users\\\\runneradmin';\n",
    );
    assert.doesNotThrow(() =>
      assertNoLocalPathLeaks(work, [
        "/root",
        "/src",
        "/Users/runner",
        "/home/builder",
        "C:\\src",
        "C:\\Users\\runneradmin",
      ]),
    );

    for (const sentinel of [
      "/tmp/agenc-build-sentinel/worktree",
      "/Users/runner/work/agenc-core",
      "/home/builder/work/agenc-core",
      "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\agenc-build",
    ]) {
      writeFileSync(join(work, "leaked.txt"), `source=${sentinel}/runtime\n`);
      assert.throws(
        () => assertNoLocalPathLeaks(work, [sentinel]),
        /embeds a developer-local path/,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("release build executables stay pinned across lifecycle and PATH drift", () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-build-executables-test-"));
  try {
    const npmCli = join(work, "npm-cli.js");
    const detachedNode = join(work, "node");
    writeFileSync(npmCli, "export {};\n");
    writeFileSync(detachedNode, "detached\n");
    const resolved = resolveBuildExecutables({
      artifactProfile: "release",
      environment: {
        AGENC_NODE_EXECUTABLE_PATH: process.execPath,
        AGENC_NPM_CLI_PATH: npmCli,
        npm_execpath: detachedNode,
      },
      currentNodeExecutable: process.execPath,
    });
    assert.equal(resolved.nodeExecutablePath, realpathSync(process.execPath));
    assert.equal(resolved.npmCliPath, realpathSync(npmCli));

    assert.throws(
      () => resolveBuildExecutables({
        artifactProfile: "release",
        environment: { npm_execpath: npmCli },
        currentNodeExecutable: process.execPath,
      }),
      /require verified AGENC_NODE_EXECUTABLE_PATH and AGENC_NPM_CLI_PATH/,
    );
    assert.throws(
      () => resolveBuildExecutables({
        artifactProfile: "release",
        environment: {
          AGENC_NODE_EXECUTABLE_PATH: process.execPath,
          AGENC_NPM_CLI_PATH: "relative/npm-cli.js",
        },
        currentNodeExecutable: process.execPath,
      }),
      /npm CLI must name an absolute regular file/,
    );
    assert.throws(
      () => resolveBuildExecutables({
        artifactProfile: "release",
        environment: {
          AGENC_NODE_EXECUTABLE_PATH: detachedNode,
          AGENC_NPM_CLI_PATH: npmCli,
        },
        currentNodeExecutable: process.execPath,
      }),
      /not running under the verified Node executable/,
    );

    const normalized = withPinnedExecutablePath(
      { PATH: "/runner/bin:/usr/bin", Path: "/stale/bin:/usr/bin", KEEP: "yes" },
      process.execPath,
      "linux",
    );
    assert.equal(normalized.Path, undefined);
    assert.equal(normalized.KEEP, "yes");
    assert.equal(normalized.PATH.split(":")[0], dirname(process.execPath));
    assert.equal(normalized.PATH.split(":").filter((entry) => entry === "/usr/bin").length, 1);

    const windowsNormalized = withPinnedExecutablePath(
      { Path: "C:\\Runner\\bin;C:\\Windows", PATH: "c:\\runner\\BIN;C:\\Tools" },
      "D:\\Pinned Node\\node.exe",
      "win32",
    );
    assert.equal(windowsNormalized.Path, undefined);
    assert.deepEqual(windowsNormalized.PATH.split(";"), [
      "D:\\Pinned Node",
      "C:\\Runner\\bin",
      "C:\\Windows",
      "C:\\Tools",
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("Windows release flags trim random native roots and override project debug links", () => {
  const nativeBuildRoot = "D:\\a\\_temp\\agenc-runtime-build-random";
  const environment = withWindowsReproducibleNativeFlags({
    Cl: "/DKEEP_COMPILER",
    LINK: "/KEEP_PREPENDED",
    _link_: "/KEEP_APPENDED",
    UNRELATED: "yes",
  }, nativeBuildRoot);
  assert.equal(environment.Cl, undefined);
  assert.equal(environment._link_, undefined);
  assert.equal(environment.UNRELATED, "yes");
  assert.equal(
    environment.CL,
    `/DKEEP_COMPILER /Brepro /d1trimfile:${nativeBuildRoot}\\`,
  );
  assert.equal(
    environment.LINK,
    "/KEEP_PREPENDED /Brepro /PDBALTPATH:%_PDB%",
  );
  assert.equal(
    environment._LINK_,
    "/KEEP_APPENDED /DEBUG:NONE /INCREMENTAL:NO /Brepro",
  );
  const provenance = windowsReproducibleNativeFlagProvenance(environment, nativeBuildRoot);
  assert.equal(
    provenance.CL,
    "/DKEEP_COMPILER /Brepro /d1trimfile:<release-stage>\\",
  );
  assert.throws(
    () => withWindowsReproducibleNativeFlags({}, "relative-build-root"),
    /must be absolute/,
  );
});

test("Windows release headers disable pinned /Z7 exactly once and remain idempotent", () => {
  const pinnedLine =
    "        'DebugInformationFormat': 1,          # /Z7 embed info in .obj files\n";
  const releaseLine =
    "        'DebugInformationFormat': 0,          # disabled for reproducible release objects\n";
  const source = Buffer.from(`before\n${pinnedLine}after\n`);
  const expected = Buffer.from(`before\n${releaseLine}after\n`);
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const contract = {
    sourceSha256: digest(source),
    releaseSha256: digest(expected),
  };

  const prepared = prepareWindowsCommonGypiBytes(source, contract);
  assert.equal(prepared.changed, true);
  assert.deepEqual(prepared.bytes, expected);
  assert.equal(prepared.sourceSha256, contract.sourceSha256);
  assert.equal(prepared.releaseSha256, contract.releaseSha256);

  const repeated = prepareWindowsCommonGypiBytes(prepared.bytes, contract);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.bytes, expected);
  assert.equal(repeated.releaseSha256, contract.releaseSha256);

  const duplicate = Buffer.from(`${pinnedLine}${pinnedLine}`);
  assert.throws(
    () => prepareWindowsCommonGypiBytes(duplicate, {
      sourceSha256: digest(duplicate),
      releaseSha256: contract.releaseSha256,
    }),
    /exactly one pinned \/Z7 setting/,
  );
  assert.throws(
    () => prepareWindowsCommonGypiBytes(Buffer.from("detached\n"), contract),
    /source digest mismatch/,
  );
  assert.throws(
    () => prepareWindowsCommonGypiBytes(source, {
      ...contract,
      releaseSha256: "0".repeat(64),
    }),
    /sanitized Node common\.gypi digest mismatch/,
  );
});

test("runtime packaging rejects root manifest dependencies absent from the lock snapshot", () => {
  const manifest = {
    name: "agenc-core",
    version: "1.2.3",
    license: "MIT",
    private: true,
    workspaces: ["runtime"],
    devDependencies: { typescript: "1.0.0" },
  };
  const lock = {
    packages: {
      "": {
        name: "agenc-core",
        version: "1.2.3",
        license: "MIT",
        workspaces: ["runtime"],
        devDependencies: { typescript: "1.0.0" },
      },
    },
  };
  assert.doesNotThrow(() => assertRootLockSnapshot(manifest, lock));
  assert.throws(
    () => assertRootLockSnapshot(
      { ...manifest, dependencies: { vitest: "4.1.10" } },
      lock,
    ),
    /dependencies snapshot does not match/,
  );
});

test("signed RPM content inventory binds header, payload, algorithm, and signer identity", () => {
  const signed = (name, header, payload, signer = "15af5dac6d745a60") =>
    `${name}|0|1.0|1.el8|x86_64|${header.repeat(64)}|${payload.repeat(64)}|8|` +
    `RSA/SHA256, Tue Jul 14 00:00:00 2026, Key ID ${signer}`;
  const inventory = [
    signed("zlib", "a", "b"),
    "gpg-pubkey|0|6d745a60|60287f36|(none)|(none)|(none)|(none)|(none)",
    signed("bash", "c", "d"),
  ].join("\n");
  const identity = canonicalizeRpmContentInventory(inventory, ["15af5dac6d745a60"]);
  assert.deepEqual(identity.signingKeyIds, ["15af5dac6d745a60"]);
  assert.match(identity.sha256, /^[0-9a-f]{64}$/);
  assert.equal(identity.canonical.split("\n")[0].startsWith("bash|"), true);
  assert.equal(identity.canonical.includes("gpg-pubkey"), false);
  assert.throws(
    () => canonicalizeRpmContentInventory(
      inventory.replace(`|${"b".repeat(64)}|8|`, `|${"b".repeat(63)}|8|`),
      ["15af5dac6d745a60"],
    ),
    /content identity is incomplete/,
  );
  assert.throws(
    () => canonicalizeRpmContentInventory(inventory, ["0".repeat(16)]),
    /signature identity is not approved/,
  );
});

test("hosted release runner contracts reject valid-looking drift", () => {
  const darwinContract = {
    runnerLabel: "macos-15",
    imageOS: "macos15",
    imageVersion: "20260706.0213.1",
    runnerArch: "ARM64",
    xcodeVersion: "16.4",
    xcodeBuild: "16F6",
    macosSdkVersion: "15.5",
    clangVersion: "Apple clang version 17.0.0 (clang-1700.0.13.5)",
  };
  const metadata = {
    builder: "github-hosted:macos-15:macos15:20260706.0213.1:ARM64",
    runnerLabel: "macos-15",
    runnerImage: "macos15",
    runnerImageVersion: "20260706.0213.1",
    runnerArch: "ARM64",
    xcode: "Xcode 16.4\nBuild version 16F6",
    sdk: "15.5",
    cc: darwinContract.clangVersion,
    cxx: darwinContract.clangVersion,
  };
  assert.doesNotThrow(() =>
    assertHostedRunnerContract(metadata, darwinContract, "darwin-arm64"),
  );
  for (const [field, value, expected] of [
    ["runnerImageVersion", "20260714.1", /runnerImageVersion/],
    ["xcode", "Xcode 16.3\nBuild version 16E140", /Xcode/],
    ["cc", "Apple clang version 16.0.0", /C compiler/],
    ["builder", "github-hosted:detached", /builder identity/],
  ]) {
    assert.throws(
      () => assertHostedRunnerContract(
        { ...metadata, [field]: value },
        darwinContract,
        "darwin-arm64",
      ),
      expected,
      field,
    );
  }
});

test("two-build verifier rejects a byte-identical but detached provenance sidecar", () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-release-verify-test-"));
  try {
    const first = join(work, "first");
    const second = join(work, "second");
    const output = join(work, "output");
    mkdirSync(first);
    mkdirSync(second);
    const artifact = "agenc-runtime-1.0.0-linux-x64-node25-abi141.tar.gz";
    const bytes = Buffer.from("runtime artifact fixture");
    const metadata = {
      artifact,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      artifactProfile: "release",
      nativeToolchain: { schemaVersion: 1, builder: "fixture" },
    };
    for (const root of [first, second]) {
      writeFileSync(join(root, artifact), bytes);
      writeFileSync(
        join(root, `${artifact}.meta.json`),
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
    }
    const verifier = join(
      import.meta.dirname,
      "..",
      "scripts",
      "verify-reproducible-artifacts.mjs",
    );
    assert.doesNotThrow(() =>
      execFileSync(process.execPath, [
        verifier, "--first", first, "--second", second, "--output", output,
      ]),
    );
    assert.deepEqual(readFileSync(join(output, artifact)), bytes);
    rmSync(output, { recursive: true, force: true });
    metadata.artifact = "detached.tar.gz";
    for (const root of [first, second]) {
      writeFileSync(
        join(root, `${artifact}.meta.json`),
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
    }
    assert.throws(
      () => execFileSync(process.execPath, [
        verifier, "--first", first, "--second", second, "--output", output,
      ], { stdio: "pipe" }),
      /Command failed/,
    );

    assert.throws(
      () => execFileSync(process.execPath, [
        verifier, "--first", first, "--second", first, "--output", output,
      ], { stdio: "pipe" }),
      /Command failed/,
    );
    mkdirSync(output);
    writeFileSync(join(output, "sentinel"), "preserve");
    assert.throws(
      () => execFileSync(process.execPath, [
        verifier, "--first", first, "--second", second, "--output", output,
      ], { stdio: "pipe" }),
      /Command failed/,
    );
    assert.equal(readFileSync(join(output, "sentinel"), "utf8"), "preserve");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

function nativeFixture(root, platform) {
  const modules = join(root, "node_modules");
  const sqliteBuild = join(modules, "better-sqlite3", "build");
  const ptyBuild = join(modules, "node-pty", "build");
  mkdirSync(join(sqliteBuild, "Release", "obj.target"), { recursive: true });
  writeFileSync(join(sqliteBuild, "Release", "better_sqlite3.node"), "sqlite");
  writeFileSync(join(sqliteBuild, "config.gypi"), `/developer/home\n`);
  writeFileSync(join(sqliteBuild, "Release", "obj.target", "sqlite.o"), "object");
  mkdirSync(join(ptyBuild, "Release"), { recursive: true });
  writeFileSync(join(ptyBuild, "Release", "pty.node"), "pty");
  const generatedNodeAddonApi = join(
    modules,
    "node-pty",
    "node-addon-api",
    "Release",
    "obj",
    "node_addon_api_except",
    "node_add.tlog",
  );
  mkdirSync(generatedNodeAddonApi, { recursive: true });
  writeFileSync(
    join(generatedNodeAddonApi, "node_addon_api_except.lastbuildstate"),
    "C:\\Users\\builder\\AppData\\Local\\Temp\\agenc-runtime-build-random",
  );
  if (platform === "win32") {
    for (const name of [
      "conpty.node",
      "conpty_console_list.node",
      "winpty-agent.exe",
      "winpty.dll",
    ]) {
      writeFileSync(join(ptyBuild, "Release", name), name);
    }
  } else if (platform === "darwin") {
    writeFileSync(join(ptyBuild, "Release", "spawn-helper"), "helper");
  }
  writeFileSync(join(ptyBuild, "Makefile"), "/developer/home/source");
  mkdirSync(join(modules, "node-pty", "prebuilds", "other-platform"), {
    recursive: true,
  });
  writeFileSync(
    join(modules, "node-pty", "prebuilds", "other-platform", "pty.node"),
    "untrusted-prebuild",
  );
  return { modules, sqliteBuild, ptyBuild };
}

test("native packaging applies explicit Linux, Darwin, and Windows output contracts", () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-native-prune-test-"));
  try {
    for (const platform of ["linux", "darwin", "win32"]) {
      const fixtureRoot = join(work, platform);
      const { modules, sqliteBuild, ptyBuild } = nativeFixture(fixtureRoot, platform);
      pruneNativeBuildIntermediates(modules, platform);
      assert.ok(existsSync(join(sqliteBuild, "Release", "better_sqlite3.node")));
      assert.ok(existsSync(join(ptyBuild, "Release", "pty.node")));
      assert.equal(
        existsSync(join(ptyBuild, "Release", "spawn-helper")),
        platform === "darwin",
      );
      assert.equal(
        existsSync(join(ptyBuild, "Release", "conpty.node")),
        platform === "win32",
      );
      assert.equal(existsSync(join(sqliteBuild, "config.gypi")), false);
      assert.equal(existsSync(join(sqliteBuild, "Release", "obj.target")), false);
      assert.equal(existsSync(join(ptyBuild, "Makefile")), false);
      assert.equal(existsSync(join(modules, "node-pty", "node-addon-api")), false);
      assert.equal(existsSync(join(modules, "node-pty", "prebuilds")), false);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("native smoke inherits required process state and drains output after exit", () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-native-smoke-test-"));
  try {
    const requiredWindowsNames = [
      "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE",
      "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR",
    ];
    const windowsParentEnvironment = {
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\runner",
      LOGONSERVER: "\\\\runner",
      PATH: "C:\\tools",
      SYSTEMDRIVE: "C:",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      USERDOMAIN: "RUNNER",
      USERNAME: "runner",
      USERPROFILE: "C:\\Users\\runner",
      WINDIR: "C:\\Windows",
      AGENC_PTY_SMOKE_SECRET: "must-not-forward",
    };
    const sqliteRoot = join(work, "node_modules", "better-sqlite3");
    const ptyRoot = join(work, "node_modules", "node-pty");
    mkdirSync(sqliteRoot, { recursive: true });
    mkdirSync(ptyRoot, { recursive: true });
    writeFileSync(
      join(sqliteRoot, "index.js"),
      `module.exports = class Database {
        prepare() { return { get() { return { value: 42 }; } }; }
        close() {}
      };\n`,
    );
    writeFileSync(
      join(ptyRoot, "index.js"),
      `module.exports.spawn = (_file, _args, options) => {
        const expectedNames = ${JSON.stringify(requiredWindowsNames)};
        const parentEnvironment = new Map(
          Object.entries(process.env).map(([name, value]) => [name.toUpperCase(), value]),
        );
        const requiredStatePresent =
          JSON.stringify(Object.keys(options.env)) === JSON.stringify(expectedNames) &&
          expectedNames.every((name) => options.env[name] === parentEnvironment.get(name)) &&
          options.env.AGENC_PTY_SMOKE_SECRET === undefined;
        let onData;
        let onExit;
        const child = {
          kill() {},
          onData(listener) { onData = listener; },
          onExit(listener) { onExit = listener; },
        };
        queueMicrotask(() => {
          onExit({
            exitCode: process.env.AGENC_PTY_SMOKE_EXIT_CODE === "9"
              ? 9
              : requiredStatePresent ? 0 : 8,
            signal: process.env.AGENC_PTY_SMOKE_SIGNAL === "9" ? 9 : undefined,
          });
          queueMicrotask(() => onData("pty-ok"));
        });
        // Model a native ConPTY/libuv handle that can remain referenced after
        // both success events. The standalone smoke must still terminate.
        setInterval(() => {}, 60_000);
        return child;
      };\n`,
    );
    assert.doesNotThrow(() => execFileSync(
      process.execPath,
      ["-e", installedNativeModuleSmokeProgram("win32")],
      {
        cwd: work,
        env: windowsParentEnvironment,
        stdio: "pipe",
        timeout: 5_000,
      },
    ));
    assert.throws(
      () => execFileSync(
        process.execPath,
        ["-e", installedNativeModuleSmokeProgram("win32")],
        {
          cwd: work,
          env: {
            ...windowsParentEnvironment,
            AGENC_PTY_SMOKE_EXIT_CODE: "9",
          },
          stdio: "pipe",
          timeout: 5_000,
        },
      ),
      (error) => {
        assert.equal(error.status, 22);
        assert.match(error.stderr.toString(), /"exitCode":9/);
        return true;
      },
    );
    assert.throws(
      () => execFileSync(
        process.execPath,
        ["-e", installedNativeModuleSmokeProgram("win32")],
        {
          cwd: work,
          env: {
            ...windowsParentEnvironment,
            AGENC_PTY_SMOKE_SIGNAL: "9",
          },
          stdio: "pipe",
          timeout: 5_000,
        },
      ),
      (error) => {
        assert.equal(error.status, 22);
        assert.match(error.stderr.toString(), /"signal":9/);
        return true;
      },
    );
    if (process.platform !== "win32") {
      const { SystemRoot: _systemRoot, ...missingSystemRoot } = windowsParentEnvironment;
      assert.throws(
        () => execFileSync(
          process.execPath,
          ["-e", installedNativeModuleSmokeProgram("win32")],
          { cwd: work, env: missingSystemRoot, stdio: "pipe", timeout: 5_000 },
        ),
        (error) => {
          assert.equal(error.status, 24);
          assert.match(error.stderr.toString(), /requires SystemRoot on Windows/);
          return true;
        },
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("GLIBC floor selection compares versions numerically", () => {
  assert.equal(
    maximumGlibcVersion([
      "Version needs section\nName: GLIBC_2.17 Flags: none",
      "Version definition section\nGLIBC_9.9\nVersion needs section\nGLIBC_2.9 GLIBC_2.28 GLIBCXX_3.4.30",
    ]),
    "2.28",
  );
  assert.equal(maximumGlibcVersion(["no GNU libc symbols"]), undefined);
  assert.equal(
    maximumRequiredSymbolVersion(
      ["Version needs section\nGLIBCXX_3.4.9 GLIBCXX_3.4.25 CXXABI_1.3.11"],
      "GLIBCXX",
    ),
    "3.4.25",
  );
});

test("macOS deployment floor parser covers modern and legacy Mach-O load commands", () => {
  assert.equal(
    maximumMacosDeploymentVersion([
      `Load command 9\n      cmd LC_BUILD_VERSION\n    minos 13.5\n      sdk 15.0\n`,
      `Load command 10\n      cmd LC_VERSION_MIN_MACOSX\n  cmdsize 16\n  version 12.3\n      sdk 13.1\n`,
      `Load command 11\n      cmd LC_BUILD_VERSION\n    minos 14.2.1\n`,
    ]),
    "14.2.1",
  );
  assert.equal(maximumMacosDeploymentVersion(["no deployment command"]), undefined);
});
