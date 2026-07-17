import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { digestCanonicalJson, sha256Digest, type Sha256Digest } from "../eval-contract/index.js";
import {
  verifyCandidatePatch,
  DEFAULT_PREFLIGHT_TIMEOUTS,
  type PreflightExecutionOptions,
  type PreflightTimeouts,
} from "./preflight.js";
import {
  allContainmentProbesPass,
  computeOracleContainment,
  DEFAULT_PROXY_LISTEN_PORT,
  redactSecret,
  scanPatchForSecret,
  stringContainsSecret,
  type EgressLaneFactory,
} from "./egress.js";
import { EvalExecutorError } from "./source-lock.js";
import type {
  AgentRunOutcome,
  AgentRunReport,
  ContainerExecResult,
  ContainerHandle,
  ContainerRunner,
  EgressContainmentProbes,
  EgressReport,
  PilotSourceLockTask,
  PreflightPhaseTranscript,
  VerifierBundle,
} from "./types.js";
import {
  AGENT_HELPER_DIR,
  AGENT_HOME,
  AGENT_RUNTIME_ENTRY,
  OVERLAY_AGENT_ENTRY_SUBPATH,
  OVERLAY_CONTAINER_PATH,
  OVERLAY_NODE_COMPAT_LIB,
  OVERLAY_PROXY_PRELOAD,
} from "./overlay-paths.js";

export const EVAL_BASELINE_TAG = "agenc-eval-baseline";
const GIT_IDENTITY = "-c user.email=eval@agenc.invalid -c user.name=agenc-eval";

/**
 * `.git` hygiene + a post-setup baseline commit tagged `agenc-eval-baseline`.
 * Runs after the setup patch is applied so the baseline tree = base + setup;
 * the candidate is later diffed from this tag, excluding the setup hunks.
 * Exported so tests exercise the exact shell the executor runs.
 */
export function buildBaselineGitScript(): string {
  return [
    `git remote 2>/dev/null | while read -r r; do git remote remove "$r"; done`,
    `git reflog expire --expire=now --all 2>/dev/null || true`,
    `git gc --prune=now --quiet 2>/dev/null || true`,
    `git ${GIT_IDENTITY} -c core.fileMode=false add -A`,
    `git ${GIT_IDENTITY} commit -q --allow-empty -m ${EVAL_BASELINE_TAG}`,
    `git tag -f ${EVAL_BASELINE_TAG}`,
  ].join("\n");
}

/**
 * Collect the agent's net change from the tagged baseline, committing any
 * work the agent left uncommitted so committed and uncommitted changes are
 * captured alike. `set -eo pipefail` fails the whole script if any git step
 * or the base64 pipe fails; base64 avoids a lossy UTF-8 round trip.
 */
export function buildCandidateCollectionScript(): string {
  return [
    `set -eo pipefail`,
    `git ${GIT_IDENTITY} add -A`,
    `git ${GIT_IDENTITY} commit -q --allow-empty -m agenc-eval-candidate`,
    `git -c core.quotepath=false diff ${EVAL_BASELINE_TAG} HEAD --binary | base64 | tr -d '\\n'`,
  ].join("\n");
}
const ENVIRONMENT_DIGEST_DOMAIN = "agenc.eval.executor-agent-environment.v1";
const REPORT_DIGEST_DOMAIN = "agenc.eval.executor-agent-run-report.v1";
const PROMPT_DIGEST_DOMAIN = "agenc.eval.executor-agent-prompt.v1";

/**
 * Version 1 of the fixed prompt wrapper. Identical for every task and every
 * system; the issue text is untrusted repository-adjacent content and grants
 * no capabilities.
 */
export const AGENT_PROMPT_PREAMBLE_V1 =
  "You are fixing a real repository issue. The repository is checked out at " +
  "the current working directory. Implement the code change that resolves " +
  "the issue described below, keeping the change minimal and consistent " +
  "with the surrounding code. Do not modify or delete existing tests. " +
  "Ensure every change is saved to disk before you finish.\n\nISSUE:\n";

export interface AgentOverlay {
  /** Host directory containing `node/`, `runtime/`, and `mock/`. */
  readonly hostDir: string;
}

export interface AgentRunInputs {
  readonly task: PilotSourceLockTask;
  readonly bundle: VerifierBundle;
  readonly setupPatch: Uint8Array;
}

export interface AgentRunConfig {
  readonly overlay: AgentOverlay;
  readonly agentTimeoutMs?: number;
}

export const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000;


export async function assertOverlayLayout(
  overlay: AgentOverlay,
  options: { readonly egress?: boolean } = {},
): Promise<void> {
  const required = [
    path.join(overlay.hostDir, "node", "bin", "node"),
    // Shim for task images that lack libatomic.so.1 (portable Node needs
    // it); missing staging fails fast here instead of as an opaque loader
    // error inside the container.
    path.join(overlay.hostDir, "node", "compat", "libatomic.so.1"),
    path.join(overlay.hostDir, OVERLAY_AGENT_ENTRY_SUBPATH),
    path.join(overlay.hostDir, "mock", "serve.mjs"),
    // The real-model lane also needs the proxy sidecar, the containment
    // probe, and the daemon proxy preload staged in the overlay.
    ...(options.egress
      ? [
        path.join(overlay.hostDir, "proxy", "allowlist-proxy.mjs"),
        path.join(overlay.hostDir, "proxy", "eval-egress-probe.mjs"),
        path.join(overlay.hostDir, "proxy", "eval-proxy-preload.cjs"),
      ]
      : []),
  ];
  for (const file of required) {
    try {
      await access(file);
    } catch {
      throw new EvalExecutorError([`agent overlay is missing ${file}`]);
    }
  }
}

/**
 * Attest which agent build is under test by digesting the overlay's runtime
 * entrypoint (and its VERSION when present). Without this the report cannot
 * say which agenc.js produced an outcome.
 */
async function computeOverlayDigest(overlay: AgentOverlay): Promise<Sha256Digest> {
  const entry = await readFile(path.join(overlay.hostDir, OVERLAY_AGENT_ENTRY_SUBPATH));
  let version = "";
  try {
    version = await readFile(
      path.join(overlay.hostDir, "runtime", "node_modules", "@tetsuo-ai", "runtime", "dist", "VERSION"),
      "utf8",
    );
  } catch {
    version = "unknown";
  }
  return digestCanonicalJson("agenc.eval.executor-agent-overlay.v1", {
    entryDigest: sha256Digest(entry),
    version: version.trim(),
  });
}

/**
 * The agent script. The provider is always the bundled in-container offline
 * mock and the container is always `--network none`, so there are no secrets
 * to inline and no egress to leak the oracle. `.git` remotes/reflog are
 * pruned before the agent runs; a post-setup baseline commit is tagged so the
 * candidate diff excludes the setup patch and survives the agent committing.
 */
function buildAgentScript(): string {
  return [
    `set -u`,
    `export PATH=${OVERLAY_CONTAINER_PATH}/node/bin:$PATH`,
    // libatomic shim for images that lack it; the image's own paths still
    // win for every other library via loader fallback.
    `export LD_LIBRARY_PATH=${OVERLAY_NODE_COMPAT_LIB}\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}`,
    `mkdir -p ${AGENT_HOME}`,
    // .git hygiene (drop remotes/unreachable objects) + post-setup baseline
    // commit + tag, so the candidate diff is exactly the agent's net change
    // and upstream fix commits cannot be recovered from history.
    buildBaselineGitScript(),
    // Offline mock provider inside the container.
    `node ${OVERLAY_CONTAINER_PATH}/mock/serve.mjs > ${AGENT_HELPER_DIR}/mock.log 2>&1 &`,
    `MOCK_PID=$!`,
    `for _ in $(seq 1 100); do grep -q MOCK_URL ${AGENT_HELPER_DIR}/mock.log 2>/dev/null && break; sleep 0.2; done`,
    `MOCK_URL=$(grep -o 'MOCK_URL=.*' ${AGENT_HELPER_DIR}/mock.log | head -1 | cut -d= -f2-)`,
    `if [ -z "$MOCK_URL" ]; then echo "AGENC_MOCK_FAILED" > ${AGENT_HELPER_DIR}/infra-failure; kill "$MOCK_PID" 2>/dev/null || true; exit 86; fi`,
    `export AGENC_PROVIDER=openai-compatible AGENC_MODEL=local-pipeline-model`,
    `export OPENAI_COMPATIBLE_MODEL=local-pipeline-model OPENAI_COMPATIBLE_API_KEY=local-pipeline-key`,
    `export OPENAI_COMPATIBLE_BASE_URL="$MOCK_URL/v1" API_TIMEOUT_MS=600000`,
    `export AGENC_HOME=${AGENT_HOME} AGENC_WORKSPACE="$PWD" AGENC_AUTH_MANAGED_KEYS_ENABLED=0`,
    // Workspace trust is granted by the evaluator, never by repository
    // content: the store is written before the agent runs.
    `printf '%s' "{\\"version\\":1,\\"trustedProjects\\":[{\\"path\\":\\"$PWD\\",\\"trustedAt\\":\\"1970-01-01T00:00:00Z\\"}]}" > ${AGENT_HOME}/trusted-projects.json`,
    `node ${AGENT_RUNTIME_ENTRY} -p "$(cat ${AGENT_HELPER_DIR}/prompt.txt)" ` +
      `--output-format json --yolo > ${AGENT_HELPER_DIR}/agent-result.json 2> ${AGENT_HELPER_DIR}/agent-stderr.log`,
    `AGENC_RC=$?`,
    `kill "$MOCK_PID" 2>/dev/null || true`,
    `exit $AGENC_RC`,
  ].join("\n");
}

interface ParsedAgentResult {
  readonly sessionId: string | null;
  readonly finalMessage: string | null;
  readonly tokenUsage: Readonly<Record<string, number>> | null;
}

function parseAgentResult(raw: string): ParsedAgentResult {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const usage = value.tokenUsage;
    const tokenUsage: Record<string, number> = {};
    if (typeof usage === "object" && usage !== null) {
      for (const [key, entry] of Object.entries(usage)) {
        if (typeof entry === "number" && Number.isFinite(entry)) tokenUsage[key] = entry;
      }
    }
    return {
      sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
      finalMessage: typeof value.finalMessage === "string" ? value.finalMessage : null,
      tokenUsage: Object.keys(tokenUsage).length > 0 ? tokenUsage : null,
    };
  } catch {
    return { sessionId: null, finalMessage: null, tokenUsage: null };
  }
}

const EMPTY_AGENT_RECORD: AgentRunReport["agent"] = {
  exitCode: null,
  timedOut: false,
  resultTruncated: false,
  sessionId: null,
  finalMessageDigest: null,
  tokenUsage: null,
};

/** Apply the setup patch (if any) and write the prompt into the container. */
async function applySetupAndPrompt(
  runner: ContainerRunner,
  handle: ContainerHandle,
  setupPatch: Uint8Array,
  prompt: string,
  timeouts: PreflightTimeouts,
): Promise<void> {
  if (setupPatch.byteLength > 0) {
    await runner.writeFile(handle, `${AGENT_HELPER_DIR}/setup.patch`, setupPatch);
    const applied = await runner.exec(handle, {
      script: `git -c core.fileMode=false apply --verbose '${AGENT_HELPER_DIR}/setup.patch'`,
      timeoutMs: timeouts.patchMs,
    });
    if (applied.exitCode !== 0) {
      throw new EvalExecutorError([`setup patch did not apply: ${applied.stderr.slice(0, 500)}`]);
    }
  }
  await runner.writeFile(handle, `${AGENT_HELPER_DIR}/prompt.txt`, new TextEncoder().encode(prompt));
}

interface CollectResult {
  readonly agent: AgentRunReport["agent"];
  readonly patch: AgentRunReport["patch"];
  readonly patchBytes: Uint8Array | null;
  readonly rawAgentResult: string;
  readonly outcome: AgentRunOutcome | null;
  readonly failureDetail: string | null;
}

/**
 * Shared post-agent-exec logic for both lanes: read the agent's JSON result,
 * classify the outcome, and collect the candidate patch (with the same
 * truncation and empty guards). Extracted so the mock and real lanes cannot
 * drift on this security-sensitive collection path.
 */
async function readResultAndCollect(params: {
  readonly runner: ContainerRunner;
  readonly handle: ContainerHandle;
  readonly executed: ContainerExecResult;
  readonly agentTimeoutMs: number;
  readonly timeouts: PreflightTimeouts;
  readonly onSpecialExit?: (
    exitCode: number,
  ) => { readonly outcome: AgentRunOutcome; readonly failureDetail: string } | null;
}): Promise<CollectResult> {
  const { runner, handle, executed, agentTimeoutMs, timeouts } = params;
  const resultRead = await runner.exec(handle, {
    script: `cat ${AGENT_HELPER_DIR}/agent-result.json 2>/dev/null || true`,
    timeoutMs: timeouts.patchMs,
  });
  const parsed = parseAgentResult(resultRead.stdout);
  const agent: AgentRunReport["agent"] = {
    exitCode: executed.exitCode,
    timedOut: executed.timedOut,
    resultTruncated: resultRead.truncated,
    sessionId: parsed.sessionId,
    finalMessageDigest: parsed.finalMessage === null ? null : sha256Digest(parsed.finalMessage),
    tokenUsage: parsed.tokenUsage,
  };
  const base = { agent, rawAgentResult: resultRead.stdout, patch: null, patchBytes: null } as const;
  const special = executed.exitCode !== null ? params.onSpecialExit?.(executed.exitCode) : null;
  if (executed.timedOut) {
    return { ...base, outcome: "agent_timeout", failureDetail: `agent exceeded ${agentTimeoutMs}ms` };
  }
  if (special) {
    return { ...base, outcome: special.outcome, failureDetail: special.failureDetail };
  }
  if (executed.exitCode !== 0) {
    const stderrRead = await runner.exec(handle, {
      script: `tail -c 2000 ${AGENT_HELPER_DIR}/agent-stderr.log 2>/dev/null || true`,
      timeoutMs: timeouts.patchMs,
    });
    return {
      ...base,
      outcome: "agent_error",
      failureDetail: `agent exited ${executed.exitCode}: ${stderrRead.stdout.trim()}`,
    };
  }
  const collected = await runner.exec(handle, {
    script: buildCandidateCollectionScript(),
    timeoutMs: timeouts.patchMs,
  });
  if (collected.exitCode !== 0) {
    throw new EvalExecutorError([`patch collection failed: ${collected.stderr.slice(0, 500)}`]);
  }
  if (collected.truncated) {
    return {
      ...base,
      outcome: "infrastructure_error",
      failureDetail: "collected patch exceeded the capture bound",
    };
  }
  const patchBytes = new Uint8Array(Buffer.from(collected.stdout, "base64"));
  if (patchBytes.byteLength === 0) {
    return {
      ...base,
      outcome: "empty_patch",
      failureDetail: "agent completed without modifying the repository",
    };
  }
  return {
    agent,
    rawAgentResult: resultRead.stdout,
    patch: { digest: sha256Digest(patchBytes), sizeBytes: patchBytes.byteLength, truncated: false },
    patchBytes,
    outcome: null,
    failureDetail: null,
  };
}

/** Shared hidden-verifier step for both lanes. */
async function runVerification(
  runner: ContainerRunner,
  inputs: AgentRunInputs,
  patchBytes: Uint8Array,
  timeouts: PreflightTimeouts,
  options: PreflightExecutionOptions,
): Promise<{
  verification: PreflightPhaseTranscript;
  outcome: AgentRunOutcome;
  failureDetail: string | null;
}> {
  const verified = await verifyCandidatePatch(
    runner,
    {
      task: inputs.task,
      bundle: inputs.bundle,
      setupPatch: inputs.setupPatch,
      candidatePatch: patchBytes,
    },
    timeouts,
    options,
  );
  if (verified.passed) {
    return { verification: verified.transcript, outcome: "verified_fix", failureDetail: null };
  }
  if (verified.infrastructureFailure) {
    return {
      verification: verified.transcript,
      outcome: "infrastructure_error",
      failureDetail:
        `verification ${verified.infrastructureFailure.reason}: ${verified.infrastructureFailure.detail}`,
    };
  }
  return {
    verification: verified.transcript,
    outcome: "verification_failure",
    failureDetail: `${verified.failedCheck!.name} (${verified.failedCheck!.evidence})`,
  };
}

export interface AgentRunArtifacts {
  readonly report: AgentRunReport;
  readonly patchBytes: Uint8Array | null;
  readonly rawAgentResult: string | null;
}

/**
 * Run the real AgenC agent against one pinned task and verify its patch with
 * the hidden verifier. Oracle isolation is structural: the agent container is
 * `--network none` against an offline mock provider, gets only the setup
 * patch, issue text, and read-only runtime overlay, and never sees the test
 * patch, reference solution, or verifier bundle. Verification runs afterwards
 * in a fresh offline container via the shared preflight machinery.
 *
 * This is the pipeline-validation lane. A real-model lane requires an
 * egress-allowlist proxy and full `.git` oracle hygiene and is a follow-up.
 */
export async function runAgentOnTask(
  runner: ContainerRunner,
  inputs: AgentRunInputs,
  config: AgentRunConfig,
  timeouts: PreflightTimeouts = DEFAULT_PREFLIGHT_TIMEOUTS,
  options: PreflightExecutionOptions = {},
): Promise<AgentRunArtifacts> {
  await assertOverlayLayout(config.overlay);
  const startedAt = new Date().toISOString();
  const environment = await runner.environment();
  const overlayDigest = await computeOverlayDigest(config.overlay);
  const environmentDigest = digestCanonicalJson(ENVIRONMENT_DIGEST_DOMAIN, {
    ...environment,
    image: inputs.task.image,
    overlayDigest,
    provider: "in-container-offline-mock",
  });
  const prompt = `${AGENT_PROMPT_PREAMBLE_V1}${inputs.task.issueText}`;
  const promptDigest = digestCanonicalJson(PROMPT_DIGEST_DOMAIN, {
    preambleVersion: "v1",
    prompt,
  });

  let handle: ContainerHandle | null = null;
  let collect: CollectResult | null = null;
  let outcome: AgentRunOutcome | null = null;
  let failureDetail: string | null = null;
  const agentTimeoutMs = config.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

  try {
    handle = await runner.createTaskContainer(inputs.task.image, {
      readOnlyMounts: [
        { hostPath: path.resolve(config.overlay.hostDir), containerPath: OVERLAY_CONTAINER_PATH },
      ],
    });
    await applySetupAndPrompt(runner, handle, inputs.setupPatch, prompt, timeouts);
    const executed = await runner.exec(handle, {
      script: buildAgentScript(),
      timeoutMs: agentTimeoutMs,
    });
    collect = await readResultAndCollect({
      runner,
      handle,
      executed,
      agentTimeoutMs,
      timeouts,
      onSpecialExit: (code) =>
        code === 86
          ? { outcome: "infrastructure_error", failureDetail: "in-container mock provider failed to start" }
          : null,
    });
    outcome = collect.outcome;
    failureDetail = collect.failureDetail;
  } catch (error) {
    outcome = "infrastructure_error";
    failureDetail = error instanceof Error ? error.message : String(error);
  } finally {
    if (handle) await runner.remove(handle);
  }

  const agent = collect?.agent ?? EMPTY_AGENT_RECORD;
  const patch = collect?.patch ?? null;
  let patchBytes = collect?.patchBytes ?? null;
  const rawAgentResult = collect?.rawAgentResult ?? null;

  let verification: AgentRunReport["verification"] = null;
  if (outcome === null && patchBytes !== null) {
    const result = await runVerification(runner, inputs, patchBytes, timeouts, options);
    verification = result.verification;
    outcome = result.outcome;
    failureDetail = result.failureDetail;
  }

  const finishedAt = new Date().toISOString();
  const reportBody = {
    taskId: inputs.task.instanceId,
    startedAt,
    finishedAt,
    promptDigest,
    agent,
    patch,
    verification,
    outcome: outcome ?? "infrastructure_error",
    failureDetail,
    egress: null,
    environmentDigest,
  };
  const report: AgentRunReport = {
    ...reportBody,
    reportDigest: digestCanonicalJson(REPORT_DIGEST_DOMAIN, reportBody) as Sha256Digest,
  };
  return { report, patchBytes, rawAgentResult };
}

export interface RealProviderAgentConfig {
  readonly overlay: AgentOverlay;
  readonly agentTimeoutMs?: number;
  /** Exact provider host the sidecar allows (e.g. "api.x.ai"). */
  readonly allowHost: string;
  readonly allowPort: number;
  /** Host-resolved provider IPs; the sidecar dials only these. */
  readonly pinIps: readonly string[];
  readonly model: string;
  /** Full base URL, e.g. "https://api.x.ai/v1". */
  readonly baseUrl: string;
  /** Env var NAME in the executor's process.env holding the provider key. */
  readonly keyEnvVar: string;
  readonly runId: string;
  readonly subnetOctet: number;
  readonly proxyListenPort?: number;
}

/**
 * The real-provider agent script: no in-container mock, egress goes through
 * the sidecar proxy, and the provider key is NOT written here — it arrives via
 * `docker exec -e ${keyEnvVar}` so it is on no argv. `AGENC_PROXY_RESOLVES_HOSTS`
 * makes undici put the hostname in the CONNECT authority, which lets the
 * blackholed resolver be a hard boundary rather than a breakage.
 */
export function buildRealProviderAgentScript(config: {
  readonly proxyIp: string;
  readonly proxyListenPort: number;
  readonly model: string;
  readonly baseUrl: string;
}): string {
  const proxyUrl = `http://${config.proxyIp}:${config.proxyListenPort}`;
  return [
    `set -u`,
    `export PATH=${OVERLAY_CONTAINER_PATH}/node/bin:$PATH`,
    // libatomic shim for images that lack it; the image's own paths still
    // win for every other library via loader fallback.
    `export LD_LIBRARY_PATH=${OVERLAY_NODE_COMPAT_LIB}\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}`,
    `mkdir -p ${AGENT_HOME}`,
    buildBaselineGitScript(),
    `export HTTPS_PROXY=${proxyUrl} HTTP_PROXY=${proxyUrl} NO_PROXY=`,
    `export AGENC_PROXY_RESOLVES_HOSTS=1`,
    // Install the undici proxy dispatcher in the CLI AND the daemon it spawns
    // (NODE_OPTIONS is inherited): the runtime only configures the proxy in
    // TUI mode, so a headless agent would otherwise ignore HTTPS_PROXY.
    `export NODE_OPTIONS="--require ${OVERLAY_PROXY_PRELOAD}"`,
    `export AGENC_PROVIDER=openai-compatible AGENC_MODEL=${config.model}`,
    `export OPENAI_COMPATIBLE_MODEL=${config.model}`,
    `export OPENAI_COMPATIBLE_BASE_URL="${config.baseUrl}" API_TIMEOUT_MS=600000`,
    `export AGENC_HOME=${AGENT_HOME} AGENC_WORKSPACE="$PWD" AGENC_AUTH_MANAGED_KEYS_ENABLED=0`,
    // OPENAI_COMPATIBLE_API_KEY is injected via `docker exec -e`, never here.
    `printf '%s' "{\\"version\\":1,\\"trustedProjects\\":[{\\"path\\":\\"$PWD\\",\\"trustedAt\\":\\"1970-01-01T00:00:00Z\\"}]}" > ${AGENT_HOME}/trusted-projects.json`,
    `node ${AGENT_RUNTIME_ENTRY} -p "$(cat ${AGENT_HELPER_DIR}/prompt.txt)" ` +
      `--output-format json --yolo > ${AGENT_HELPER_DIR}/agent-result.json 2> ${AGENT_HELPER_DIR}/agent-stderr.log`,
    `exit $?`,
  ].join("\n");
}

const ALL_FALSE_PROBES: EgressContainmentProbes = {
  noRouteOffNet: false,
  githubBlocked: false,
  dnsBlackholed: false,
  ipv6Absent: false,
  ipLiteralRejected: false,
  sniPinned: false,
};

/**
 * Run the real AgenC agent against one pinned task through a real model
 * provider, inside a topologically network-isolated egress lane. The agent is
 * only started after every containment deny-probe passes; otherwise the run is
 * `oracle_containment_unverified` and no agent runs. The collected patch is
 * scanned for the provider key before verification. Verification runs in a
 * fresh `--network none` container via the shared machinery.
 *
 * `createLane` is injected so the gating is testable without docker; the CLI
 * passes `(req) => dockerRunner.createEgressLane(req)`.
 */
export async function runRealProviderAgentOnTask(
  runner: ContainerRunner,
  createLane: EgressLaneFactory,
  inputs: AgentRunInputs,
  config: RealProviderAgentConfig,
  timeouts: PreflightTimeouts = DEFAULT_PREFLIGHT_TIMEOUTS,
  options: PreflightExecutionOptions = {},
): Promise<AgentRunArtifacts> {
  await assertOverlayLayout(config.overlay, { egress: true });
  const secret = process.env[config.keyEnvVar];
  if (secret === undefined || secret.length === 0) {
    throw new EvalExecutorError([`${config.keyEnvVar} is not set in the executor environment`]);
  }
  // The exfil key-scan is only meaningful for a long secret; a real provider
  // bearer is long. Refuse a short key rather than silently running with the
  // scan disabled.
  if (secret.length < 16) {
    throw new EvalExecutorError([`${config.keyEnvVar} is too short to be a provider key`]);
  }
  // model and baseUrl are interpolated into the agent bash script; reject
  // shell-metacharacter values (same trust discipline as allowHost).
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(config.model)) {
    throw new EvalExecutorError([`invalid provider model ${config.model}`]);
  }
  if (!/^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{1,256}$/u.test(config.baseUrl)) {
    throw new EvalExecutorError([`invalid provider base URL ${config.baseUrl}`]);
  }
  const startedAt = new Date().toISOString();
  const environment = await runner.environment();
  const overlayDigest = await computeOverlayDigest(config.overlay);
  const environmentDigest = digestCanonicalJson(ENVIRONMENT_DIGEST_DOMAIN, {
    ...environment,
    image: inputs.task.image,
    overlayDigest,
    provider: "real-provider",
    allowHost: config.allowHost,
    model: config.model,
  });
  const prompt = `${AGENT_PROMPT_PREAMBLE_V1}${inputs.task.issueText}`;
  const promptDigest = digestCanonicalJson(PROMPT_DIGEST_DOMAIN, { preambleVersion: "v1", prompt });
  const proxyListenPort = config.proxyListenPort ?? DEFAULT_PROXY_LISTEN_PORT;

  let collect: CollectResult | null = null;
  let outcome: AgentRunOutcome | null = null;
  let failureDetail: string | null = null;
  let probes: EgressContainmentProbes = ALL_FALSE_PROBES;
  let patchKeyScan: EgressReport["patchKeyScan"] = "not-run";
  const agentTimeoutMs = config.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

  let lane: Awaited<ReturnType<EgressLaneFactory>> | null = null;
  try {
    lane = await createLane({
      runId: config.runId,
      subnetOctet: config.subnetOctet,
      taskImage: inputs.task.image,
      overlayHostDir: path.resolve(config.overlay.hostDir),
      allowHost: config.allowHost,
      allowPort: config.allowPort,
      pinIps: config.pinIps,
      proxyListenPort,
    });
    probes = await lane.runContainmentProbes();
    if (!allContainmentProbesPass(probes)) {
      outcome = "oracle_containment_unverified";
      failureDetail = "egress containment probes did not all pass; agent not started";
    } else {
      const handle = lane.agentHandle;
      await applySetupAndPrompt(runner, handle, inputs.setupPatch, prompt, timeouts);
      const executed = await runner.exec(handle, {
        script: buildRealProviderAgentScript({
          proxyIp: lane.proxyIp,
          proxyListenPort: lane.proxyListenPort,
          model: config.model,
          baseUrl: config.baseUrl,
        }),
        timeoutMs: agentTimeoutMs,
        envPassthrough: [config.keyEnvVar],
      });
      collect = await readResultAndCollect({ runner, handle, executed, agentTimeoutMs, timeouts });
      outcome = collect.outcome;
      failureDetail = collect.failureDetail;
      // Scan for the key across the patch AND the agent's own output (a
      // prompt-injected agent could echo the key into its result or stderr).
      const leaked =
        (collect.patchBytes !== null && scanPatchForSecret(collect.patchBytes, secret)) ||
        stringContainsSecret(collect.rawAgentResult, secret) ||
        (collect.failureDetail !== null && stringContainsSecret(collect.failureDetail, secret));
      if (leaked) {
        patchKeyScan = "key-substring-found";
        outcome = "infrastructure_error";
        failureDetail = "provider API key found in agent output; run quarantined";
      } else {
        patchKeyScan = "clean";
      }
    }
  } catch (error) {
    outcome = "infrastructure_error";
    failureDetail = error instanceof Error ? error.message : String(error);
  } finally {
    if (lane) await lane.teardown();
  }

  const agent = collect?.agent ?? EMPTY_AGENT_RECORD;
  const patch = collect?.patch ?? null;
  // Never verify or return a patch that leaked the key.
  const patchBytes = patchKeyScan === "key-substring-found" ? null : collect?.patchBytes ?? null;
  // Redact the secret from every persisted/digested text artifact defensively.
  const rawAgentResult = collect === null ? null : redactSecret(collect.rawAgentResult, secret);

  let verification: AgentRunReport["verification"] = null;
  if (outcome === null && patchBytes !== null) {
    const result = await runVerification(runner, inputs, patchBytes, timeouts, options);
    verification = result.verification;
    outcome = result.outcome;
    failureDetail = result.failureDetail;
  }
  if (failureDetail !== null) failureDetail = redactSecret(failureDetail, secret);

  const egress: EgressReport = {
    mode: "real-provider",
    allowHost: config.allowHost,
    keyExposure: "agent-env",
    sidecarOverlayDigest: overlayDigest,
    oracleContainment: computeOracleContainment(probes, patchKeyScan),
    denyProbes: probes,
    patchKeyScan,
  };
  const finishedAt = new Date().toISOString();
  const reportBody = {
    taskId: inputs.task.instanceId,
    startedAt,
    finishedAt,
    promptDigest,
    agent,
    patch,
    verification,
    outcome: outcome ?? "infrastructure_error",
    failureDetail,
    egress,
    environmentDigest,
  };
  const report: AgentRunReport = {
    ...reportBody,
    reportDigest: digestCanonicalJson(REPORT_DIGEST_DOMAIN, reportBody) as Sha256Digest,
  };
  return { report, patchBytes, rawAgentResult };
}
