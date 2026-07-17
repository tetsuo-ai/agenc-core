import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { digestCanonicalJson, sha256Digest, type Sha256Digest } from "../eval-contract/index.js";
import {
  verifyCandidatePatch,
  DEFAULT_PREFLIGHT_TIMEOUTS,
  type PreflightExecutionOptions,
  type PreflightTimeouts,
} from "./preflight.js";
import { EvalExecutorError } from "./source-lock.js";
import type {
  AgentRunOutcome,
  AgentRunReport,
  ContainerHandle,
  ContainerRunner,
  PilotSourceLockTask,
  VerifierBundle,
} from "./types.js";

const OVERLAY_CONTAINER_PATH = "/agenc-overlay";
const AGENT_HELPER_DIR = "/agenc-eval";
const AGENT_HOME = `${AGENT_HELPER_DIR}/agent-home`;
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

const AGENT_RUNTIME_ENTRY =
  `${OVERLAY_CONTAINER_PATH}/runtime/node_modules/@tetsuo-ai/runtime/dist/bin/agenc.js`;
const OVERLAY_AGENT_ENTRY_SUBPATH = path.join(
  "runtime", "node_modules", "@tetsuo-ai", "runtime", "dist", "bin", "agenc.js",
);

export async function assertOverlayLayout(overlay: AgentOverlay): Promise<void> {
  const required = [
    path.join(overlay.hostDir, "node", "bin", "node"),
    path.join(overlay.hostDir, OVERLAY_AGENT_ENTRY_SUBPATH),
    path.join(overlay.hostDir, "mock", "serve.mjs"),
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
  let agent: AgentRunReport["agent"] = {
    exitCode: null,
    timedOut: false,
    resultTruncated: false,
    sessionId: null,
    finalMessageDigest: null,
    tokenUsage: null,
  };
  let patch: AgentRunReport["patch"] = null;
  let patchBytes: Uint8Array | null = null;
  let rawAgentResult: string | null = null;
  let outcome: AgentRunOutcome | null = null;
  let failureDetail: string | null = null;

  try {
    handle = await runner.createTaskContainer(inputs.task.image, {
      readOnlyMounts: [
        { hostPath: path.resolve(config.overlay.hostDir), containerPath: OVERLAY_CONTAINER_PATH },
      ],
    });

    if (inputs.setupPatch.byteLength > 0) {
      await runner.writeFile(handle, `${AGENT_HELPER_DIR}/setup.patch`, inputs.setupPatch);
      const applied = await runner.exec(handle, {
        script: `git -c core.fileMode=false apply --verbose '${AGENT_HELPER_DIR}/setup.patch'`,
        timeoutMs: timeouts.patchMs,
      });
      if (applied.exitCode !== 0) {
        throw new EvalExecutorError([`setup patch did not apply: ${applied.stderr.slice(0, 500)}`]);
      }
    }
    await runner.writeFile(
      handle,
      `${AGENT_HELPER_DIR}/prompt.txt`,
      new TextEncoder().encode(prompt),
    );

    const agentTimeoutMs = config.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const executed = await runner.exec(handle, {
      script: buildAgentScript(),
      timeoutMs: agentTimeoutMs,
    });

    const resultRead = await runner.exec(handle, {
      script: `cat ${AGENT_HELPER_DIR}/agent-result.json 2>/dev/null || true`,
      timeoutMs: timeouts.patchMs,
    });
    rawAgentResult = resultRead.stdout;
    const parsed = parseAgentResult(resultRead.stdout);
    agent = {
      exitCode: executed.exitCode,
      timedOut: executed.timedOut,
      resultTruncated: resultRead.truncated,
      sessionId: parsed.sessionId,
      finalMessageDigest: parsed.finalMessage === null ? null : sha256Digest(parsed.finalMessage),
      tokenUsage: parsed.tokenUsage,
    };

    if (executed.timedOut) {
      outcome = "agent_timeout";
      failureDetail = `agent exceeded ${agentTimeoutMs}ms`;
    } else if (executed.exitCode === 86) {
      // The in-container mock never came up: environment, not the agent.
      outcome = "infrastructure_error";
      failureDetail = "in-container mock provider failed to start";
    } else if (executed.exitCode !== 0) {
      outcome = "agent_error";
      const stderrRead = await runner.exec(handle, {
        script: `tail -c 2000 ${AGENT_HELPER_DIR}/agent-stderr.log 2>/dev/null || true`,
        timeoutMs: timeouts.patchMs,
      });
      failureDetail = `agent exited ${executed.exitCode}: ${stderrRead.stdout.trim()}`;
    } else {
      // Collect the agent's net change from the tagged post-setup baseline,
      // committing any work the agent left uncommitted. base64 avoids a lossy
      // UTF-8 round trip through captured stdout.
      const collected = await runner.exec(handle, {
        script: buildCandidateCollectionScript(),
        timeoutMs: timeouts.patchMs,
      });
      if (collected.exitCode !== 0) {
        throw new EvalExecutorError([`patch collection failed: ${collected.stderr.slice(0, 500)}`]);
      }
      if (collected.truncated) {
        // Never verify a truncated patch: base64 would decode wrong, and the
        // real working tree could pass or fail differently.
        outcome = "infrastructure_error";
        failureDetail = "collected patch exceeded the capture bound";
      } else {
        patchBytes = new Uint8Array(Buffer.from(collected.stdout, "base64"));
        patch = {
          digest: sha256Digest(patchBytes),
          sizeBytes: patchBytes.byteLength,
          truncated: false,
        };
        if (patchBytes.byteLength === 0) {
          outcome = "empty_patch";
          failureDetail = "agent completed without modifying the repository";
          patchBytes = null;
        }
      }
    }
  } catch (error) {
    outcome = "infrastructure_error";
    failureDetail = error instanceof Error ? error.message : String(error);
  } finally {
    if (handle) await runner.remove(handle);
  }

  let verification: AgentRunReport["verification"] = null;
  if (outcome === null && patchBytes !== null) {
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
    verification = verified.transcript;
    if (verified.passed) {
      outcome = "verified_fix";
    } else if (verified.infrastructureFailure) {
      outcome = "infrastructure_error";
      failureDetail =
        `verification ${verified.infrastructureFailure.reason}: ${verified.infrastructureFailure.detail}`;
    } else {
      outcome = "verification_failure";
      failureDetail = `${verified.failedCheck!.name} (${verified.failedCheck!.evidence})`;
    }
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
    environmentDigest,
  };
  const report: AgentRunReport = {
    ...reportBody,
    reportDigest: digestCanonicalJson(REPORT_DIGEST_DOMAIN, reportBody) as Sha256Digest,
  };
  return { report, patchBytes, rawAgentResult };
}
