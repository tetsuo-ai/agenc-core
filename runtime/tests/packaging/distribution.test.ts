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

describe("docker packaging", () => {
  test("Dockerfile: non-root user, pinned bases, canonical locked artifact", () => {
    const dockerfile = readFileSync(join(DOCKER_DIR, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain("ENV AGENC_HOME=/data/.agenc");
    expect(dockerfile).toContain('VOLUME ["/data"]');
    expect(dockerfile).toMatch(/FROM node:25\.9\.0-bookworm@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toMatch(/FROM node:25\.9\.0-bookworm-slim@sha256:[0-9a-f]{64}/);
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
    expect(formula).toContain("class Agenc < Formula");
    expect(formula).toContain("disable!");
    expect(formula).toContain("requires unavailable Node 25.9.0");
    expect(formula).not.toMatch(/depends_on "node(?:@\d+)?"/);
    // The template must stay obviously unpublishable until the owner fills
    // in a real release asset hash.
    expect(formula).toContain("REPLACE_WITH_RELEASE_ASSET_SHA256");
    expect(formula).toContain("OWNER-PUBLISH STEP");
    // It rides the shared installer contract rather than a parallel one.
    expect(formula).toContain("install.sh");
  });
});
