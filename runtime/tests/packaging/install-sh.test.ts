// End-to-end tests for scripts/install/install.sh (TODO task 1).
//
// The installer must speak the exact runtime-manager install contract
// (runtime/<version>/ tree + .agenc-runtime-ok marker recording the sha256)
// so the npm launcher and the shell installer can reuse each other's
// installs. Everything runs against a synthetic tarball + file:// manifest,
// mirroring packages/agenc/test/runtime-manager.test.mjs.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const INSTALL_SH = join(REPO_ROOT, "scripts", "install", "install.sh");
const INSTALL_PS1 = join(REPO_ROOT, "scripts", "install", "install.ps1");

const VERSION = "9.9.9-test";
const BIN_REL = "node_modules/@tetsuo-ai/runtime/bin/agenc";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// Synthetic runtime tarball with the real extraction layout; the bin is a
// node script so the generated wrapper can actually be executed.
function makeSyntheticArtifact(dir: string): { tarball: string; sha: string } {
  const tree = join(dir, "tree");
  const binDir = join(tree, "node_modules", "@tetsuo-ai", "runtime", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "agenc"),
    'console.log("ok " + process.argv.slice(2).join(" "));\n',
  );
  const tarball = join(dir, `agenc-runtime-${VERSION}-test.tar.gz`);
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
    manifestVersion: 1,
    runtimeVersion: VERSION,
    releaseRepository: "tetsuo-ai/agenc-core",
    releaseTag: `agenc-v${VERSION}`,
    artifacts: [
      {
        platform: "linux",
        arch: "x64",
        runtimeVersion: VERSION,
        url: `file://${artifact.tarball}`,
        sha256: artifact.sha,
        bytes: statSync(artifact.tarball).size,
        bins: { agenc: BIN_REL },
        ...overrides,
      },
    ],
  };
  const file = join(dir, "manifest.json");
  writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}

type RunResult = { status: number; stdout: string; stderr: string };

function runInstaller(opts: {
  home: string;
  args?: string[];
  manifest: string;
  pathPrepend?: string[];
}): RunResult {
  const env = {
    HOME: opts.home,
    AGENC_HOME: join(opts.home, ".agenc"),
    TMPDIR: join(opts.home, "tmp"),
    PATH: [...(opts.pathPrepend ?? []), process.env.PATH ?? ""].join(":"),
    // Deterministic platform selection regardless of the host machine.
    AGENC_INSTALL_PLATFORM: "linux",
    AGENC_INSTALL_ARCH: "x64",
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  const res = spawnSync(
    "sh",
    [
      INSTALL_SH,
      "--manifest-url",
      `file://${opts.manifest}`,
      "--prefix",
      join(opts.home, ".local"),
      ...(opts.args ?? []),
    ],
    { env, encoding: "utf8" },
  );
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describe.skipIf(process.platform === "win32")("install.sh", () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "agenc-install-test-"));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  function paths(home: string) {
    const installDir = join(home, ".agenc", "runtime", VERSION);
    return {
      installDir,
      marker: join(installDir, ".agenc-runtime-ok"),
      wrapper: join(home, ".local", "bin", "agenc"),
    };
  }

  test("fresh install: downloads, verifies, extracts, writes marker + working wrapper", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);

    const res = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(res.stderr).toContain("checksum verified");
    expect(res.status).toBe(0);

    const { marker, wrapper } = paths(home);
    expect(readFileSync(marker, "utf8")).toBe(artifact.sha);
    expect(statSync(wrapper).mode & 0o111).not.toBe(0);
    // The wrapper actually launches the installed runtime bin.
    const out = execFileSync(wrapper, ["--version"], { encoding: "utf8" });
    expect(out).toContain("ok --version");
  });

  test("checksum mismatch: aborts nonzero, installs nothing", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact, {
      sha256: "0".repeat(64),
    });

    const res = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("checksum mismatch");

    const { installDir, wrapper } = paths(home);
    expect(existsSync(installDir)).toBe(false);
    expect(existsSync(wrapper)).toBe(false);
  });

  test("idempotent: verified marker short-circuits the download entirely", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);

    const first = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(first.status).toBe(0);

    // Remove the artifact: a second run can only succeed via the marker path.
    rmSync(artifact.tarball);
    const second = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(second.status).toBe(0);
    expect(second.stderr).toContain("already installed");
  });

  test("daemon: writes a systemd user unit pointing at the wrapper and enables it", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);

    // Stub systemctl that records its argv lines.
    const stubDir = join(work, "stub-bin");
    mkdirSync(stubDir, { recursive: true });
    const callLog = join(work, "systemctl-calls.log");
    writeFileSync(
      join(stubDir, "systemctl"),
      `#!/bin/sh\necho "$@" >> "${callLog}"\nexit 0\n`,
    );
    chmodSync(join(stubDir, "systemctl"), 0o755);

    const res = runInstaller({ home, manifest, pathPrepend: [stubDir] });
    expect(res.status).toBe(0);

    const unit = readFileSync(
      join(home, ".config", "systemd", "user", "agenc-daemon.service"),
      "utf8",
    );
    const { wrapper } = paths(home);
    expect(unit).toContain(`ExecStart=${wrapper} daemon start --foreground`);
    expect(unit).toContain("WantedBy=default.target");

    const calls = readFileSync(callLog, "utf8");
    expect(calls).toContain("--user daemon-reload");
    expect(calls).toContain("--user enable --now agenc-daemon.service");
  });

  test("--no-daemon skips service installation", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);

    const res = runInstaller({ home, manifest, args: ["--no-daemon"] });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("daemon installation skipped");
    expect(
      existsSync(join(home, ".config", "systemd", "user", "agenc-daemon.service")),
    ).toBe(false);
  });

  test("unsupported platform: clear error listing available builds", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);

    const env = {
      HOME: home,
      AGENC_HOME: join(home, ".agenc"),
      PATH: process.env.PATH ?? "",
      AGENC_INSTALL_PLATFORM: "linux",
      AGENC_INSTALL_ARCH: "riscv64",
    };
    const res = spawnSync(
      "sh",
      [INSTALL_SH, "--manifest-url", `file://${manifest}`, "--no-daemon"],
      { env, encoding: "utf8" },
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("no runtime build for linux-riscv64");
    expect(res.stderr).toContain("linux-x64");
  });

  test("node version gate: refuses Node older than 25", () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const artifact = makeSyntheticArtifact(work);
    const manifest = writeManifest(work, artifact);

    // Stub node reporting major version 20 for any invocation.
    const stubDir = join(work, "stub-bin");
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, "node"), '#!/bin/sh\nprintf "20"\n');
    chmodSync(join(stubDir, "node"), 0o755);

    const res = runInstaller({
      home,
      manifest,
      args: ["--no-daemon"],
      pathPrepend: [stubDir],
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("Node.js >= 25 required");
  });

  test("install.ps1 parses under pwsh (skipped when pwsh is absent)", () => {
    const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
      encoding: "utf8",
    });
    if (pwsh.status !== 0) return; // pwsh not available on this machine
    const res = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        `$null = [scriptblock]::Create((Get-Content -Raw '${INSTALL_PS1}')); 'parsed'`,
      ],
      { encoding: "utf8" },
    );
    expect(res.stdout).toContain("parsed");
    expect(res.status).toBe(0);
  });
});
