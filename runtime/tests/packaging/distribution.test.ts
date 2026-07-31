// Distribution artifacts (TODO task 4): pin the security-relevant invariants
// of the Docker/compose/Homebrew packaging so they cannot silently regress.
// The full `docker build` + run is one-off acceptance evidence (needs network
// + docker); these gates hold the properties that make the artifacts safe.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { describe, expect, test } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const DOCKER_DIR = join(REPO_ROOT, "packaging", "docker");
const RELEASE_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    version: string;
  }
).version;

describe("docker packaging", () => {
  test("Dockerfile: non-root user, pinned bases, canonical locked artifact", () => {
    const dockerfile = readFileSync(join(DOCKER_DIR, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain("ENV AGENC_HOME=/data/.agenc");
    expect(dockerfile).toContain('VOLUME ["/data"]');
    expect(dockerfile).toMatch(/FROM node:26\.5\.0-bookworm@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toMatch(/FROM node:26\.5\.0-bookworm-slim@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toContain("npm ci --no-audit --no-fund");
    expect(dockerfile).toContain("build:runtime-tarball");
    expect(dockerfile).toContain('AGENC_BUILD_COMMIT="${AGENC_BUILD_COMMIT}"');
    expect(dockerfile).toContain('SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH}"');
    expect(dockerfile).not.toContain("npm install --omit=dev");
    // The image must run the same layout every other install path uses.
    expect(dockerfile).toContain("node_modules/@tetsuo-ai/runtime/bin/agenc");
    // No credentials may be baked into the image.
    expect(dockerfile).not.toMatch(/API_KEY\s*=/);
  });

  test("compose: no published ports, named state volume, passthrough-only env", () => {
    const raw = readFileSync(join(DOCKER_DIR, "docker-compose.yml"), "utf8");
    const compose = loadYaml(raw) as {
      services: Record<
        string,
        { ports?: unknown; environment?: string[]; volumes?: string[] }
      >;
      volumes?: Record<string, unknown>;
    };
    const service = compose.services["agenc-daemon"];
    expect(service).toBeDefined();
    // Loopback-only by default: publishing the daemon port re-creates the
    // exposed-agent-gateway disaster class.
    expect(service.ports).toBeUndefined();
    expect(service.volumes).toContain("agenc-data:/data");
    expect(compose.volumes).toHaveProperty("agenc-data");
    for (const entry of service.environment ?? []) {
      // Bare names = host passthrough. `VAR=value` would hardcode a secret.
      expect(entry).not.toContain("=");
    }
  });

  test(".dockerignore excludes developer-local build outputs", () => {
    const ignore = readFileSync(join(REPO_ROOT, ".dockerignore"), "utf8");
    expect(ignore).toMatch(/^\*\*$/m);
    expect(ignore).toContain("node_modules");
    expect(ignore).toContain("**/dist");
    expect(ignore).not.toMatch(/^!\.git(?:\/|$)/m);
  });
});

describe("homebrew packaging", () => {
  test("formula template exists with unpublishable placeholders", () => {
    const formulaPath = join(
      REPO_ROOT,
      "packaging",
      "homebrew",
      "agenc.rb",
    );
    expect(existsSync(formulaPath)).toBe(true);
    const formula = readFileSync(formulaPath, "utf8");
    expect(formula).toContain(`  homepage "https://github.com/tetsuo-ai/agenc-core"
  url "https://github.com/tetsuo-ai/agenc-releases/releases/download/agenc-v${RELEASE_VERSION}/agenc-runtime-${RELEASE_VERSION}-darwin-#{Hardware::CPU.arm? ? "arm64" : "x64"}-node26-abi147.tar.gz"
  version "${RELEASE_VERSION}"
  arm64_sha256 = "REPLACE_WITH_DARWIN_ARM64_SHA256"
  x64_sha256 = "REPLACE_WITH_DARWIN_X64_SHA256"
  sha256 Hardware::CPU.arm? ? arm64_sha256 : x64_sha256
  license "MIT"`);
    expect(formula).toContain("class Agenc < Formula");
    expect(formula).not.toContain("disable!");
    expect(formula).not.toContain('depends_on "node"');
    expect(formula).toContain("depends_on macos: :ventura");
    expect(formula).not.toContain("depends_on :macos => :ventura");
    expect(formula).toContain('MacOS.full_version < "13.5"');
    expect(formula).toContain('depends_on "ripgrep"');
    expect(formula).toContain(
      'darwin-#{Hardware::CPU.arm? ? "arm64" : "x64"}-node26-abi147.tar.gz',
    );
    expect(formula).not.toContain("on_arm do");
    expect(formula).not.toContain("on_intel do");
    expect(formula).toContain(
      "sha256 Hardware::CPU.arm? ? arm64_sha256 : x64_sha256",
    );
    expect(formula).toContain('libexec/"node_modules/.agenc-node/bin/node"');
    expect(formula).toContain(
      'libexec/"node_modules/@tetsuo-ai/runtime/bin/agenc"',
    );
    const privatePath = 'export PATH="#{node_bin.dirname}:$PATH"';
    const privateNodeExec = 'exec "#{node_bin}" "#{runtime_bin}" "$@"';
    expect(formula).toContain(privatePath);
    expect(formula.indexOf(privatePath)).toBeLessThan(
      formula.indexOf(privateNodeExec),
    );
    // The service traverses the same wrapper, so daemon children receive the
    // artifact Node path before the runtime starts.
    expect(formula).toContain(
      'run [opt_bin/"agenc", "daemon", "start", "--foreground"]',
    );
    expect(formula).toContain("brew upgrade agenc");
    expect(formula).not.toContain("agenc-code");
    expect(formula).not.toContain('"install.sh"');
    expect(formula).not.toContain("curl ");
    // The template must stay obviously unpublishable until the owner fills
    // in a real release asset hash.
    expect(formula).toContain("REPLACE_WITH_DARWIN_ARM64_SHA256");
    expect(formula).toContain("REPLACE_WITH_DARWIN_X64_SHA256");
    expect(formula).toContain("OWNER-PUBLISH STEP");
    // Homebrew installs the immutable artifact directly and never performs
    // nested network installation during a formula build.
    expect(formula).not.toContain('libexec.install Dir["node_modules"]');
  });

  test("recreates node_modules from Homebrew's flattened archive root", () => {
    const formula = readFileSync(
      join(REPO_ROOT, "packaging", "homebrew", "agenc.rb"),
      "utf8",
    );
    const archiveBuilder = readFileSync(
      join(
        REPO_ROOT,
        "packages",
        "agenc",
        "scripts",
        "build-runtime-tarball.mjs",
      ),
      "utf8",
    );

    // Runtime archives have one node_modules root. Homebrew enters that sole
    // directory before install, so the build path contains its children rather
    // than another nested node_modules directory. Pathname#children preserves
    // dot-prefixed runtime entries such as .agenc-node and .bin.
    expect(archiveBuilder).toContain(
      'canonicalArchiveEntries(installRoot, "node_modules")',
    );
    expect(formula).toContain(
      '(libexec/"node_modules").install buildpath.children',
    );
    expect(formula).not.toContain('libexec.install "node_modules"');
    expect(formula).not.toContain('Dir["*"]');
    expect(formula).toContain('node_modules/.agenc-node/bin/node');
    expect(formula).toContain('node_modules/@tetsuo-ai/runtime/bin/agenc');
  });
});
