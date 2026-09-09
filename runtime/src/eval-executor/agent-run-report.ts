import { z } from "zod/v4";
import { digestCanonicalJson, type Sha256Digest } from "../eval-contract/index.js";
import { EvalExecutorError } from "./source-lock.js";
import { computeOverlayManifestDigest, OverlayManifestSchema } from "./overlay-manifest.js";
import type { AgentRunReport, PilotSourceLockTask } from "./types.js";

export const REPORT_DIGEST_DOMAIN = "agenc.eval.executor-agent-run-report.v1";
const DigestSchema = z.custom<Sha256Digest>(
  (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value),
);
const CountSchema = z.number().int().nonnegative();
const CommandSchema = z.strictObject({
  label: z.string(),
  script: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
  stdoutDigest: DigestSchema,
  stderrDigest: DigestSchema,
  stdoutExcerpt: z.string(),
  stderrExcerpt: z.string(),
});
const ReportSchema = z.strictObject({
  taskId: z.string().min(1),
  sourceTaskDigest: DigestSchema,
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
  promptDigest: DigestSchema,
  agent: z.strictObject({
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    resultTruncated: z.boolean(),
    sessionId: z.string().nullable(),
    finalMessageDigest: DigestSchema.nullable(),
    tokenUsage: z.record(z.string(), z.number()).nullable(),
  }),
  patch: z.strictObject({
    digest: DigestSchema,
    sizeBytes: CountSchema,
    truncated: z.boolean(),
  }).nullable(),
  verification: z.strictObject({
    phase: z.enum(["base", "reference"]),
    imageDigest: z.string(),
    parserImageDigest: z.string().min(1).nullable(),
    appliedPatches: z.array(z.string()),
    commands: z.array(CommandSchema),
    testResults: z.record(z.string(), z.string()).nullable(),
  }).nullable(),
  outcome: z.enum([
    "verified_fix", "verification_failure", "empty_patch", "agent_error",
    "agent_timeout", "oracle_containment_unverified", "infrastructure_error",
  ]),
  failureDetail: z.string().nullable(),
  egress: z.strictObject({
    mode: z.literal("real-provider"),
    allowHost: z.string().min(1),
    keyExposure: z.enum(["agent-env", "sidecar-only"]),
    sidecarOverlayDigest: DigestSchema,
    oracleContainment: z.enum(["unverified", "contained"]),
    denyProbes: z.strictObject({
      noRouteOffNet: z.boolean(),
      githubBlocked: z.boolean(),
      dnsBlackholed: z.boolean(),
      ipv6Absent: z.boolean(),
      ipLiteralRejected: z.boolean(),
      sniPinned: z.boolean(),
    }),
    patchKeyScan: z.enum(["clean", "key-substring-found", "not-run"]),
  }).nullable(),
  environmentDigest: DigestSchema,
  overlayManifest: OverlayManifestSchema,
  reportDigest: DigestSchema,
}) satisfies z.ZodType<AgentRunReport>;

export function computeSourceTaskDigest(task: PilotSourceLockTask): Sha256Digest {
  return digestCanonicalJson("agenc.eval.executor-source-task.v1", task);
}

export function validateAgentRunReport(value: unknown, task: PilotSourceLockTask): AgentRunReport {
  if (typeof value === "object" && value !== null && !("overlayManifest" in value)) {
    throw new EvalExecutorError(["Agent run report lacks the versioned overlay manifest; preserve the old report and rerun in a new output directory"]);
  }
  const parsed = ReportSchema.safeParse(value);
  if (!parsed.success) {
    throw new EvalExecutorError(["Agent run report does not match the complete report schema"]);
  }
  const report = parsed.data;
  if ((report.egress === null) !== (report.overlayManifest.mode === "offline") || (
    report.egress !== null && report.egress.sidecarOverlayDigest !== computeOverlayManifestDigest(report.overlayManifest)
  )) {
    throw new EvalExecutorError(["Agent run report overlay manifest does not match its execution mode or sidecar digest"]);
  }
  if (report.taskId !== task.instanceId || report.sourceTaskDigest !== computeSourceTaskDigest(task)) {
    throw new EvalExecutorError(["Agent run report does not match the source-lock task"]);
  }
  const { reportDigest, ...body } = report;
  if (reportDigest !== digestCanonicalJson(REPORT_DIGEST_DOMAIN, body)) {
    throw new EvalExecutorError(["Agent run report digest does not match its contents"]);
  }
  if (Date.parse(report.finishedAt) < Date.parse(report.startedAt)) {
    throw new EvalExecutorError(["Agent run report finishes before it starts"]);
  }
  if (report.verification?.imageDigest === "" && report.outcome !== "infrastructure_error") {
    throw new EvalExecutorError(["Only an infrastructure-error report may lack a verification image"]);
  }
  if (report.outcome === "verified_fix" && (
    report.agent.exitCode !== 0 || report.agent.timedOut ||
    report.patch === null || report.patch.sizeBytes === 0 || report.patch.truncated ||
    report.verification?.phase !== "reference" || report.verification.testResults === null ||
    report.failureDetail !== null ||
    (report.egress !== null && (
      report.egress.oracleContainment !== "contained" || report.egress.patchKeyScan !== "clean" ||
      !Object.values(report.egress.denyProbes).every(Boolean)
    ))
  )) {
    throw new EvalExecutorError(["Verified-fix report lacks successful agent, patch, verification, or containment evidence"]);
  }
  return report;
}
