// Tests for `agenc update` (runtime/src/bin/update-cli.ts).
//
// The updater must speak the exact install contract shared by
// scripts/install/install.sh and the npm launcher's runtime-manager:
// runtime/<version>/<platform>-<arch>-<libc>-node-abi-<abi>-sha256-<digest>/
// tree plus a .agenc-runtime-ok marker recording that digest, and it must only ever
// rewrite wrappers carrying the install.sh generation signature. Everything
// runs against a synthetic tarball and a file:// manifest, mirroring
// install-sh.test.ts.

import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  findInstallShWrappers,
  findGeneratedWrapperCandidates,
  findGeneratedWrappers,
  activateInstallShWrappers,
  activateGeneratedWrappers,
  createPrivateUpdateWorkDirectory,
  fetchRuntimeManifest,
  formatAgenCUpdateCliHelpText,
  parseAgenCUpdateCliArgs,
  parseInstallShWrapper,
  parseGeneratedWrapper,
  renderGeneratedWrapper,
  renderInstallShWrapper,
  resolveUpdateManifestRequest,
  resolveUpdateManifestUrl,
  resolveTrustedSystemTar,
  runBoundedProcess,
  runAgenCUpdateCli,
  runPreparedOfficialAttestationVerifier,
  sanitizeTerminalText,
  selectUpdateArtifact,
  installRuntimeFromManifest,
  officialRuntimeAttestationVerificationArgs,
  validateAndParseGeneratedWrapper,
  verifyOfficialRuntimeArtifactProvenance,
  type RuntimeManifest,
  type RuntimeManifestArtifact,
} from "../../src/bin/update-cli.js";
import {
  resolveActivationLockRegistry,
  wrapperActivationLockPath,
} from "../../src/utils/activation-lock-identity.js";
import {
  MAX_RUNTIME_ARTIFACT_BYTES,
  OFFICIAL_RELEASE_WORKFLOW,
  MAX_RUNTIME_MANIFEST_BYTES,
  OFFICIAL_RELEASE_REPOSITORY,
  OFFICIAL_SOURCE_REPOSITORY,
  PINNED_GITHUB_CLI_ARTIFACTS,
} from "../../src/utils/runtime-release-contract.js";

const NEW_VERSION = "9.9.9-test";
const OLD_VERSION = "9.9.8-test";
const BIN_REL = "node_modules/@tetsuo-ai/runtime/bin/agenc";
const NODE_ABI = process.versions.modules;
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
const LINUX_COMPATIBILITY = {
  libcFamily: "glibc",
  minimumGlibcVersion: "2.28",
  minimumGlibcxxVersion: "3.4.25",
  minimumCxxAbiVersion: "1.3.11",
} as const;
const LINUX_ARTIFACT_KEY = `linux-x64-glibc-node-abi-${NODE_ABI}`;

function linuxInstallKey(artifactSha: string): string {
  return `${LINUX_ARTIFACT_KEY}-sha256-${artifactSha}`;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function removePersistentWrapperLocks(root: string): void {
  const registry = resolveActivationLockRegistry();
  if (!existsSync(registry) || !existsSync(root)) return;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(path);
      } else if (entry.isFile() && (entry.name === "agenc" || entry.name === "agenc.cmd")) {
        if (parseGeneratedWrapper(path) === null) continue;
        const lockPath = wrapperActivationLockPath(path, registry);
        for (const suffix of ["", "-shm", "-wal"]) {
          rmSync(`${lockPath}${suffix}`, { force: true });
        }
      }
    }
  }
}

function makeSyntheticArtifact(dir: string): { tarball: string; sha: string } {
  const tree = join(dir, "tree");
  const binDir = join(tree, "node_modules", "@tetsuo-ai", "runtime", "bin");
  mkdirSync(binDir, { recursive: true });
  chmodSync(binDir, 0o700);
  writeFileSync(
    join(binDir, "agenc"),
    'console.log("ok " + process.argv.slice(2).join(" "));\n',
  );
  const tarball = join(dir, `agenc-runtime-${NEW_VERSION}-test.tar.gz`);
  const res = spawnSync("tar", ["-czf", tarball, "-C", tree, "node_modules"]);
  expect(res.status).toBe(0);
  return { tarball, sha: sha256(readFileSync(tarball)) };
}

function writeManifest(
  dir: string,
  artifact: { tarball: string; sha: string },
  overrides: Record<string, unknown> = {},
): string {
  const manifest = {
    manifestVersion: 2,
    runtimeVersion: NEW_VERSION,
    releaseRepository: "tetsuo-ai/agenc-releases",
    releaseTag: `agenc-v${NEW_VERSION}`,
    artifacts: [
      {
        platform: "linux",
        arch: "x64",
        runtimeVersion: NEW_VERSION,
        nodeMajor: NODE_MAJOR,
        nodeModuleAbi: NODE_ABI,
        nodeApiVersion: process.versions.napi,
        ...LINUX_COMPATIBILITY,
        url: `file://${artifact.tarball}`,
        sha256: artifact.sha,
        bytes: statSync(artifact.tarball).size,
        bins: { agenc: BIN_REL },
      },
    ],
    ...overrides,
  };
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  chmodSync(path, 0o600);
  return path;
}

function makeRemoteManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const runtimeVersion = "9.9.9";
  const releaseRepository = OFFICIAL_RELEASE_REPOSITORY;
  const releaseTag = `agenc-v${runtimeVersion}`;
  const artifactName =
    `agenc-runtime-${runtimeVersion}-linux-x64-node${NODE_MAJOR}-abi${NODE_ABI}.tar.gz`;
  return {
    manifestVersion: 2,
    runtimeVersion,
    releaseRepository,
    releaseTag,
    build: {
      sourceRef: `refs/tags/${releaseTag}`,
      sourceCommit: "c".repeat(40),
      sourceDateEpoch: 1_700_000_000,
      lockfileSha256: "d".repeat(64),
      nodeVersion: process.version,
      nodeMajor: NODE_MAJOR,
      nodeModuleAbi: NODE_ABI,
      nodeApiVersion: process.versions.napi,
      npmVersion: "11.0.0",
      artifactProfile: "release",
    },
    artifacts: [
      {
        platform: "linux",
        arch: "x64",
        runtimeVersion,
        nodeMajor: NODE_MAJOR,
        nodeModuleAbi: NODE_ABI,
        nodeApiVersion: process.versions.napi,
        ...LINUX_COMPATIBILITY,
        url:
          `https://github.com/${releaseRepository}/releases/download/` +
          `${releaseTag}/${artifactName}`,
        sha256: "e".repeat(64),
        bytes: 1,
        attestationUrl:
          `https://github.com/${releaseRepository}/releases/download/` +
          `${releaseTag}/${artifactName}.sigstore.json`,
        attestationSha256: "f".repeat(64),
        attestationBytes: 1,
        bins: { agenc: BIN_REL },
      },
    ],
    ...overrides,
  };
}

function responseFromChunks(
  chunks: readonly Uint8Array[],
  headers: Readonly<Record<string, string>> = {},
  onCancel: () => void = () => undefined,
): Response {
  const body = {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      for (const chunk of chunks) yield chunk;
    },
    async cancel(): Promise<void> {
      onCancel();
    },
  };
  return {
    body,
    headers: new Headers(headers),
    ok: true,
    redirected: false,
    status: 200,
    statusText: "OK",
    url: "",
  } as unknown as Response;
}

function fetchResponse(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

function makeRemoteArtifact(
  bytes: number,
  sha256Value = "f".repeat(64),
): RuntimeManifestArtifact {
  return {
    platform: "linux",
    arch: "x64",
    runtimeVersion: "9.9.9",
    nodeMajor: NODE_MAJOR,
    nodeModuleAbi: NODE_ABI,
    nodeApiVersion: process.versions.napi,
    ...LINUX_COMPATIBILITY,
    url:
      `https://github.com/${OFFICIAL_RELEASE_REPOSITORY}/releases/download/` +
      `agenc-v9.9.9/agenc-runtime-9.9.9-linux-x64-node${NODE_MAJOR}-abi${NODE_ABI}.tar.gz`,
    sha256: sha256Value,
    bytes,
    bins: { agenc: BIN_REL },
  };
}

function makeOfficialArtifact(
  content: Buffer,
  bundle: Buffer,
): RuntimeManifestArtifact {
  const artifact = makeRemoteArtifact(content.length, sha256(content));
  return {
    ...artifact,
    attestationUrl: `${artifact.url}.sigstore.json`,
    attestationSha256: sha256(bundle),
    attestationBytes: bundle.length,
  };
}

function manifestForArtifact(artifact: RuntimeManifestArtifact): RuntimeManifest {
  const releaseTag = `agenc-v${artifact.runtimeVersion}`;
  return {
    manifestVersion: 2,
    runtimeVersion: artifact.runtimeVersion,
    releaseRepository: OFFICIAL_RELEASE_REPOSITORY,
    releaseTag,
    build: {
      sourceRef: `refs/tags/${releaseTag}`,
      sourceCommit: "a".repeat(40),
      sourceDateEpoch: 1_700_000_000,
      lockfileSha256: "b".repeat(64),
      nodeVersion: process.version,
      nodeMajor: NODE_MAJOR,
      nodeModuleAbi: NODE_ABI,
      nodeApiVersion: process.versions.napi,
      npmVersion: "11.0.0",
      artifactProfile: "release",
    },
    artifacts: [artifact],
  };
}

// A wrapper exactly as install.sh generates it, pointing at the OLD runtime.
function writeInstallShWrapper(
  binDir: string,
  agencHome: string,
  runtimeBin: string,
): string {
  mkdirSync(binDir, { recursive: true });
  chmodSync(binDir, 0o700);
  const wrapper = join(binDir, "agenc");
  writeFileSync(
    wrapper,
    renderInstallShWrapper({
      nodeBin: process.execPath,
      runtimeBin,
      agencHome,
    }),
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function writeInstallPs1Wrapper(
  binDir: string,
  agencHome: string,
  runtimeBin: string,
  values: { readonly nodeBin?: string } = {},
): string {
  mkdirSync(binDir, { recursive: true });
  chmodSync(binDir, 0o700);
  const wrapper = join(binDir, "agenc.cmd");
  writeFileSync(
    wrapper,
    renderGeneratedWrapper({
      kind: "cmd",
      nodeBin: values.nodeBin ?? process.execPath,
      runtimeBin,
      agencHome,
    }),
  );
  chmodSync(wrapper, 0o644);
  return wrapper;
}

describe("agenc update CLI", () => {
  let work: string;
  let agencHome: string;
  let binDir: string;
  let out: string[];
  let err: string[];
  let deps: Parameters<typeof runAgenCUpdateCli>[1];

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "agenc-update-test-"));
    agencHome = join(work, "home");
    binDir = join(work, "bin");
    mkdirSync(agencHome, { recursive: true });
    mkdirSync(binDir, { recursive: true, mode: 0o700 });
    chmodSync(binDir, 0o700);
    out = [];
    err = [];
    deps = {
      env: { AGENC_HOME: agencHome, PATH: binDir, HOME: work },
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      currentVersion: OLD_VERSION,
      platform: "linux",
      arch: "x64",
      nodeModuleAbi: NODE_ABI,
      runtimeCompatibility: {
        platform: "linux",
        arch: "x64",
        nodeMajor: NODE_MAJOR,
        nodeModuleAbi: NODE_ABI,
        libcFamily: "glibc",
        glibcVersion: "2.39",
        glibcxxVersion: "3.4.33",
        cxxAbiVersion: "1.3.15",
      },
      userHome: work,
    };
  });

  afterEach(() => {
    removePersistentWrapperLocks(work);
    rmSync(work, { recursive: true, force: true });
  });

  test("private updater work never retains a retargetable temporary-parent alias", async () => {
    if (process.platform === "win32") return;
    const canonicalParent = join(work, "canonical-temp");
    const attackerParent = join(work, "attacker-temp");
    const alias = join(work, "temp-alias");
    mkdirSync(canonicalParent, { mode: 0o700 });
    mkdirSync(attackerParent, { mode: 0o700 });
    symlinkSync(canonicalParent, alias, "dir");

    const created = await createPrivateUpdateWorkDirectory({
      parent: alias,
      prefix: "identity-test-",
      label: "temporary identity test",
      timeoutMs: 5_000,
    });
    expect(dirname(created)).toBe(canonicalParent);
    rmSync(alias);
    symlinkSync(attackerParent, alias, "dir");
    writeFileSync(join(created, "trusted"), "ok");
    expect(existsSync(join(canonicalParent, basename(created), "trusted"))).toBe(true);
    expect(existsSync(join(attackerParent, basename(created), "trusted"))).toBe(false);
  });

  test("parses flags and rejects unknown options", () => {
    expect(parseAgenCUpdateCliArgs(["not-update"])).toBeNull();
    expect(parseAgenCUpdateCliArgs(["update"])).toEqual({
      kind: "update",
      check: false,
      json: false,
    });
    expect(parseAgenCUpdateCliArgs(["update", "--check", "--json"])).toEqual({
      kind: "update",
      check: true,
      json: true,
    });
    expect(
      parseAgenCUpdateCliArgs(["update", "--pin", "1.2.3"]),
    ).toMatchObject({ kind: "update", pinVersion: "1.2.3" });
    expect(parseAgenCUpdateCliArgs(["update", "--pin", "nope"])).toMatchObject({
      kind: "error",
    });
    expect(parseAgenCUpdateCliArgs(["update", "--bogus"])).toMatchObject({
      kind: "error",
    });
    expect(parseAgenCUpdateCliArgs(["update", "--help"])).toEqual({
      kind: "help",
      text: formatAgenCUpdateCliHelpText(),
    });
  });

  test("renders untrusted update failures as one inert bounded terminal line", async () => {
    const payload = "\u001b]52;c;QUJD\u0007\nforged-line\u202e";
    const encoded = Buffer.from(JSON.stringify({
      ...makeRemoteManifest(),
      manifestVersion: payload,
    }));
    const captured: string[] = [];
    const code = await runAgenCUpdateCli({
      kind: "update",
      check: true,
      json: false,
      manifestUrl: "https://example.invalid/manifest.json",
    }, {
      ...deps,
      stderr: (line) => captured.push(line),
      fetchImpl: fetchResponse(responseFromChunks([encoded])),
    });
    expect(code).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/u);
    expect(captured[0]).toContain("forged-line");
    expect(sanitizeTerminalText("a\n\u001b[31mb", 4)).toBe("a [3");
  });

  test("renders and parses the exact install.ps1 CMD wrapper contract", () => {
    const values = {
      nodeBin: join(work, "Node % ! &", "node.exe"),
      runtimeBin: join(agencHome, "runtime", OLD_VERSION, "bin % ! &", "agenc.js"),
      agencHome: join(work, "home % ! &"),
    };
    mkdirSync(values.agencHome, { recursive: true });
    const metadata = Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
    const expected = [
      "@echo off",
      "setlocal DisableDelayedExpansion",
      "rem Generated by AgenC install.ps1 - rewritten on every install/upgrade.",
      `rem AgenC wrapper metadata v1: ${metadata}`,
      `if not defined AGENC_HOME set "AGENC_HOME=${values.agencHome.replaceAll("%", "%%")}"`,
      `"${values.nodeBin.replaceAll("%", "%%")}" "${values.runtimeBin.replaceAll("%", "%%")}" %*`,
      "",
    ].join("\r\n");
    const path = join(binDir, "agenc.cmd");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path, renderGeneratedWrapper({ kind: "cmd", ...values }));

    expect(readFileSync(path, "utf8")).toBe(expected);
    expect(parseGeneratedWrapper(path)).toEqual({
      kind: "cmd",
      path,
      ...values,
    });
    expect(parseInstallShWrapper(path)).toBeNull();
  });

  test("renders the canonical POSIX wrapper with safe near-OOM diagnostics", () => {
    const values = {
      nodeBin: join(work, "Node ' runtime", "node"),
      runtimeBin: join(agencHome, "runtime", OLD_VERSION, "bin ' runtime", "agenc.js"),
      agencHome: join(work, "home ' runtime"),
    };
    mkdirSync(values.agencHome, { recursive: true });
    const path = join(binDir, "agenc");
    mkdirSync(binDir, { recursive: true });
    const content = renderGeneratedWrapper({ kind: "posix", ...values });
    writeFileSync(path, content, { mode: 0o755 });

    expect(content).toContain('case " ${NODE_OPTIONS:-} " in');
    expect(content).toContain("*heapsnapshot-near-heap-limit*)");
    expect(content).toContain(
      '--diagnostic-dir="${AGENC_HOME}/oom-snapshots"',
    );
    expect(content).not.toContain('NODE_OPTIONS="--heapsnapshot-near-heap-limit');
    expect(parseGeneratedWrapper(path)).toEqual({
      kind: "posix",
      path,
      ...values,
    });
  });

  test("rejects unsafe or non-canonical modern wrapper bytes", () => {
    const values = {
      nodeBin: process.execPath,
      runtimeBin: join(agencHome, "runtime", OLD_VERSION, BIN_REL),
      agencHome,
    };
    for (const bad of ['bad"path', "bad\rpath", "bad\npath", "bad\0path"]) {
      expect(() => renderGeneratedWrapper({ kind: "cmd", ...values, nodeBin: bad }))
        .toThrow(/unsupported character|NUL/);
    }

    mkdirSync(binDir, { recursive: true });
    const path = join(binDir, "agenc.cmd");
    const canonical = renderGeneratedWrapper({ kind: "cmd", ...values });
    const extraMetadata = Buffer.from(JSON.stringify({ ...values, extra: true }), "utf8")
      .toString("base64url");
    for (const content of [
      `echo unrelated\r\n${canonical}`,
      canonical.replace("AgenC wrapper metadata v1:", "AgenC wrapper metadata v1: "),
      canonical.replace(/AgenC wrapper metadata v1: [A-Za-z0-9_-]+/u,
        `AgenC wrapper metadata v1: ${extraMetadata}`),
      canonical.replaceAll("\r\n", "\n"),
      '@echo off\r\necho "Generated by AgenC install.ps1"\r\necho custom\r\n',
    ]) {
      writeFileSync(path, content);
      expect(parseGeneratedWrapper(path)).toBeNull();
    }
    writeFileSync(path, Buffer.alloc(64 * 1024 + 1, 0x61));
    expect(parseGeneratedWrapper(path)).toBeNull();
  });

  test("accepts only the exact published and mainline legacy wrapper shapes", () => {
    mkdirSync(binDir, { recursive: true });
    const runtimeBin = join(agencHome, "runtime", OLD_VERSION, BIN_REL);
    const posixPath = join(binDir, "agenc");
    const posix = [
      "#!/bin/sh",
      "# Generated by AgenC install.sh — rewritten on every install/upgrade.",
      `export AGENC_HOME="\${AGENC_HOME:-${agencHome}}"`,
      `exec "${process.execPath}" "${runtimeBin}" "$@"`,
      "",
    ].join("\n");
    writeFileSync(posixPath, posix);
    expect(parseGeneratedWrapper(posixPath)).toMatchObject({
      kind: "posix", nodeBin: process.execPath, runtimeBin, agencHome,
    });

    const mainlineOomPosix = [
      "#!/bin/sh",
      "# Generated by AgenC install.sh — rewritten on every install/upgrade.",
      `export AGENC_HOME="\${AGENC_HOME:-${agencHome}}"`,
      "# OOM self-diagnosis: have V8 write a heap snapshot from inside the GC when",
      "# the heap nears its limit (reliable even in the end-stage GC stall where JS",
      "# timers starve), into $AGENC_HOME/oom-snapshots. The runtime prunes old",
      "# captures and points at fresh ones on the next startup. User-provided",
      "# NODE_OPTIONS win: ours are prepended, and we skip entirely when the user",
      "# already tunes heap snapshots.",
      'case " ${NODE_OPTIONS:-} " in',
      "  *heapsnapshot-near-heap-limit*) : ;;",
      "  *)",
      '    mkdir -p "${AGENC_HOME}/oom-snapshots" 2>/dev/null || :',
      '    NODE_OPTIONS="--heapsnapshot-near-heap-limit=1 --diagnostic-dir=${AGENC_HOME}/oom-snapshots ${NODE_OPTIONS:-}"',
      "    export NODE_OPTIONS",
      "    ;;",
      "esac",
      `exec "${process.execPath}" "${runtimeBin}" "$@"`,
      "",
    ].join("\n");
    writeFileSync(posixPath, mainlineOomPosix);
    expect(parseGeneratedWrapper(posixPath)).toMatchObject({
      kind: "posix", nodeBin: process.execPath, runtimeBin, agencHome,
    });
    writeFileSync(
      posixPath,
      mainlineOomPosix.replace("    export NODE_OPTIONS", "    export NODE_OPTIONS\n    echo injected"),
    );
    expect(parseGeneratedWrapper(posixPath)).toBeNull();

    const cmdPath = join(binDir, "agenc.cmd");
    const cmd = [
      "@echo off",
      "rem Generated by AgenC install.ps1 - rewritten on every install/upgrade.",
      `if not defined AGENC_HOME set "AGENC_HOME=${agencHome}"`,
      `"${process.execPath}" "${runtimeBin}" %*`,
      "",
    ].join("\r\n");
    writeFileSync(cmdPath, cmd);
    expect(parseGeneratedWrapper(cmdPath)).toMatchObject({
      kind: "cmd", nodeBin: process.execPath, runtimeBin, agencHome,
    });

    for (const content of [
      `echo before\n${posix}`,
      posix.replace("exec ", "echo custom\nexec "),
      posix.replace("install.sh", "install.sh "),
      cmd.replace("@echo off", "@echo off\r\necho custom"),
      cmd.replace(" %*", " %* extra"),
      cmd.replace("install.ps1", "install.ps1 "),
    ]) {
      const path = content.includes("@echo off") ? cmdPath : posixPath;
      writeFileSync(path, content);
      expect(parseGeneratedWrapper(path)).toBeNull();
    }
  });

  test("simulated Windows discovery selects only exact .cmd wrappers and preserves case-distinct dirs", () => {
    const lower = join(work, "case", "bin");
    const upper = join(work, "case", "BIN");
    const runtimeBin = join(agencHome, "runtime", OLD_VERSION, BIN_REL);
    const lowerWrapper = writeInstallPs1Wrapper(lower, agencHome, runtimeBin);
    const upperWrapper = writeInstallPs1Wrapper(upper, agencHome, runtimeBin);
    writeFileSync(join(lower, "agenc"), "npm shim\n");
    writeFileSync(join(lower, "agenc.bat"), "@echo npm shim\r\n");

    expect(findGeneratedWrappers({
      platform: "win32",
      env: { Path: `${lower};${lower};${upper}` },
      userHome: work,
    }).map((wrapper) => wrapper.path)).toEqual([lowerWrapper, upperWrapper]);
    expect(findGeneratedWrapperCandidates({
      platform: "win32",
      env: { Path: `${lower};${lower};${upper}` },
      userHome: work,
    })).toEqual([lowerWrapper, upperWrapper]);
  });

  test.skipIf(process.platform === "win32")(
    "validates wrapper ancestors before opening attacker-controlled special files",
    async () => {
      const unsafeAncestor = join(work, "unsafe-fifo-prefix");
      const unsafeBin = join(unsafeAncestor, "bin");
      mkdirSync(unsafeBin, { recursive: true, mode: 0o700 });
      chmodSync(unsafeBin, 0o700);
      chmodSync(unsafeAncestor, 0o777);
      const unsafeFifo = join(unsafeBin, "agenc");
      expect(spawnSync("mkfifo", [unsafeFifo]).status).toBe(0);
      const started = performance.now();
      try {
        await expect(validateAndParseGeneratedWrapper(unsafeFifo, {
          timeoutMs: 1_000,
        })).rejects.toThrow(/directory chain permits untrusted mutation/);
        expect(performance.now() - started).toBeLessThan(1_000);
      } finally {
        chmodSync(unsafeAncestor, 0o700);
      }

      const safeFifo = join(binDir, "agenc");
      expect(spawnSync("mkfifo", [safeFifo]).status).toBe(0);
      const safeStarted = performance.now();
      await expect(validateAndParseGeneratedWrapper(safeFifo, {
        timeoutMs: 1_000,
      })).rejects.toThrow(/regular single-link file/);
      expect(performance.now() - safeStarted).toBeLessThan(1_000);
    },
  );

  test.skipIf(process.platform === "win32")(
    "migrates a wrapper's AGENC_HOME alias to the canonical home",
    async () => {
      const artifact = makeSyntheticArtifact(work);
      const manifestPath = writeManifest(work, artifact);
      const aliasHome = join(work, "legacy-wrapper-home-alias");
      symlinkSync(agencHome, aliasHome, "dir");
      const oldBin = join(agencHome, "runtime", OLD_VERSION, LINUX_ARTIFACT_KEY, BIN_REL);
      const wrapper = writeInstallShWrapper(binDir, aliasHome, oldBin);

      const code = await runAgenCUpdateCli({
        kind: "update",
        check: false,
        json: false,
        manifestUrl: `file://${manifestPath}`,
      }, deps);

      expect(code).toBe(0);
      expect(parseInstallShWrapper(wrapper)?.agencHome).toBe(agencHome);
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects a canonical wrapper whose file permissions allow untrusted mutation",
    async () => {
      const wrapperPath = writeInstallShWrapper(
        binDir,
        agencHome,
        join(agencHome, "runtime", OLD_VERSION, LINUX_ARTIFACT_KEY, BIN_REL),
      );
      const before = readFileSync(wrapperPath, "utf8");
      chmodSync(wrapperPath, 0o777);
      try {
        await expect(validateAndParseGeneratedWrapper(wrapperPath))
          .rejects.toThrow(/protected file is group\/world-writable/);
        await expect(activateGeneratedWrappers({
          wrappers: [parseGeneratedWrapper(wrapperPath)!],
          runtimeBin: join(agencHome, "runtime", NEW_VERSION, LINUX_ARTIFACT_KEY, BIN_REL),
          targetVersion: NEW_VERSION,
          agencHome,
          allowDowngrade: false,
        })).rejects.toThrow(/protected file is group\/world-writable/);
        expect(readFileSync(wrapperPath, "utf8")).toBe(before);
      } finally {
        chmodSync(wrapperPath, 0o700);
      }
    },
  );

  test("activates mixed POSIX and CMD wrappers with their native bytes and modes", async () => {
    const oldBin = join(agencHome, "runtime", OLD_VERSION, LINUX_ARTIFACT_KEY, BIN_REL);
    const targetBin = join(agencHome, "runtime", NEW_VERSION, LINUX_ARTIFACT_KEY, BIN_REL);
    const posixPath = writeInstallShWrapper(join(work, "posix-bin"), agencHome, oldBin);
    const cmdPath = writeInstallPs1Wrapper(join(work, "cmd-bin"), agencHome, oldBin);
    const wrappers = [parseGeneratedWrapper(posixPath)!, parseGeneratedWrapper(cmdPath)!];

    await activateGeneratedWrappers({
      wrappers,
      runtimeBin: targetBin,
      targetVersion: NEW_VERSION,
      agencHome,
      allowDowngrade: false,
    });

    expect(parseGeneratedWrapper(posixPath)).toMatchObject({ kind: "posix", runtimeBin: targetBin });
    expect(parseGeneratedWrapper(cmdPath)).toMatchObject({ kind: "cmd", runtimeBin: targetBin });
    expect(statSync(posixPath).mode & 0o777).toBe(0o755);
    expect(statSync(cmdPath).mode & 0o777).toBe(0o644);
  });

  test("activation rejects an untrusted wrapper ancestor before rewriting the wrapper", async () => {
    const unsafeAncestor = join(work, "unsafe-prefix");
    const wrapperPath = writeInstallShWrapper(
      join(unsafeAncestor, "bin"),
      agencHome,
      join(agencHome, "runtime", OLD_VERSION, LINUX_ARTIFACT_KEY, BIN_REL),
    );
    chmodSync(unsafeAncestor, 0o777);
    const before = readFileSync(wrapperPath, "utf8");
    try {
      await expect(activateGeneratedWrappers({
        wrappers: [parseGeneratedWrapper(wrapperPath)!],
        runtimeBin: join(agencHome, "runtime", NEW_VERSION, LINUX_ARTIFACT_KEY, BIN_REL),
        targetVersion: NEW_VERSION,
        agencHome,
        allowDowngrade: false,
      })).rejects.toThrow(/directory chain permits untrusted mutation/);
      expect(readFileSync(wrapperPath, "utf8")).toBe(before);
    } finally {
      chmodSync(unsafeAncestor, 0o700);
    }
  });

  test.skipIf(process.platform === "win32")(
    "rejects a wrapper reached through a non-canonical parent alias",
    async () => {
      const canonicalDir = join(work, "canonical-bin");
      const wrapperPath = writeInstallShWrapper(
        canonicalDir,
        agencHome,
        join(agencHome, "runtime", OLD_VERSION, LINUX_ARTIFACT_KEY, BIN_REL),
      );
      const aliasDir = join(work, "bin-alias");
      symlinkSync(canonicalDir, aliasDir, "dir");
      const aliasPath = join(aliasDir, "agenc");
      const before = readFileSync(wrapperPath, "utf8");
      await expect(activateGeneratedWrappers({
        wrappers: [parseGeneratedWrapper(aliasPath)!],
        runtimeBin: join(agencHome, "runtime", NEW_VERSION, LINUX_ARTIFACT_KEY, BIN_REL),
        targetVersion: NEW_VERSION,
        agencHome,
        allowDowngrade: false,
      })).rejects.toThrow(/parent must use its canonical path/);
      expect(readFileSync(wrapperPath, "utf8")).toBe(before);
    },
  );

  test("runs a complete Windows update through an explicit .cmd wrapper on a Linux test host", async () => {
    const artifact = makeSyntheticArtifact(work);
    const winArtifact = {
      platform: "win",
      arch: "x64",
      runtimeVersion: NEW_VERSION,
      nodeMajor: NODE_MAJOR,
      nodeModuleAbi: NODE_ABI,
      nodeApiVersion: process.versions.napi,
      url: `file://${artifact.tarball}`,
      sha256: artifact.sha,
      bytes: statSync(artifact.tarball).size,
      bins: { agenc: BIN_REL },
    };
    const manifestPath = writeManifest(work, artifact, { artifacts: [winArtifact] });
    const oldBin = join(
      agencHome,
      "runtime",
      OLD_VERSION,
      `win-x64-native-node-abi-${NODE_ABI}`,
      BIN_REL,
    );
    const wrapper = writeInstallPs1Wrapper(binDir, agencHome, oldBin);

    const code = await runAgenCUpdateCli({
      kind: "update",
      check: false,
      json: false,
      manifestUrl: `file://${manifestPath}`,
      wrapper,
    }, {
      ...deps,
      platform: "win32",
      runtimeCompatibility: {
        platform: "win32",
        arch: "x64",
        nodeMajor: NODE_MAJOR,
        nodeModuleAbi: NODE_ABI,
      },
    });

    expect(code).toBe(0);
    expect(parseGeneratedWrapper(wrapper)).toMatchObject({
      kind: "cmd",
      runtimeBin: join(
        agencHome,
        "runtime",
        NEW_VERSION,
        `win-x64-native-node-abi-${NODE_ABI}-sha256-${artifact.sha}`,
        BIN_REL,
      ),
    });
    expect(statSync(wrapper).mode & 0o777).toBe(0o644);
  });

  test("resolves manifest URL: flag > env > pinned > latest", () => {
    expect(
      resolveUpdateManifestUrl({ manifestUrl: "file:///x.json", env: {} }),
    ).toBe("file:///x.json");
    expect(
      resolveUpdateManifestUrl({
        env: { AGENC_INSTALL_MANIFEST_URL: "file:///env.json" },
      }),
    ).toBe("file:///env.json");
    expect(resolveUpdateManifestUrl({ pinVersion: "1.2.3", env: {} })).toBe(
      "https://github.com/tetsuo-ai/agenc-releases/releases/download/agenc-v1.2.3/agenc-runtime-manifest-v2.json",
    );
    expect(resolveUpdateManifestUrl({ env: {} })).toBe(
      "https://github.com/tetsuo-ai/agenc-releases/releases/latest/download/agenc-runtime-manifest-v2.json",
    );
    expect(
      resolveUpdateManifestUrl({ env: { AGENC_INSTALL_REPO: "o/r" } }),
    ).toBe(
      "https://github.com/o/r/releases/latest/download/agenc-runtime-manifest-v2.json",
    );
  });

  test("classifies official, custom, explicit HTTPS, and explicit local manifest trust", () => {
    expect(resolveUpdateManifestRequest({ env: {} })).toEqual({
      url:
        "https://github.com/tetsuo-ai/agenc-releases/releases/latest/download/" +
        "agenc-runtime-manifest-v2.json",
      trustMode: "official",
      expectedRepository: OFFICIAL_RELEASE_REPOSITORY,
    });
    expect(resolveUpdateManifestRequest({ repo: "example/runtime", env: {} })).toEqual({
      url:
        "https://github.com/example/runtime/releases/latest/download/" +
        "agenc-runtime-manifest-v2.json",
      trustMode: "explicitHttps",
      expectedRepository: "example/runtime",
    });
    expect(
      resolveUpdateManifestRequest({
        manifestUrl: "https://releases.example.test/manifest.json",
        env: {},
      }),
    ).toEqual({
      url: "https://releases.example.test/manifest.json",
      trustMode: "explicitHttps",
    });
    expect(
      resolveUpdateManifestRequest({
        manifestUrl: "file:///tmp/agenc-manifest.json",
        env: {},
      }),
    ).toEqual({
      url: "file:///tmp/agenc-manifest.json",
      trustMode: "explicitLocal",
    });
  });

  test("rejects unsafe local manifest URL aliases before filesystem access", async () => {
    const unsafeUrls = [
      "file://server/share/manifest.json",
      "file://./pipe/agenc-manifest.json",
      "file:///C:relative-manifest.json",
      "file:///%5C%5C.%5Cpipe%5Cagenc-manifest",
      "file:///tmp/../tmp/agenc-manifest.json",
      "file:///tmp/agenc-manifest.json?version=1",
      "FILE:///tmp/agenc-manifest.json",
    ];

    for (const manifestUrl of unsafeUrls) {
      expect(() => resolveUpdateManifestRequest({ manifestUrl, env: {} }))
        .toThrow(/local runtime manifest URL|invalid manifest URL/);
      await expect(
        fetchRuntimeManifest(manifestUrl, (async () => {
          throw new Error("network must not be reached");
        }) as typeof fetch, { trustMode: "explicitLocal" }),
      ).rejects.toThrow(/local runtime manifest URL|trust mode/);
    }
  });

  test("rejects an unpublished or pre-modern pin before network or filesystem mutation", async () => {
    let fetched = false;
    const code = await runAgenCUpdateCli(
      {
        kind: "update",
        check: true,
        json: false,
        pinVersion: "0.7.1",
      },
      {
        ...deps,
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("network must not be reached");
        }) as typeof fetch,
      },
    );
    expect(code).toBe(1);
    expect(fetched).toBe(false);
    expect(err.join("\n")).toContain("0.7.2 or newer");
    expect(err.join("\n")).toContain("has no published modern v2 update contract");
    expect(existsSync(join(agencHome, "runtime"))).toBe(false);
  });

  test("accepts a bounded provenance-complete remote manifest", async () => {
    const manifest = makeRemoteManifest();
    const encoded = Buffer.from(JSON.stringify(manifest));
    await expect(
      fetchRuntimeManifest(
        "https://github.com/tetsuo-ai/agenc-releases/releases/latest/download/" +
          "agenc-runtime-manifest-v2.json",
        fetchResponse(
          responseFromChunks([encoded], { "content-length": String(encoded.length) }),
        ),
        { trustMode: "official" },
      ),
    ).resolves.toMatchObject({
      runtimeVersion: manifest.runtimeVersion,
      releaseRepository: OFFICIAL_RELEASE_REPOSITORY,
    });
  });

  test("official trust rejects a non-official initial origin before fetch", async () => {
    let fetched = false;
    await expect(
      fetchRuntimeManifest(
        "https://example.invalid/manifest.json",
        (async () => {
          fetched = true;
          throw new Error("network must not be reached");
        }) as typeof fetch,
        { trustMode: "official" },
      ),
    ).rejects.toThrow(/official runtime manifest URL is not canonical/);
    expect(fetched).toBe(false);
  });

  test("binds official artifact verification to source, workflow, ref, commit, and hosted runners", () => {
    const artifact = makeOfficialArtifact(Buffer.from("runtime"), Buffer.from("bundle"));
    const manifest = manifestForArtifact(artifact);
    expect(officialRuntimeAttestationVerificationArgs({
      manifest,
      artifactPath: "/private/runtime.tar.gz",
      bundlePath: "/private/runtime.sigstore.json",
    })).toEqual([
      "attestation",
      "verify",
      "/private/runtime.tar.gz",
      "--repo",
      OFFICIAL_SOURCE_REPOSITORY,
      "--bundle",
      "/private/runtime.sigstore.json",
      "--signer-workflow",
      OFFICIAL_RELEASE_WORKFLOW,
      "--signer-digest",
      manifest.build?.sourceCommit,
      "--source-digest",
      manifest.build?.sourceCommit,
      "--source-ref",
      manifest.build?.sourceRef,
      "--hostname",
      "github.com",
      "--cert-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      "--predicate-type",
      "https://slsa.dev/provenance/v1",
      "--deny-self-hosted-runners",
    ]);
  });

  test("uses the exact pinned verifier and removes provenance state on bootstrap failure", async () => {
    const artifactContent = Buffer.from([0x7f]);
    const bundle = Buffer.from('{"verificationMaterial":{}}');
    const artifact = makeOfficialArtifact(artifactContent, bundle);
    const manifest = manifestForArtifact(artifact);
    const artifactPath = join(work, "official-runtime.tar.gz");
    writeFileSync(artifactPath, artifactContent);
    const fetched: string[] = [];
    const pinned = PINNED_GITHUB_CLI_ARTIFACTS["linux-x64"]!;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      fetched.push(url);
      if (url === artifact.attestationUrl) {
        return responseFromChunks(
          [bundle],
          { "content-length": String(bundle.length) },
        );
      }
      if (url === pinned.url) {
        return responseFromChunks(
          [Uint8Array.of(0x00)],
          { "content-length": "1" },
        );
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;

    await expect(verifyOfficialRuntimeArtifactProvenance({
      manifest,
      artifact,
      artifactPath,
      fetchImpl,
      platform: "linux",
      arch: "x64",
      tmpDir: work,
      timeoutMs: 1_000,
      spawnSyncImpl: () => {
        throw new Error("unverified bootstrap must never execute");
      },
    })).rejects.toThrow(/GitHub CLI bootstrap Content-Length mismatch/);
    expect(fetched).toEqual([artifact.attestationUrl, pinned.url]);
    expect(
      readdirSync(work).filter((name) => name.startsWith("agenc-provenance-")),
    ).toEqual([]);
  });

  test("rejects a tampered attestation before fetching or executing the verifier", async () => {
    const artifactContent = Buffer.from([0x7f]);
    const bundle = Buffer.from("tampered bundle");
    const valid = makeOfficialArtifact(artifactContent, bundle);
    const artifact: RuntimeManifestArtifact = {
      ...valid,
      attestationSha256: "0".repeat(64),
    };
    const manifest = manifestForArtifact(artifact);
    const artifactPath = join(work, "tampered-attestation-runtime.tar.gz");
    writeFileSync(artifactPath, artifactContent);
    const fetched: string[] = [];

    await expect(verifyOfficialRuntimeArtifactProvenance({
      manifest,
      artifact,
      artifactPath,
      fetchImpl: (async (input: string | URL | Request) => {
        fetched.push(String(input));
        return responseFromChunks(
          [bundle],
          { "content-length": String(bundle.length) },
        );
      }) as typeof fetch,
      platform: "linux",
      arch: "x64",
      tmpDir: work,
      spawnSyncImpl: () => {
        throw new Error("tampered bundle must never execute a verifier");
      },
    })).rejects.toThrow(/runtime attestation checksum mismatch/);
    expect(fetched).toEqual([artifact.attestationUrl]);
    expect(
      readdirSync(work).filter((name) => name.startsWith("agenc-provenance-")),
    ).toEqual([]);
  });

  test("official install fails at provenance verification before archive parsing", async () => {
    const artifactContent = Buffer.from([0x01]);
    const artifact = makeOfficialArtifact(artifactContent, Buffer.from("bundle"));
    const manifest = manifestForArtifact(artifact);
    let verified = false;
    await expect(installRuntimeFromManifest({
      manifest,
      artifact,
      agencHome,
      acquireLock: async () => () => undefined,
      fetchImpl: fetchResponse(responseFromChunks(
        [artifactContent],
        { "content-length": String(artifactContent.length) },
      )),
      manifestTrust: "official",
      tmpDir: work,
      verifyOfficialProvenance: async (verification) => {
        verified = true;
        expect(verification.artifactPath).toContain("runtime.tar.gz");
        expect(readFileSync(verification.artifactPath)).toEqual(artifactContent);
        throw new Error("provenance gate sentinel");
      },
    })).rejects.toThrow(/provenance gate sentinel/);
    expect(verified).toBe(true);
    expect(
      readdirSync(work).filter((name) => name.startsWith("agenc-update-download-")),
    ).toEqual([]);
  });

  test("explicit HTTPS installs never invoke the official provenance verifier", async () => {
    const source = makeSyntheticArtifact(work);
    const content = readFileSync(source.tarball);
    const artifact = makeRemoteArtifact(content.length, source.sha);
    const manifest = manifestForArtifact(artifact);
    let verifierCalled = false;
    const result = await installRuntimeFromManifest({
      manifest,
      artifact,
      agencHome,
      acquireLock: async () => () => undefined,
      fetchImpl: fetchResponse(responseFromChunks(
        [content],
        { "content-length": String(content.length) },
      )),
      manifestTrust: "explicitHttps",
      tmpDir: work,
      verifyOfficialProvenance: async () => {
        verifierCalled = true;
        throw new Error("explicit trust must not invoke official verification");
      },
    });
    expect(result.downloaded).toBe(true);
    expect(verifierCalled).toBe(false);
  });

  test("prepared verifier success enforces the pinned command and isolated no-egress environment", async () => {
    const artifact = makeOfficialArtifact(Buffer.from("runtime"), Buffer.from("bundle"));
    const manifest = manifestForArtifact(artifact);
    const calls: Array<{
      command: string;
      args: readonly string[];
      env: NodeJS.ProcessEnv | undefined;
    }> = [];
    await runPreparedOfficialAttestationVerifier({
      cliPath: join(work, "gh"),
      manifest,
      artifactPath: join(work, "runtime.tar.gz"),
      bundlePath: join(work, "runtime.sigstore.json"),
      workDir: work,
      deadline: performance.now() + 1_000,
      timeoutMs: 1_000,
      runProcess: async (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return args[0] === "--version"
          ? {
              status: 0,
              signal: null,
              stdout: "gh version 2.96.0 (fixture)\n",
              stderr: "",
            }
          : { status: 0, signal: null, stdout: "", stderr: "" };
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual(["--version"]);
    expect(calls[1]?.args).toEqual(officialRuntimeAttestationVerificationArgs({
      manifest,
      artifactPath: join(work, "runtime.tar.gz"),
      bundlePath: join(work, "runtime.sigstore.json"),
    }));
    for (const call of calls) {
      expect(call.env).toMatchObject({
        GH_HOST: "github.com",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_PROMPT_DISABLED: "1",
        GH_SPINNER_DISABLED: "1",
        GH_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
      });
      expect(call.env?.GH_TOKEN).toBeUndefined();
      expect(call.env?.GITHUB_TOKEN).toBeUndefined();
      expect(call.env?.PATH).not.toContain(join(work, "bin"));
    }
  });

  test("official caches and recovery stages require a versioned provenance receipt", async () => {
    const source = makeSyntheticArtifact(work);
    const content = readFileSync(source.tarball);
    const artifact = makeOfficialArtifact(content, Buffer.from("bundle"));
    const manifest = manifestForArtifact(artifact);
    const fetchArtifact = () => fetchResponse(responseFromChunks(
      [content],
      { "content-length": String(content.length) },
    ));
    const installDir = join(
      agencHome,
      "runtime",
      artifact.runtimeVersion,
      linuxInstallKey(artifact.sha256),
    );
    const receiptPath = join(installDir, ".agenc-official-provenance-v1.json");

    const explicit = await installRuntimeFromManifest({
      manifest,
      artifact,
      agencHome,
      acquireLock: async () => () => undefined,
      fetchImpl: fetchArtifact(),
      manifestTrust: "explicitHttps",
      tmpDir: work,
    });
    expect(explicit.downloaded).toBe(true);
    expect(existsSync(receiptPath)).toBe(false);

    let verified = 0;
    const migrated = await installRuntimeFromManifest({
      manifest,
      artifact,
      agencHome,
      acquireLock: async () => () => undefined,
      fetchImpl: fetchArtifact(),
      manifestTrust: "official",
      tmpDir: work,
      verifyOfficialProvenance: async () => { verified += 1; },
    });
    expect(migrated.downloaded).toBe(true);
    expect(verified).toBe(1);
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      artifactSha256: artifact.sha256,
      attestationSha256: artifact.attestationSha256,
      sourceRepository: OFFICIAL_SOURCE_REPOSITORY,
      signerWorkflow: OFFICIAL_RELEASE_WORKFLOW,
      denySelfHostedRunners: true,
      verifier: "gh-2.96.0",
    });

    const cached = await installRuntimeFromManifest({
      manifest,
      artifact,
      agencHome,
      acquireLock: async () => {
        throw new Error("verified cache must not lock");
      },
      fetchImpl: (async () => {
        throw new Error("verified cache must not fetch");
      }) as typeof fetch,
      manifestTrust: "official",
      tmpDir: work,
      verifyOfficialProvenance: async () => {
        throw new Error("verified cache must not reverify");
      },
    });
    expect(cached.downloaded).toBe(false);

    rmSync(receiptPath);
    const recovery = join(dirname(installDir), `.${basename(installDir)}.install-unverified`);
    renameSync(installDir, recovery);
    const recovered = await installRuntimeFromManifest({
      manifest,
      artifact,
      agencHome,
      acquireLock: async () => () => undefined,
      fetchImpl: fetchArtifact(),
      manifestTrust: "official",
      tmpDir: work,
      verifyOfficialProvenance: async () => { verified += 1; },
    });
    expect(recovered.downloaded).toBe(true);
    expect(verified).toBe(2);
    expect(existsSync(receiptPath)).toBe(true);
    expect(existsSync(recovery)).toBe(false);
  });

  test("runtime extraction ignores a project-prepended tar executable", async () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const source = makeSyntheticArtifact(work);
    const content = readFileSync(source.tarball);
    const artifact = makeRemoteArtifact(content.length, source.sha);
    const manifest = manifestForArtifact(artifact);
    const fakeBin = join(work, "fake-bin");
    const sentinel = join(work, "fake-tar-ran");
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, "tar"),
      `#!/bin/sh\nprintf compromised > ${JSON.stringify(sentinel)}\nexit 99\n`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    try {
      const trusted = await resolveTrustedSystemTar();
      expect(trusted.path).not.toBe(join(fakeBin, "tar"));
      expect(trusted.env.PATH).toBe("/usr/bin:/bin");
      await expect(installRuntimeFromManifest({
        manifest,
        artifact,
        agencHome,
        acquireLock: async () => () => undefined,
        fetchImpl: fetchResponse(responseFromChunks(
          [content],
          { "content-length": String(content.length) },
        )),
        manifestTrust: "explicitHttps",
        tmpDir: work,
      })).resolves.toMatchObject({ downloaded: true });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    expect(existsSync(sentinel)).toBe(false);
  });

  test("rejects a non-sticky writable temporary parent before creating a child", async () => {
    if (process.platform === "win32") return;
    const unsafeTemp = join(work, "unsafe-temp");
    mkdirSync(unsafeTemp, { mode: 0o777 });
    chmodSync(unsafeTemp, 0o777);
    const beforeMtime = statSync(unsafeTemp, { bigint: true }).mtimeNs;
    const content = Buffer.from([0x01]);
    const artifact = makeRemoteArtifact(content.length, sha256(content));
    await expect(installRuntimeFromManifest({
      manifest: manifestForArtifact(artifact),
      artifact,
      agencHome,
      acquireLock: async () => () => undefined,
      fetchImpl: fetchResponse(responseFromChunks([content])),
      manifestTrust: "explicitHttps",
      tmpDir: unsafeTemp,
    })).rejects.toThrow(/protected directory chain permits untrusted mutation/);
    expect(readdirSync(unsafeTemp)).toEqual([]);
    expect(statSync(unsafeTemp, { bigint: true }).mtimeNs).toBe(beforeMtime);
    chmodSync(unsafeTemp, 0o700);
  });

  test("hostile body cleanup cannot extend the signed download deadline", async () => {
    const artifact = makeRemoteArtifact(1);
    const never = new Promise<IteratorResult<Uint8Array>>(() => undefined);
    const body = {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          next: async () => {
            if (emitted) return { done: true, value: undefined };
            emitted = true;
            return { done: false, value: Uint8Array.of(0x01, 0x02) };
          },
          return: () => never,
        };
      },
      cancel: () => new Promise<void>(() => undefined),
    };
    const started = performance.now();
    await expect(installRuntimeFromManifest({
      manifest: manifestForArtifact(artifact),
      artifact,
      agencHome,
      acquireLock: async () => () => undefined,
      downloadTimeoutMs: 30,
      fetchImpl: fetchResponse({
        body,
        headers: new Headers(),
        ok: true,
        redirected: false,
        status: 200,
        statusText: "OK",
        url: "",
      } as unknown as Response),
      manifestTrust: "explicitHttps",
      tmpDir: work,
    })).rejects.toThrow(/exceeds signed size/);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("bounded child execution kills a SIGTERM-resistant process at its deadline", async () => {
    const started = performance.now();
    const result = await runBoundedProcess(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
      ],
      {
        encoding: "utf8",
        env: process.env,
        maxBuffer: 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 100,
        windowsHide: true,
      },
    );
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("rejects remote manifests missing release and build provenance", async () => {
    const cases: readonly [string, string][] = [
      ["releaseTag", "releaseTag does not match"],
      ["releaseRepository", "releaseRepository is invalid"],
      ["build", "build provenance is invalid"],
    ];
    for (const [field, message] of cases) {
      const manifest = makeRemoteManifest({ [field]: undefined });
      const encoded = Buffer.from(JSON.stringify(manifest));
      await expect(
        fetchRuntimeManifest(
          "https://example.invalid/manifest.json",
          fetchResponse(responseFromChunks([encoded])),
          { trustMode: "explicitHttps" },
        ),
      ).rejects.toThrow(message);
    }
  });

  test("rejects duplicate exact-target manifest artifacts", async () => {
    const manifest = makeRemoteManifest();
    const [artifact] = manifest.artifacts as readonly Record<string, unknown>[];
    manifest.artifacts = [artifact, { ...artifact }];
    const encoded = Buffer.from(JSON.stringify(manifest));
    await expect(
      fetchRuntimeManifest(
        "https://example.invalid/manifest.json",
        fetchResponse(responseFromChunks([encoded])),
        { trustMode: "explicitHttps" },
      ),
    ).rejects.toThrow(/duplicate runtime manifest artifact/);
  });

  test("bounds local and remote manifest bodies and cancels hostile streams", async () => {
    const oversizedPath = join(work, "oversized-manifest.json");
    writeFileSync(oversizedPath, Buffer.alloc(MAX_RUNTIME_MANIFEST_BYTES + 1, 0x20));
    chmodSync(oversizedPath, 0o600);
    await expect(
      fetchRuntimeManifest(`file://${oversizedPath}`),
    ).rejects.toThrow(/bounded|exceeds/);

    let declaredCancelled = 0;
    await expect(
      fetchRuntimeManifest(
        "https://example.invalid/manifest.json",
        fetchResponse(
          responseFromChunks(
            [],
            { "content-length": String(MAX_RUNTIME_MANIFEST_BYTES + 1) },
            () => { declaredCancelled += 1; },
          ),
        ),
      ),
    ).rejects.toThrow(/runtime manifest exceeds/);
    expect(declaredCancelled).toBe(1);

    let streamedCancelled = 0;
    await expect(
      fetchRuntimeManifest(
        "https://example.invalid/manifest.json",
        fetchResponse(
          responseFromChunks(
            [Buffer.alloc(MAX_RUNTIME_MANIFEST_BYTES + 1, 0x20)],
            {},
            () => { streamedCancelled += 1; },
          ),
        ),
      ),
    ).rejects.toThrow(/runtime manifest exceeds/);
    expect(streamedCancelled).toBe(1);
  });

  test("uses fatal UTF-8 decoding for remote manifests", async () => {
    await expect(
      fetchRuntimeManifest(
        "https://example.invalid/manifest.json",
        fetchResponse(responseFromChunks([Uint8Array.of(0xff)])),
      ),
    ).rejects.toThrow(/not valid UTF-8/);
  });

  test.skipIf(process.platform === "win32")(
    "rejects a local manifest writable by another principal",
    async () => {
      const artifact = makeSyntheticArtifact(work);
      const manifestPath = writeManifest(work, artifact);
      chmodSync(manifestPath, 0o666);
      await expect(
        fetchRuntimeManifest(`file://${manifestPath}`),
      ).rejects.toThrow(/group\/world-writable/);
    },
  );

  test("manifest fetch rejects an HTTPS-to-HTTP redirect", async () => {
    let cancelled = 0;
    const fetchImpl = (async () => ({
      status: 302,
      headers: new Headers({ location: "http://example.invalid/manifest.json" }),
      body: { cancel: async () => { cancelled += 1; } },
      redirected: false,
      url: "",
    })) as unknown as typeof fetch;
    await expect(
      fetchRuntimeManifest("https://example.invalid/manifest.json", fetchImpl),
    ).rejects.toThrow(/refusing HTTPS downgrade/);
    expect(cancelled).toBe(1);
  });

  test("manifest fetch cancels a redirect with no Location", async () => {
    let cancelled = 0;
    const fetchImpl = (async () => ({
      status: 302,
      headers: new Headers(),
      body: { cancel: async () => { cancelled += 1; } },
      redirected: false,
      url: "",
    })) as unknown as typeof fetch;
    await expect(
      fetchRuntimeManifest("https://example.invalid/manifest.json", fetchImpl),
    ).rejects.toThrow(/redirect is missing Location/);
    expect(cancelled).toBe(1);
  });

  test("manifest fetch aborts stalled headers and stalled bodies at one deadline", async () => {
    let headerAborted = false;
    const stalledHeaders = ((_input: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          headerAborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      })) as typeof fetch;
    await expect(
      fetchRuntimeManifest(
        "https://example.invalid/manifest.json",
        stalledHeaders,
        { timeoutMs: 20 },
      ),
    ).rejects.toThrow(/manifest response timed out after 20ms/);
    expect(headerAborted).toBe(true);

    let bodyCancelled = 0;
    const stalledBody = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: async () => ({ done: true, value: undefined }),
        };
      },
      cancel: async () => { bodyCancelled += 1; },
    };
    await expect(
      fetchRuntimeManifest(
        "https://example.invalid/manifest.json",
        fetchResponse({
          body: stalledBody,
          headers: new Headers(),
          ok: true,
          redirected: false,
          status: 200,
          statusText: "OK",
          url: "",
        } as unknown as Response),
        { timeoutMs: 20 },
      ),
    ).rejects.toThrow(/manifest body timed out after 20ms/);
    expect(bodyCancelled).toBe(1);
  });

  test("rejects artifact streams that exceed or undershoot their signed size", async () => {
    for (const testCase of [
      { expected: 1, chunks: [Uint8Array.of(0x01, 0x02)], message: "exceeds signed size" },
      { expected: 2, chunks: [Uint8Array.of(0x01)], message: "byte count mismatch" },
    ] as const) {
      const artifact = makeRemoteArtifact(testCase.expected);
      let cancelled = 0;
      await expect(
        installRuntimeFromManifest({
          manifest: manifestForArtifact(artifact),
          artifact,
          agencHome,
          acquireLock: async () => () => undefined,
          fetchImpl: fetchResponse(
            responseFromChunks(
              testCase.chunks,
              {},
              () => { cancelled += 1; },
            ),
          ),
          manifestTrust: "explicitHttps",
          tmpDir: work,
        }),
      ).rejects.toThrow(testCase.message);
      expect(cancelled).toBe(1);
      expect(
        readdirSync(work).filter((name) => name.startsWith("agenc-update-download-")),
      ).toEqual([]);
    }
  });

  test("artifact download aborts a stalled body and removes partial state", async () => {
    const artifact = makeRemoteArtifact(1);
    let cancelled = 0;
    const stalledBody = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: async () => ({ done: true, value: undefined }),
        };
      },
      cancel: async () => { cancelled += 1; },
    };
    await expect(
      installRuntimeFromManifest({
        manifest: manifestForArtifact(artifact),
        artifact,
        agencHome,
        acquireLock: async () => () => undefined,
        downloadTimeoutMs: 20,
        fetchImpl: fetchResponse({
          body: stalledBody,
          headers: new Headers(),
          ok: true,
          redirected: false,
          status: 200,
          statusText: "OK",
          url: "",
        } as unknown as Response),
        manifestTrust: "explicitHttps",
        tmpDir: work,
      }),
    ).rejects.toThrow(/artifact body timed out after 20ms/);
    expect(cancelled).toBe(1);
    expect(
      readdirSync(work).filter((name) => name.startsWith("agenc-update-download-")),
    ).toEqual([]);
  });

  test("rejects a detached artifact Content-Length before reading its body", async () => {
    const artifact = makeRemoteArtifact(1);
    let cancelled = 0;
    await expect(
      installRuntimeFromManifest({
        manifest: manifestForArtifact(artifact),
        artifact,
        agencHome,
        acquireLock: async () => () => undefined,
        fetchImpl: fetchResponse(
          responseFromChunks(
            [Uint8Array.of(0x01, 0x02)],
            { "content-length": "2" },
            () => { cancelled += 1; },
          ),
        ),
        manifestTrust: "explicitHttps",
        tmpDir: work,
      }),
    ).rejects.toThrow(/Content-Length mismatch/);
    expect(cancelled).toBe(1);
    expect(
      readdirSync(work).filter((name) => name.startsWith("agenc-update-download-")),
    ).toEqual([]);
  });

  test("rejects an artifact over the hard cap before locking, fetching, or writing", async () => {
    const artifact = makeRemoteArtifact(MAX_RUNTIME_ARTIFACT_BYTES + 1);
    let locked = false;
    let fetched = false;
    await expect(
      installRuntimeFromManifest({
        manifest: manifestForArtifact(artifact),
        artifact,
        agencHome,
        acquireLock: async () => {
          locked = true;
          return () => undefined;
        },
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("network must not be reached");
        }) as typeof fetch,
        manifestTrust: "explicitHttps",
        tmpDir: work,
      }),
    ).rejects.toThrow(/signed size must be between/);
    expect(locked).toBe(false);
    expect(fetched).toBe(false);
    expect(existsSync(join(agencHome, "runtime"))).toBe(false);
  });

  test("the exported install boundary rejects path-forming manifest data before mutation", async () => {
    const source = makeSyntheticArtifact(work);
    const valid = JSON.parse(
      readFileSync(writeManifest(work, source), "utf8"),
    ) as RuntimeManifest;
    for (const [index, mutate] of [
      (manifest: RuntimeManifest) => {
        (manifest as { runtimeVersion: string }).runtimeVersion = "../escape";
      },
      (manifest: RuntimeManifest) => {
        (manifest.artifacts[0].bins as { agenc: string }).agenc = "../../escape";
      },
    ].entries()) {
      const manifest = structuredClone(valid);
      mutate(manifest);
      const unsafeHome = join(work, `untrusted-home-${index}`);
      let locked = false;
      let fetched = false;
      await expect(
        installRuntimeFromManifest({
          manifest,
          artifact: manifest.artifacts[0],
          agencHome: unsafeHome,
          manifestTrust: "explicitLocal",
          acquireLock: async () => {
            locked = true;
            return () => undefined;
          },
          fetchImpl: (async () => {
            fetched = true;
            throw new Error("network must not be reached");
          }) as typeof fetch,
        }),
      ).rejects.toThrow(/manifest|runtimeVersion|identity/);
      expect(locked).toBe(false);
      expect(fetched).toBe(false);
      expect(existsSync(unsafeHome)).toBe(false);
    }
  });

  test("the exported install boundary requires the selected manifest object", async () => {
    const source = makeSyntheticArtifact(work);
    const manifest = JSON.parse(
      readFileSync(writeManifest(work, source), "utf8"),
    ) as RuntimeManifest;
    const unsafeHome = join(work, "detached-artifact-home");
    await expect(
      installRuntimeFromManifest({
        manifest,
        artifact: structuredClone(manifest.artifacts[0]),
        agencHome: unsafeHome,
        manifestTrust: "explicitLocal",
      }),
    ).rejects.toThrow(/unique selected manifest member/);
    expect(existsSync(unsafeHome)).toBe(false);
  });

  test("reports up to date without touching disk when versions match", async () => {
    const artifact = makeSyntheticArtifact(work);
    const manifestPath = writeManifest(work, artifact);
    const code = await runAgenCUpdateCli(
      {
        kind: "update",
        check: false,
        json: false,
        manifestUrl: `file://${manifestPath}`,
      },
      { ...deps, currentVersion: NEW_VERSION },
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("up to date");
    expect(existsSync(join(agencHome, "runtime", NEW_VERSION))).toBe(false);
  });

  test("--check reports the update without downloading or writing", async () => {
    const artifact = makeSyntheticArtifact(work);
    const manifestPath = writeManifest(work, artifact);
    const code = await runAgenCUpdateCli(
      {
        kind: "update",
        check: true,
        json: true,
        manifestUrl: `file://${manifestPath}`,
      },
      deps,
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({
      currentVersion: OLD_VERSION,
      latestVersion: NEW_VERSION,
      updateAvailable: true,
    });
    expect(existsSync(join(agencHome, "runtime", NEW_VERSION))).toBe(false);
  });

  test("full update: installs under the marker contract and repoints the wrapper", async () => {
    const artifact = makeSyntheticArtifact(work);
    const manifestPath = writeManifest(work, artifact);
    const oldBin = join(agencHome, "runtime", OLD_VERSION, LINUX_ARTIFACT_KEY, BIN_REL);
    const wrapper = writeInstallShWrapper(binDir, agencHome, oldBin);

    const code = await runAgenCUpdateCli(
      {
        kind: "update",
        check: false,
        json: false,
        manifestUrl: `file://${manifestPath}`,
      },
      deps,
    );
    expect(code).toBe(0);

    // Marker contract includes platform, architecture, libc, and native ABI.
    const installDir = join(
      agencHome,
      "runtime",
      NEW_VERSION,
      linuxInstallKey(artifact.sha),
    );
    const newBin = join(installDir, BIN_REL);
    expect(existsSync(newBin)).toBe(true);
    expect(readFileSync(join(installDir, ".agenc-runtime-ok"), "utf8")).toBe(
      artifact.sha,
    );

    // Wrapper repointed, signature + node path + AGENC_HOME preserved, still 0755.
    const rewritten = readFileSync(wrapper, "utf8");
    expect(rewritten).toContain("Generated by AgenC install.sh");
    expect(rewritten).toContain("AgenC wrapper metadata v1:");
    expect(parseInstallShWrapper(wrapper)).toMatchObject({
      nodeBin: process.execPath,
      runtimeBin: newBin,
      agencHome,
    });
    expect(statSync(wrapper).mode & 0o777).toBe(0o755);

    // The repointed wrapper actually launches the new runtime bin.
    const run = spawnSync(wrapper, ["hello"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("ok hello");
  });

  test("rejects a relative AGENC_HOME instead of binding it to the updater cwd", async () => {
    const artifact = makeSyntheticArtifact(work);
    const manifestPath = writeManifest(work, artifact);
    const oldBin = join(agencHome, "runtime", OLD_VERSION, LINUX_ARTIFACT_KEY, BIN_REL);
    const wrapper = writeInstallShWrapper(binDir, agencHome, oldBin);

    const code = await runAgenCUpdateCli(
      {
        kind: "update",
        check: false,
        json: false,
        manifestUrl: `file://${manifestPath}`,
      },
      { ...deps, env: { ...deps!.env, AGENC_HOME: "relative-home" } },
    );

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("AGENC_HOME must be an absolute path");
    expect(parseInstallShWrapper(wrapper)?.runtimeBin).toBe(oldBin);
  });

  test.skipIf(process.platform === "win32")(
    "canonicalizes an AGENC_HOME symlink before wrapper ownership and install locking",
    async () => {
      const artifact = makeSyntheticArtifact(work);
      const manifestPath = writeManifest(work, artifact);
      const aliasHome = join(work, "home-alias");
      symlinkSync(agencHome, aliasHome, "dir");
      const oldBin = join(agencHome, "runtime", OLD_VERSION, LINUX_ARTIFACT_KEY, BIN_REL);
      const wrapper = writeInstallShWrapper(binDir, agencHome, oldBin);

      const code = await runAgenCUpdateCli(
        {
          kind: "update",
          check: false,
          json: false,
          manifestUrl: `file://${manifestPath}`,
        },
        { ...deps, env: { ...deps!.env, AGENC_HOME: aliasHome } },
      );

      expect(code).toBe(0);
      expect(parseInstallShWrapper(wrapper)).toMatchObject({
        agencHome,
        runtimeBin: join(
          agencHome,
          "runtime",
          NEW_VERSION,
          linuxInstallKey(artifact.sha),
          BIN_REL,
        ),
      });
    },
  );

  test("checksum mismatch aborts: no marker, wrapper untouched", async () => {
    const artifact = makeSyntheticArtifact(work);
    const badSha = "0".repeat(64);
    const manifestPath = writeManifest(work, {
      tarball: artifact.tarball,
      sha: badSha,
    });
    const oldBin = join(agencHome, "runtime", OLD_VERSION, LINUX_ARTIFACT_KEY, BIN_REL);
    const wrapper = writeInstallShWrapper(binDir, agencHome, oldBin);
    const before = readFileSync(wrapper, "utf8");

    const code = await runAgenCUpdateCli(
      {
        kind: "update",
        check: false,
        json: false,
        manifestUrl: `file://${manifestPath}`,
      },
      deps,
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("checksum mismatch");
    expect(
      existsSync(
        join(
          agencHome,
          "runtime",
          NEW_VERSION,
          linuxInstallKey(badSha),
          ".agenc-runtime-ok",
        ),
      ),
    ).toBe(false);
    expect(readFileSync(wrapper, "utf8")).toBe(before);
  });

  test("runtime install preserves the operation and every cleanup failure in order", async () => {
    const artifact = makeSyntheticArtifact(work);
    rmSync(join(work, "tree", BIN_REL));
    const rebuilt = spawnSync("tar", ["-czf", artifact.tarball, "-C", join(work, "tree"), "node_modules"]);
    expect(rebuilt.status).toBe(0);
    artifact.sha = sha256(readFileSync(artifact.tarball));
    const manifest = JSON.parse(readFileSync(writeManifest(work, artifact), "utf8"));
    const cleanupPaths: string[] = [];
    let acquisition = 0;
    try {
      await installRuntimeFromManifest({
        manifest,
        artifact: manifest.artifacts[0],
        agencHome,
        manifestTrust: "explicitLocal",
        tmpDir: work,
        acquireLock: async () => {
          acquisition += 1;
          if (acquisition === 1) return () => {};
          return () => { throw new Error("release cleanup failed"); };
        },
        remove: (path) => {
          cleanupPaths.push(path);
          if (basename(path).startsWith(".")) {
            throw new Error("staging cleanup failed");
          }
          throw new Error("download cleanup failed");
        },
      });
      expect.unreachable("runtime install should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.message).toBe("runtime install and cleanup did not both complete");
      const messages = aggregate.errors.map((entry: Error) => entry.message);
      expect(messages[0]).toContain("runtime extracted but entry missing");
      expect(messages.slice(1)).toEqual([
        "staging cleanup failed",
        "release cleanup failed",
        "download cleanup failed",
      ]);
    } finally {
      for (const path of cleanupPaths) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  test("refuses to run without an install.sh wrapper and points at the npm path", async () => {
    const artifact = makeSyntheticArtifact(work);
    const manifestPath = writeManifest(work, artifact);
    const code = await runAgenCUpdateCli(
      {
        kind: "update",
        check: false,
        json: false,
        manifestUrl: `file://${manifestPath}`,
      },
      deps,
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("npm install -g @tetsuo-ai/agenc@latest");
    expect(existsSync(join(agencHome, "runtime", NEW_VERSION))).toBe(false);
  });

  test("never rewrites an unsigned script that happens to be named agenc", async () => {
    mkdirSync(binDir, { recursive: true });
    const impostor = join(binDir, "agenc");
    // A hand-written wrapper that is structurally identical to ours (parseable
    // exec + AGENC_HOME lines) but lacks the generation signature. Only the
    // signature check separates it from a rewrite target.
    const oldBin = join(agencHome, "runtime", OLD_VERSION, LINUX_ARTIFACT_KEY, BIN_REL);
    writeFileSync(
      impostor,
      renderInstallShWrapper({
        nodeBin: process.execPath,
        runtimeBin: oldBin,
        agencHome,
      }).replace(/^# Generated by AgenC install\.sh.*\n/m, "# my own wrapper\n"),
    );
    chmodSync(impostor, 0o755);
    const before = readFileSync(impostor, "utf8");

    expect(parseInstallShWrapper(impostor)).toBeNull();
    expect(findInstallShWrappers({ env: deps!.env, userHome: work })).toEqual(
      [],
    );

    const artifact = makeSyntheticArtifact(work);
    const manifestPath = writeManifest(work, artifact);
    const code = await runAgenCUpdateCli(
      {
        kind: "update",
        check: false,
        json: false,
        manifestUrl: `file://${manifestPath}`,
      },
      deps,
    );
    expect(code).toBe(1);
    expect(readFileSync(impostor, "utf8")).toBe(before);
  });

  test("verified existing install short-circuits the download", async () => {
    const artifact = makeSyntheticArtifact(work);
    const manifestPath = writeManifest(work, artifact);
    const oldBin = join(agencHome, "runtime", OLD_VERSION, LINUX_ARTIFACT_KEY, BIN_REL);
    writeInstallShWrapper(binDir, agencHome, oldBin);

    // First run installs.
    expect(
      await runAgenCUpdateCli(
        {
          kind: "update",
          check: false,
          json: true,
          manifestUrl: `file://${manifestPath}`,
        },
        deps,
      ),
    ).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ downloaded: true });

    // Delete the tarball: a second run must succeed via the verified marker.
    rmSync(artifact.tarball);
    out.length = 0;
    expect(
      await runAgenCUpdateCli(
        {
          kind: "update",
          check: false,
          json: true,
          manifestUrl: `file://${manifestPath}`,
        },
        deps,
      ),
    ).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ downloaded: false });
  });

  test("recovers a verified promotion backup before artifact download", async () => {
    const artifact = makeSyntheticArtifact(work);
    const manifestPath = writeManifest(work, artifact);
    const oldBin = join(agencHome, "runtime", OLD_VERSION, LINUX_ARTIFACT_KEY, BIN_REL);
    writeInstallShWrapper(binDir, agencHome, oldBin);
    const command = {
      kind: "update" as const,
      check: false,
      json: true,
      manifestUrl: `file://${manifestPath}`,
    };
    expect(await runAgenCUpdateCli(command, deps)).toBe(0);
    const installDir = join(agencHome, "runtime", NEW_VERSION, linuxInstallKey(artifact.sha));
    const backup = `${installDir}.old-crash`;
    renameSync(installDir, backup);
    rmSync(artifact.tarball);
    out.length = 0;

    expect(await runAgenCUpdateCli(command, deps)).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ downloaded: false });
    expect(existsSync(join(installDir, BIN_REL))).toBe(true);
    expect(existsSync(backup)).toBe(false);
  });

  test("recovers a prepared stage and cleans every promotion residue offline", async () => {
    const artifact = makeSyntheticArtifact(work);
    const manifestPath = writeManifest(work, artifact);
    const oldBin = join(agencHome, "runtime", OLD_VERSION, LINUX_ARTIFACT_KEY, BIN_REL);
    writeInstallShWrapper(binDir, agencHome, oldBin);
    const command = {
      kind: "update" as const,
      check: false,
      json: true,
      manifestUrl: `file://${manifestPath}`,
    };
    expect(await runAgenCUpdateCli(command, deps)).toBe(0);
    const installDir = join(agencHome, "runtime", NEW_VERSION, linuxInstallKey(artifact.sha));
    const stage = join(dirname(installDir), `.${basename(installDir)}.install-crash`);
    const backup = `${installDir}.old-invalid`;
    renameSync(installDir, stage);
    mkdirSync(installDir);
    writeFileSync(join(installDir, ".agenc-runtime-ok"), "invalid");
    cpSync(installDir, backup, { recursive: true });
    rmSync(artifact.tarball);
    out.length = 0;

    expect(await runAgenCUpdateCli(command, deps)).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ downloaded: false });
    expect(existsSync(join(installDir, BIN_REL))).toBe(true);
    expect(
      readdirSync(dirname(installDir)).filter((name) => name.includes(".install-") || name.includes(".old-")),
    ).toEqual([]);
  });

  test("an explicit --pin may downgrade while an unpinned update may not", async () => {
    const artifact = makeSyntheticArtifact(work);
    const manifestPath = writeManifest(work, artifact);
    const currentVersion = "10.0.0";
    const currentBin = join(agencHome, "runtime", currentVersion, LINUX_ARTIFACT_KEY, BIN_REL);
    const wrapper = writeInstallShWrapper(binDir, agencHome, currentBin);

    expect(await runAgenCUpdateCli({
      kind: "update",
      check: false,
      json: false,
      manifestUrl: `file://${manifestPath}`,
    }, { ...deps, currentVersion })).toBe(0);
    expect(readFileSync(wrapper, "utf8")).toContain(currentBin);
    expect(existsSync(join(agencHome, "runtime", NEW_VERSION))).toBe(false);

    out.length = 0;
    expect(await runAgenCUpdateCli({
      kind: "update",
      check: false,
      json: false,
      pinVersion: NEW_VERSION,
      manifestUrl: `file://${manifestPath}`,
    }, { ...deps, currentVersion })).toBe(0);
    expect(readFileSync(wrapper, "utf8")).toContain(
      join(agencHome, "runtime", NEW_VERSION, linuxInstallKey(artifact.sha), BIN_REL),
    );
  });

  test("concurrent unpinned activations deterministically retain the newest version", async () => {
    const oldBin = join(agencHome, "runtime", "8.0.0", LINUX_ARTIFACT_KEY, BIN_REL);
    const wrapperPath = writeInstallShWrapper(binDir, agencHome, oldBin);
    const wrapper = parseInstallShWrapper(wrapperPath)!;
    const lowBin = join(agencHome, "runtime", "9.0.0", LINUX_ARTIFACT_KEY, BIN_REL);
    const highBin = join(agencHome, "runtime", "10.0.0", LINUX_ARTIFACT_KEY, BIN_REL);

    const results = await Promise.all([
      activateInstallShWrappers({
        wrappers: [wrapper],
        runtimeBin: highBin,
        targetVersion: "10.0.0",
        agencHome,
        allowDowngrade: false,
      }),
      activateInstallShWrappers({
        wrappers: [wrapper],
        runtimeBin: lowBin,
        targetVersion: "9.0.0",
        agencHome,
        allowDowngrade: false,
      }),
    ]);

    expect(parseInstallShWrapper(wrapperPath)?.runtimeBin).toBe(highBin);
    expect(results[0]).toEqual({ activated: true });
    expect(
      results[1].activated === true ||
      (results[1].activated === false && results[1].retainedVersion === "10.0.0"),
    ).toBe(true);
    expect(existsSync(join(agencHome, "runtime", ".activation-lock.sqlite"))).toBe(true);
    expect(existsSync(join(agencHome, "runtime", ".activation-transaction.json"))).toBe(false);
  });

  test("atomic wrapper replacement reuses one stable account-level lock", async () => {
      const wrapperPath = writeInstallShWrapper(
        binDir,
        agencHome,
        join(agencHome, "runtime", "8.0.0", LINUX_ARTIFACT_KEY, BIN_REL),
      );
      const lockPath = wrapperActivationLockPath(
        wrapperPath,
        resolveActivationLockRegistry(),
      );

      for (const version of ["9.0.0", "10.0.0"]) {
        await activateInstallShWrappers({
          wrappers: [parseInstallShWrapper(wrapperPath)!],
          runtimeBin: join(agencHome, "runtime", version, LINUX_ARTIFACT_KEY, BIN_REL),
          targetVersion: version,
          agencHome,
          allowDowngrade: false,
        });
        expect(existsSync(lockPath)).toBe(true);
      }
      expect(parseInstallShWrapper(wrapperPath)?.runtimeBin).toContain("10.0.0");
    });

  test("a partial multi-wrapper activation journal rolls forward before new work", async () => {
    const firstPath = writeInstallShWrapper(
      join(work, "bin-a"),
      agencHome,
      join(agencHome, "runtime", "8.0.0", LINUX_ARTIFACT_KEY, BIN_REL),
    );
    const secondPath = writeInstallShWrapper(
      join(work, "bin-b"),
      agencHome,
      join(agencHome, "runtime", "8.0.0", LINUX_ARTIFACT_KEY, BIN_REL),
    );
    const wrappers = [parseInstallShWrapper(firstPath)!, parseInstallShWrapper(secondPath)!];
    const targetBin = join(agencHome, "runtime", "9.0.0", LINUX_ARTIFACT_KEY, BIN_REL);
    const originals = wrappers.map((wrapper) => readFileSync(wrapper.path, "utf8"));
    const desired = wrappers.map((wrapper) =>
      renderInstallShWrapper({ ...wrapper, runtimeBin: targetBin }));
    mkdirSync(join(agencHome, "runtime"), { recursive: true });
    writeFileSync(firstPath, desired[0]);
    const journal = join(agencHome, "runtime", ".activation-transaction.json");
    writeFileSync(journal, `${JSON.stringify({
      version: 1,
      targetVersion: "9.0.0",
      entries: wrappers.map((wrapper, index) => ({
        path: wrapper.path,
        original: originals[index],
        desired: desired[index],
        mode: 0o755,
      })),
    })}\n`);

    const nextBin = join(agencHome, "runtime", "10.0.0", LINUX_ARTIFACT_KEY, BIN_REL);
    await activateInstallShWrappers({
      wrappers: [wrappers[0]],
      runtimeBin: nextBin,
      targetVersion: "10.0.0",
      agencHome,
      allowDowngrade: false,
    });

    expect(parseInstallShWrapper(firstPath)?.runtimeBin).toBe(nextBin);
    expect(readFileSync(secondPath, "utf8")).toBe(desired[1]);
    expect(existsSync(journal)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "rejects an unsafe journal-referenced wrapper before resuming the transaction",
    async () => {
      const activePath = writeInstallShWrapper(
        join(work, "journal-active-bin"),
        agencHome,
        join(agencHome, "runtime", "8.0.0", LINUX_ARTIFACT_KEY, BIN_REL),
      );
      const journalOnlyPath = writeInstallShWrapper(
        join(work, "journal-only-bin"),
        agencHome,
        join(agencHome, "runtime", "8.0.0", LINUX_ARTIFACT_KEY, BIN_REL),
      );
      const active = parseInstallShWrapper(activePath)!;
      const journalOnly = parseInstallShWrapper(journalOnlyPath)!;
      const activeOriginal = readFileSync(activePath, "utf8");
      const journalOnlyOriginal = readFileSync(journalOnlyPath, "utf8");
      const interruptedBin = join(
        agencHome,
        "runtime",
        "9.0.0",
        LINUX_ARTIFACT_KEY,
        BIN_REL,
      );
      const journalOnlyDesired = renderInstallShWrapper({
        ...journalOnly,
        runtimeBin: interruptedBin,
      });
      const runtimeRoot = join(agencHome, "runtime");
      mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
      chmodSync(runtimeRoot, 0o700);
      const journal = join(runtimeRoot, ".activation-transaction.json");
      writeFileSync(journal, `${JSON.stringify({
        version: 1,
        targetVersion: "9.0.0",
        entries: [{
          path: journalOnlyPath,
          original: journalOnlyOriginal,
          desired: journalOnlyDesired,
          mode: 0o755,
        }],
      })}\n`);
      chmodSync(journalOnlyPath, 0o777);
      try {
        await expect(activateInstallShWrappers({
          wrappers: [active],
          runtimeBin: join(
            agencHome,
            "runtime",
            "10.0.0",
            LINUX_ARTIFACT_KEY,
            BIN_REL,
          ),
          targetVersion: "10.0.0",
          agencHome,
          allowDowngrade: false,
        })).rejects.toThrow(/protected file is group\/world-writable/);
        expect(readFileSync(activePath, "utf8")).toBe(activeOriginal);
        expect(readFileSync(journalOnlyPath, "utf8")).toBe(journalOnlyOriginal);
        expect(existsSync(journal)).toBe(true);
      } finally {
        chmodSync(journalOnlyPath, 0o700);
      }
    },
  );

  test("rejects a manifest with no artifact for this platform", () => {
    expect(() =>
      selectUpdateArtifact(
        {
          manifestVersion: 2,
          runtimeVersion: NEW_VERSION,
          artifacts: [
            {
              platform: "darwin",
              arch: "arm64",
              nodeMajor: NODE_MAJOR,
              nodeModuleAbi: NODE_ABI,
              nodeApiVersion: process.versions.napi,
              url: "https://example.invalid/x.tar.gz",
              sha256: "a".repeat(64),
            },
          ],
        },
        { os: "linux", arch: "x64" },
        NODE_ABI,
      ),
    ).toThrow(/no runtime build for linux-x64/);
  });

  test("rejects non-https remote URLs", async () => {
    const artifact = makeSyntheticArtifact(work);
    const manifestPath = writeManifest(work, artifact, {
      artifacts: [
        {
          platform: "linux",
          arch: "x64",
          runtimeVersion: NEW_VERSION,
          nodeMajor: NODE_MAJOR,
          nodeModuleAbi: NODE_ABI,
          nodeApiVersion: process.versions.napi,
          ...LINUX_COMPATIBILITY,
          url: "http://example.invalid/runtime.tar.gz",
          sha256: artifact.sha,
          bytes: statSync(artifact.tarball).size,
          bins: { agenc: BIN_REL },
        },
      ],
    });
    const oldBin = join(agencHome, "runtime", OLD_VERSION, LINUX_ARTIFACT_KEY, BIN_REL);
    writeInstallShWrapper(binDir, agencHome, oldBin);
    const code = await runAgenCUpdateCli(
      {
        kind: "update",
        check: false,
        json: false,
        manifestUrl: `file://${manifestPath}`,
      },
      deps,
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain(
      "local runtime artifact URL must be an authority-free file URL",
    );
  });
});
