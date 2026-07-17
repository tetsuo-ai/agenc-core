// Tier-3 hermetic docker test for the phase-2b egress lane. Requires docker
// and a staged agent overlay (AGENC_EVAL_AGENT_OVERLAY: node/ + runtime/ +
// mock/). NO internet: the topological boundary (--internal net, blackholed
// resolver) plus the real allowlist proxy make every containment probe pass
// or fail purely from the local setup — the proxy denies github / IP-literal
// / mismatched-SNI BEFORE dialing any upstream, so no fake internet is needed.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DockerContainerRunner } from "../../src/eval-executor/index.js";

const OVERLAY = process.env.AGENC_EVAL_AGENT_OVERLAY;
const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 180_000;
const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts");

describe.skipIf(!OVERLAY)("eval executor egress lane (tier 3, docker, no internet)", () => {
  let imageId: string;
  let buildContext: string;

  beforeAll(async () => {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
    // Stage the proxy + probe scripts into the overlay (idempotent).
    await mkdir(path.join(OVERLAY!, "proxy"), { recursive: true });
    await copyFile(
      path.join(scriptsDir, "eval-allowlist-proxy.mjs"),
      path.join(OVERLAY!, "proxy", "allowlist-proxy.mjs"),
    );
    await copyFile(
      path.join(scriptsDir, "eval-egress-probe.mjs"),
      path.join(OVERLAY!, "proxy", "eval-egress-probe.mjs"),
    );
    // A glibc task image with bash and the shared libs the overlay's node
    // needs (libatomic etc.). A node base image is the simplest guarantee;
    // real pilot images are fuller still.
    const base = process.env.AGENC_EVAL_E2E_BASE_IMAGE ?? "node:25.9.0-bookworm-slim";
    buildContext = await mkdtemp(path.join(tmpdir(), "agenc-egress-img-"));
    await writeFile(path.join(buildContext, "Dockerfile"), `FROM ${base}\nWORKDIR /testbed\n`);
    imageId = execFileSync("docker", ["build", "-q", buildContext], { encoding: "utf8" }).trim();
    expect(imageId).toMatch(/^sha256:[0-9a-f]{64}$/u);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (imageId) execFileSync("docker", ["rmi", "-f", imageId], { encoding: "utf8" });
    if (buildContext) await rm(buildContext, { recursive: true, force: true });
  }, HOOK_TIMEOUT_MS);

  test("every containment probe passes in a correctly built lane", async () => {
    const runner = new DockerContainerRunner({ allowLocalImageId: true });
    const lane = await runner.createEgressLane({
      runId: "tier3a",
      subnetOctet: 91,
      taskImage: imageId,
      overlayHostDir: path.resolve(OVERLAY!),
      allowHost: "provider.test",
      allowPort: 443,
      pinIps: ["10.88.91.3"], // never actually dialed by the probes
      proxyListenPort: 8080,
    });
    try {
      const probes = await lane.runContainmentProbes();
      expect(probes).toEqual({
        noRouteOffNet: true,
        githubBlocked: true,
        dnsBlackholed: true,
        ipv6Absent: true,
        ipLiteralRejected: true,
        sniPinned: true,
      });
    } finally {
      await lane.teardown();
    }
  }, TEST_TIMEOUT_MS);

  test("REVERT-SENSITIVE: allowing github flips githubBlocked to false", async () => {
    // If the allowlist is what blocks github, an allowHost of github.com makes
    // the CONNECT succeed (200) instead of 403 — proving the deny is real.
    const runner = new DockerContainerRunner({ allowLocalImageId: true });
    const lane = await runner.createEgressLane({
      runId: "tier3b",
      subnetOctet: 92,
      taskImage: imageId,
      overlayHostDir: path.resolve(OVERLAY!),
      allowHost: "github.com",
      allowPort: 443,
      pinIps: ["10.88.92.3"],
      proxyListenPort: 8080,
    });
    try {
      const probes = await lane.runContainmentProbes();
      expect(probes.githubBlocked).toBe(false);
      // The topological boundary still holds regardless of the allowlist.
      expect(probes.noRouteOffNet).toBe(true);
      expect(probes.dnsBlackholed).toBe(true);
    } finally {
      await lane.teardown();
    }
  }, TEST_TIMEOUT_MS);
});
