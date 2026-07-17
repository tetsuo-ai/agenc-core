import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  allContainmentProbesPass,
  buildAgentEgressCreateArgs,
  buildEgressNetworkPlan,
  buildRealProviderAgentScript,
  buildSidecarCreateArgs,
  computeOracleContainment,
  DockerContainerRunner,
  EGRESS_PROBE_SENTINEL,
  parseEgressProbeReport,
  redactSecret,
  runRealProviderAgentOnTask,
  scanPatchForSecret,
  SIDECAR_SECURITY_ARGS,
  stringContainsSecret,
  type AgentRunInputs,
  type ContainerEnvironment,
  type ContainerExecRequest,
  type ContainerExecResult,
  type ContainerHandle,
  type ContainerRunner,
  type EgressContainmentProbes,
  type EgressLane,
  type EgressLaneRequest,
  type PilotSourceLockTask,
  type RealProviderAgentConfig,
  type VerifierBundle,
} from "../../src/eval-executor/index.js";

const ALL_TRUE: EgressContainmentProbes = {
  noRouteOffNet: true, githubBlocked: true, dnsBlackholed: true,
  ipv6Absent: true, ipLiteralRejected: true, sniPinned: true,
};
const ALL_FALSE: EgressContainmentProbes = {
  noRouteOffNet: false, githubBlocked: false, dnsBlackholed: false,
  ipv6Absent: false, ipLiteralRejected: false, sniPinned: false,
};

describe("egress pure builders", () => {
  test("network plan pins the subnet and proxy IP; rejects bad inputs", () => {
    const plan = buildEgressNetworkPlan("run123", 7);
    expect(plan.egressNetName).toBe("agenc-eval-egress-run123");
    expect(plan.upstreamNetName).toBe("agenc-eval-upstream-run123");
    expect(plan.proxyIp).toBe("10.88.7.2");
    expect(plan.egressCreateArgs).toEqual([
      "network", "create", "--internal", "--subnet", "10.88.7.0/29", "agenc-eval-egress-run123",
    ]);
    expect(() => buildEgressNetworkPlan("BAD RUN", 7)).toThrow();
    expect(() => buildEgressNetworkPlan("run", 0)).toThrow();
    expect(() => buildEgressNetworkPlan("run", 255)).toThrow();
  });

  test("sidecar args carry the hardening flags + proxy config, never a secret", () => {
    const args = buildSidecarCreateArgs({
      name: "agenc-eval-proxy-x", dockerImageRef: "img@sha256:abc", overlayHostDir: "/ov",
      egressNetName: "net", proxyIp: "10.88.7.2", listenPort: 8080,
      allowHost: "api.x.ai", allowPort: 443, pinIps: ["1.2.3.4", "5.6.7.8"], runAsUser: "1000:1000",
    });
    for (const flag of SIDECAR_SECURITY_ARGS) expect(args).toContain(flag);
    expect(args).not.toContain("--internal"); // --internal is on the network, not the container
    expect(args.join(" ")).toContain("--network net");
    expect(args.join(" ")).toContain("--ip 10.88.7.2");
    expect(args.join(" ")).toContain("--user 1000:1000");
    expect(args).toContain("--cap-drop"); // hardening retained
    expect(args).toContain("AGENC_PROXY_ALLOW_HOST=api.x.ai");
    expect(args).toContain("AGENC_PROXY_PIN_IPS=1.2.3.4,5.6.7.8");
    expect(args).toContain("/ov:/agenc-overlay:ro");
    // No provider key anywhere near the sidecar.
    expect(args.join(" ")).not.toContain("API_KEY");
  });

  test("agent egress args use the internal net + blackholed resolver, not --network none", () => {
    const args = buildAgentEgressCreateArgs({
      dockerImageRef: "img@sha256:abc", overlayHostDir: "/ov", egressNetName: "net", dns: "127.0.0.1",
    });
    expect(args.join(" ")).toContain("--network net");
    expect(args.join(" ")).toContain("--dns 127.0.0.1");
    expect(args.join(" ")).not.toContain("--network none");
    expect(args).toContain("--entrypoint");
    expect(args).toContain("sleep");
    expect(args.at(-1)).toBe("infinity");
  });
});

describe("egress probe parsing + containment", () => {
  test("parses a full sentinel line; missing/invalid fields fail closed", () => {
    expect(parseEgressProbeReport(`noise\n${EGRESS_PROBE_SENTINEL}${JSON.stringify(ALL_TRUE)}\n`))
      .toEqual(ALL_TRUE);
    expect(parseEgressProbeReport(`${EGRESS_PROBE_SENTINEL}{"noRouteOffNet":true}`))
      .toMatchObject({ noRouteOffNet: true, githubBlocked: false });
    expect(parseEgressProbeReport("no sentinel here")).toEqual(ALL_FALSE);
    expect(parseEgressProbeReport(`${EGRESS_PROBE_SENTINEL}{not json`)).toEqual(ALL_FALSE);
    // A non-boolean must not count as pass.
    expect(parseEgressProbeReport(`${EGRESS_PROBE_SENTINEL}{"githubBlocked":"true"}`).githubBlocked)
      .toBe(false);
  });

  test("containment requires every probe AND a clean key scan", () => {
    expect(allContainmentProbesPass(ALL_TRUE)).toBe(true);
    expect(allContainmentProbesPass({ ...ALL_TRUE, sniPinned: false })).toBe(false);
    expect(computeOracleContainment(ALL_TRUE, "clean")).toBe("contained");
    expect(computeOracleContainment(ALL_TRUE, "key-substring-found")).toBe("unverified");
    expect(computeOracleContainment(ALL_TRUE, "not-run")).toBe("unverified");
    expect(computeOracleContainment({ ...ALL_TRUE, ipv6Absent: false }, "clean")).toBe("unverified");
  });

  test("key scan finds a long secret and ignores short strings", () => {
    const secret = "sk-supersecret-abcdefghijklmnop";
    expect(scanPatchForSecret(new TextEncoder().encode(`diff\n+${secret}\n`), secret)).toBe(true);
    expect(scanPatchForSecret(new TextEncoder().encode("diff clean"), secret)).toBe(false);
    expect(scanPatchForSecret(new TextEncoder().encode("aaa"), "short")).toBe(false);
  });

  test("string scan + redaction cover agent text artifacts", () => {
    const secret = "sk-live-abcdefghijklmnopqrstuv";
    expect(stringContainsSecret(`the key is ${secret} oops`, secret)).toBe(true);
    expect(stringContainsSecret("clean output", secret)).toBe(false);
    expect(redactSecret(`a ${secret} b ${secret} c`, secret)).toBe(
      "a [REDACTED-PROVIDER-KEY] b [REDACTED-PROVIDER-KEY] c",
    );
    // Short secrets are never scanned or redacted (avoids false positives).
    expect(stringContainsSecret("abc", "abc")).toBe(false);
    expect(redactSecret("abc", "abc")).toBe("abc");
  });
});

describe("real-provider agent script", () => {
  test("routes through the proxy and never assigns the key", () => {
    const script = buildRealProviderAgentScript({
      proxyIp: "10.88.7.2", proxyListenPort: 8080, model: "grok-4.5", baseUrl: "https://api.x.ai/v1",
    });
    expect(script).toContain("HTTPS_PROXY=http://10.88.7.2:8080");
    expect(script).toContain("AGENC_PROXY_RESOLVES_HOSTS=1");
    expect(script).toContain("AGENC_MODEL=grok-4.5");
    expect(script).toContain('OPENAI_COMPATIBLE_BASE_URL="https://api.x.ai/v1"');
    // The key is delivered via docker exec -e, never assigned in the script.
    expect(script).not.toContain("OPENAI_COMPATIBLE_API_KEY=");
    // No mock provider in the real lane.
    expect(script).not.toContain("mock/serve.mjs");
    // The daemon proxy preload is installed so headless model calls route
    // through the egress proxy.
    expect(script).toContain('NODE_OPTIONS="--require /agenc-overlay/proxy/eval-proxy-preload.cjs"');
  });
});

const digestOf = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}`;
const IMAGE = `reg/task@sha256:${"a".repeat(64)}`;

function makeTask(): PilotSourceLockTask {
  return {
    ordinal: 1, language: "js", instanceId: "Fake__egress-1", categories: [], stressors: [],
    sourceRowDigest: digestOf("b"), repository: "f/t", pullNumber: "1", issueNumbers: ["2"],
    baseCommit: "c".repeat(40), createdAt: "2026-07-01T00:00:00Z", commitUrl: "https://x.invalid",
    issueText: "fix it", image: IMAGE,
    artifacts: {
      setupPatch: { digest: digestOf("d"), sizeBytes: 0, mediaType: "text/x-diff", uri: `cas://sha256/${"d".repeat(64)}` },
      referencePatch: { digest: digestOf("e"), sizeBytes: 1, mediaType: "text/x-diff", uri: `cas://sha256/${"e".repeat(64)}` },
      verifierBundle: { digest: digestOf("f"), sizeBytes: 1, mediaType: "application/x", uri: `cas://sha256/${"f".repeat(64)}` },
      sourceEvidence: { digest: digestOf("0"), sizeBytes: 1, mediaType: "application/x", uri: `cas://sha256/${"0".repeat(64)}` },
    },
  };
}

const BUNDLE: VerifierBundle = {
  kind: "agenc.eval.swe-bench-live-verifier-bundle", version: "1.0.0", instanceId: "Fake__egress-1",
  testPatch: "", rebuildCommands: ["make"], testCommands: ["make test"], printCommands: ["cat log"],
  logParser: "def parser(log):\n  return {}\n", failToPass: ["t"], passToPass: ["r"],
};

const OK: ContainerExecResult = {
  exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1,
};

const AGENT_RESULT = JSON.stringify({ type: "result", sessionId: "session_x", tokenUsage: { totalTokens: 9 } });

class FakeRunner implements ContainerRunner {
  readonly execs: ContainerExecRequest[] = [];
  constructor(
    private readonly patchDiff: string,
    private readonly agentExit = 0,
    private readonly resultJson = AGENT_RESULT,
  ) {}
  async environment(): Promise<ContainerEnvironment> {
    return { engine: "docker", serverVersion: "0", platform: "linux", arch: "x64" };
  }
  async createTaskContainer(): Promise<ContainerHandle> {
    throw new Error("verification container must not be created in these gating tests");
  }
  async createAuxiliaryContainer(): Promise<ContainerHandle> {
    return { id: "aux", imageDigest: "x", workdir: "/" };
  }
  async exec(_handle: ContainerHandle, request: ContainerExecRequest): Promise<ContainerExecResult> {
    this.execs.push(request);
    if (request.script.startsWith("cat /agenc-eval/agent-result.json")) {
      return { ...OK, stdout: this.resultJson };
    }
    if (request.script.includes("diff agenc-eval-baseline HEAD")) {
      return { ...OK, stdout: Buffer.from(this.patchDiff, "latin1").toString("base64") };
    }
    if (request.script.startsWith("tail -c 2000")) return { ...OK, stdout: "stderr" };
    if (request.script.includes("HTTPS_PROXY") && request.script.includes("agenc.js")) {
      return { ...OK, exitCode: this.agentExit };
    }
    return OK;
  }
  async writeFile(): Promise<void> {}
  async copyFile(): Promise<void> {}
  async remove(): Promise<void> {}
}

describe("real-provider lane gating (fake lane, no docker)", () => {
  let overlayDir: string;
  const KEY_VAR = "AGENC_TEST_PROVIDER_KEY";
  const SECRET = "sk-live-supersecret-1234567890abcdef";

  beforeEach(async () => {
    overlayDir = await mkdtemp(path.join(tmpdir(), "agenc-egress-overlay-"));
    await mkdir(path.join(overlayDir, "node", "bin"), { recursive: true });
    await writeFile(path.join(overlayDir, "node", "bin", "node"), "");
    const bin = path.join(overlayDir, "runtime", "node_modules", "@tetsuo-ai", "runtime", "dist", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "agenc.js"), "");
    await mkdir(path.join(overlayDir, "mock"), { recursive: true });
    await writeFile(path.join(overlayDir, "mock", "serve.mjs"), "");
    await mkdir(path.join(overlayDir, "proxy"), { recursive: true });
    for (const f of ["allowlist-proxy.mjs", "eval-egress-probe.mjs", "eval-proxy-preload.cjs"]) {
      await writeFile(path.join(overlayDir, "proxy", f), "");
    }
    process.env[KEY_VAR] = SECRET;
  });

  afterEach(async () => {
    delete process.env[KEY_VAR];
    await rm(overlayDir, { recursive: true, force: true });
  });

  function config(): RealProviderAgentConfig {
    return {
      overlay: { hostDir: overlayDir }, allowHost: "api.x.ai", allowPort: 443,
      pinIps: ["1.2.3.4"], model: "grok-4.5", baseUrl: "https://api.x.ai/v1",
      keyEnvVar: KEY_VAR, runId: "abc123", subnetOctet: 9,
    };
  }

  const inputs = (): AgentRunInputs => ({ task: makeTask(), bundle: BUNDLE, setupPatch: new Uint8Array(0) });

  function laneFactory(probes: EgressContainmentProbes, runner: FakeRunner): {
    factory: (r: EgressLaneRequest) => Promise<EgressLane>;
    state: { probed: boolean; tornDown: boolean };
  } {
    const state = { probed: false, tornDown: false };
    const handle: ContainerHandle = { id: "agent", imageDigest: "x", workdir: "/testbed" };
    const factory = async (): Promise<EgressLane> => ({
      agentHandle: handle,
      proxyIp: "10.88.9.2",
      proxyListenPort: 8080,
      async runContainmentProbes() { state.probed = true; return probes; },
      async teardown() { state.tornDown = true; },
    });
    void runner;
    return { factory, state };
  }

  test("failing probes leave the run unverified and never start the agent", async () => {
    const runner = new FakeRunner("");
    const { factory, state } = laneFactory({ ...ALL_TRUE, sniPinned: false }, runner);
    const { report } = await runRealProviderAgentOnTask(runner, factory, inputs(), config());
    expect(report.outcome).toBe("oracle_containment_unverified");
    expect(report.egress?.oracleContainment).toBe("unverified");
    expect(report.egress?.patchKeyScan).toBe("not-run");
    expect(state.tornDown).toBe(true);
    // The agent script (HTTPS_PROXY + agenc.js) must never have run.
    expect(runner.execs.some((e) => e.script.includes("HTTPS_PROXY"))).toBe(false);
  });

  test("passing probes + empty patch is contained; key delivered via envPassthrough, never in argv", async () => {
    const runner = new FakeRunner(""); // empty patch
    const { factory } = laneFactory(ALL_TRUE, runner);
    const { report } = await runRealProviderAgentOnTask(runner, factory, inputs(), config());
    expect(report.outcome).toBe("empty_patch");
    expect(report.egress?.oracleContainment).toBe("contained");
    expect(report.egress?.patchKeyScan).toBe("clean");
    const agentExec = runner.execs.find((e) => e.script.includes("HTTPS_PROXY"));
    expect(agentExec).toBeDefined();
    expect(agentExec!.envPassthrough).toEqual([KEY_VAR]);
    // The secret value is on no argv (not in the script string).
    expect(agentExec!.script).not.toContain(SECRET);
  });

  test("a patch containing the provider key is quarantined, never verified", async () => {
    const runner = new FakeRunner(`diff --git a/x b/x\n+leaked ${SECRET}\n`);
    const { factory } = laneFactory(ALL_TRUE, runner);
    const { report, patchBytes } = await runRealProviderAgentOnTask(runner, factory, inputs(), config());
    expect(report.egress?.patchKeyScan).toBe("key-substring-found");
    expect(report.outcome).toBe("infrastructure_error");
    expect(report.egress?.oracleContainment).toBe("unverified");
    expect(patchBytes).toBeNull(); // never returned/persisted, never verified
  });

  test("a key leaked into the agent's stdout is quarantined and redacted", async () => {
    const leakyResult = JSON.stringify({ type: "result", sessionId: "s", finalMessage: `here: ${SECRET}` });
    const runner = new FakeRunner("", 0, leakyResult);
    const { factory } = laneFactory(ALL_TRUE, runner);
    const { report, rawAgentResult } = await runRealProviderAgentOnTask(runner, factory, inputs(), config());
    expect(report.egress?.patchKeyScan).toBe("key-substring-found");
    expect(report.outcome).toBe("infrastructure_error");
    // The persisted/returned artifact must not contain the raw key.
    expect(rawAgentResult).not.toContain(SECRET);
    expect(rawAgentResult).toContain("[REDACTED-PROVIDER-KEY]");
  });

  test("a missing key env var aborts before any container work", async () => {
    delete process.env[KEY_VAR];
    const runner = new FakeRunner("");
    const { factory } = laneFactory(ALL_TRUE, runner);
    await expect(runRealProviderAgentOnTask(runner, factory, inputs(), config()))
      .rejects.toThrow(new RegExp(KEY_VAR));
  });

  test("a too-short key and an invalid model are rejected up front", async () => {
    process.env[KEY_VAR] = "short";
    const runner = new FakeRunner("");
    const { factory } = laneFactory(ALL_TRUE, runner);
    await expect(runRealProviderAgentOnTask(runner, factory, inputs(), config()))
      .rejects.toThrow(/too short/u);
    process.env[KEY_VAR] = SECRET;
    await expect(
      runRealProviderAgentOnTask(runner, factory, inputs(), { ...config(), model: "grok; rm -rf /" }),
    ).rejects.toThrow(/invalid provider model/u);
  });
});

describe("docker exec env passthrough validation", () => {
  test("rejects a passthrough name that could smuggle a value", async () => {
    const runner = new DockerContainerRunner();
    const handle: ContainerHandle = { id: "x", imageDigest: "x", workdir: "/" };
    await expect(
      runner.exec(handle, { script: "true", timeoutMs: 1_000, envPassthrough: ["BAD=evil"] }),
    ).rejects.toThrow(/invalid env passthrough/u);
  });
});
