// Tests for `agenc update` (runtime/src/bin/update-cli.ts).
//
// The updater must speak the exact install contract shared by
// scripts/install/install.sh and the npm launcher's runtime-manager:
// runtime/<version>/ tree + .agenc-runtime-ok marker recording the tarball
// sha256, and it must only ever rewrite wrappers carrying the install.sh
// generation signature. Everything runs against a synthetic tarball and a
// file:// manifest, mirroring install-sh.test.ts.

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
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  findInstallShWrappers,
  formatAgenCUpdateCliHelpText,
  parseAgenCUpdateCliArgs,
  parseInstallShWrapper,
  renderInstallShWrapper,
  resolveUpdateManifestUrl,
  runAgenCUpdateCli,
  selectUpdateArtifact,
} from "../../src/bin/update-cli.js";

const NEW_VERSION = "9.9.9-test";
const OLD_VERSION = "9.9.8-test";
const BIN_REL = "node_modules/@tetsuo-ai/runtime/bin/agenc";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function makeSyntheticArtifact(dir: string): { tarball: string; sha: string } {
  const tree = join(dir, "tree");
  const binDir = join(tree, "node_modules", "@tetsuo-ai", "runtime", "bin");
  mkdirSync(binDir, { recursive: true });
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
    manifestVersion: 1,
    runtimeVersion: NEW_VERSION,
    releaseRepository: "tetsuo-ai/agenc-releases",
    releaseTag: `agenc-v${NEW_VERSION}`,
    artifacts: [
      {
        platform: "linux",
        arch: "x64",
        runtimeVersion: NEW_VERSION,
        url: `file://${artifact.tarball}`,
        sha256: artifact.sha,
        bins: { agenc: BIN_REL },
      },
    ],
    ...overrides,
  };
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

// A wrapper exactly as install.sh generates it, pointing at the OLD runtime.
function writeInstallShWrapper(
  binDir: string,
  agencHome: string,
  runtimeBin: string,
): string {
  mkdirSync(binDir, { recursive: true });
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
    out = [];
    err = [];
    deps = {
      env: { AGENC_HOME: agencHome, PATH: binDir, HOME: work },
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      currentVersion: OLD_VERSION,
      platform: "linux",
      arch: "x64",
      userHome: work,
    };
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
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
      "https://github.com/tetsuo-ai/agenc-releases/releases/download/agenc-v1.2.3/agenc-runtime-manifest.json",
    );
    expect(resolveUpdateManifestUrl({ env: {} })).toBe(
      "https://github.com/tetsuo-ai/agenc-releases/releases/latest/download/agenc-runtime-manifest.json",
    );
    expect(
      resolveUpdateManifestUrl({ env: { AGENC_INSTALL_REPO: "o/r" } }),
    ).toBe(
      "https://github.com/o/r/releases/latest/download/agenc-runtime-manifest.json",
    );
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
    const oldBin = join(agencHome, "runtime", OLD_VERSION, BIN_REL);
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

    // Marker contract: runtime/<version>/ tree + sha256-recording marker.
    const installDir = join(agencHome, "runtime", NEW_VERSION);
    const newBin = join(installDir, BIN_REL);
    expect(existsSync(newBin)).toBe(true);
    expect(readFileSync(join(installDir, ".agenc-runtime-ok"), "utf8")).toBe(
      artifact.sha,
    );

    // Wrapper repointed, signature + node path + AGENC_HOME preserved, still 0755.
    const rewritten = readFileSync(wrapper, "utf8");
    expect(rewritten).toContain("Generated by AgenC install.sh");
    expect(rewritten).toContain(`exec "${process.execPath}" "${newBin}" "$@"`);
    expect(rewritten).toContain(`AGENC_HOME:-${agencHome}`);
    expect(statSync(wrapper).mode & 0o777).toBe(0o755);

    // The repointed wrapper actually launches the new runtime bin.
    const run = spawnSync(wrapper, ["hello"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("ok hello");
  });

  test("checksum mismatch aborts: no marker, wrapper untouched", async () => {
    const artifact = makeSyntheticArtifact(work);
    const badSha = "0".repeat(64);
    const manifestPath = writeManifest(work, {
      tarball: artifact.tarball,
      sha: badSha,
    });
    const oldBin = join(agencHome, "runtime", OLD_VERSION, BIN_REL);
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
      existsSync(join(agencHome, "runtime", NEW_VERSION, ".agenc-runtime-ok")),
    ).toBe(false);
    expect(readFileSync(wrapper, "utf8")).toBe(before);
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
    const oldBin = join(agencHome, "runtime", OLD_VERSION, BIN_REL);
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
    const oldBin = join(agencHome, "runtime", OLD_VERSION, BIN_REL);
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

  test("rejects a manifest with no artifact for this platform", () => {
    expect(() =>
      selectUpdateArtifact(
        {
          runtimeVersion: NEW_VERSION,
          artifacts: [
            {
              platform: "darwin",
              arch: "arm64",
              url: "https://example.invalid/x.tar.gz",
              sha256: "a".repeat(64),
            },
          ],
        },
        { os: "linux", arch: "x64" },
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
          url: "http://example.invalid/runtime.tar.gz",
          sha256: artifact.sha,
          bins: { agenc: BIN_REL },
        },
      ],
    });
    const oldBin = join(agencHome, "runtime", OLD_VERSION, BIN_REL);
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
    expect(err.join("\n")).toContain("refusing non-https");
  });
});
