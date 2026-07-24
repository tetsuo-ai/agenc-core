/**
 * M5 verification executor — runs the spec's required verification commands
 * in the workflow worktree and captures evidence.
 *
 * Pure library: command execution is injected (`WorkflowCommandRunner`), so
 * the controller can back it with the sandbox execution broker and tests
 * can script it. Capture is PreflightCommandRecord-shaped (full output is
 * digested; bounded excerpts kept for triage; the complete record set is a
 * `test_result` artifact in the evidence sink).
 *
 * This is the only genuinely parallel stage of the fixed pipeline:
 * independent commands run concurrently bounded by `parallelism` (the
 * controller passes the run's admitted session limit).
 */

import { createHash } from "node:crypto";

import type { RunStepIdentity } from "../contracts/run-contracts.js";
import type { VerifiedChangeCommandRecord } from "./evidence-record.js";
import type { EvidenceArtifactSink } from "./worktree-lifecycle.js";
import { canonicalizeJson } from "../eval-contract/canonical-json.js";
import type { RunArtifactPointer } from "../contracts/run-contracts.js";

export interface WorkflowCommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface WorkflowCommandRunner {
  run(input: {
    readonly script: string;
    readonly cwd: string;
    /** Optional operator-supplied deadline. Omitted means unbounded. */
    readonly timeoutMs?: number;
  }): Promise<WorkflowCommandResult>;
}

const EXCERPT_BYTES = 4_096;

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function excerpt(bytes: Uint8Array): string {
  return new TextDecoder("utf8", { fatal: false })
    .decode(bytes.subarray(0, EXCERPT_BYTES))
    .replace(/�/g, "");
}

export interface RunRequiredVerificationResult {
  readonly records: readonly VerifiedChangeCommandRecord[];
  /** Bounded excerpts per label for diagnostics (not part of the record). */
  readonly excerpts: Readonly<Record<string, { stdout: string; stderr: string }>>;
  readonly testResult: RunArtifactPointer;
  readonly allPassed: boolean;
}

/**
 * Run every required verification command; never short-circuits — a later
 * command's failure evidence is captured even when an earlier one failed.
 */
export async function runRequiredVerification(opts: {
  readonly worktreePath: string;
  readonly commands: readonly { readonly label: string; readonly script: string }[];
  readonly runner: WorkflowCommandRunner;
  readonly sink: EvidenceArtifactSink;
  readonly step: RunStepIdentity;
  readonly parallelism: number;
  readonly timeoutMsPerCommand?: number;
}): Promise<RunRequiredVerificationResult> {
  const {
    worktreePath, commands, runner, sink, step,
  } = opts;
  if (commands.length === 0) {
    throw new Error("required verification demands at least one command");
  }
  const labels = new Set<string>();
  for (const command of commands) {
    if (labels.has(command.label)) {
      throw new Error(`duplicate verification label: ${command.label}`);
    }
    labels.add(command.label);
  }
  const parallelism = Math.max(1, Math.floor(opts.parallelism));

  const records: VerifiedChangeCommandRecord[] = new Array(commands.length);
  const excerpts: Record<string, { stdout: string; stderr: string }> = {};
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < commands.length) {
      const index = next;
      next += 1;
      const command = commands[index];
      const startedAt = performance.now();
      let result: WorkflowCommandResult;
      try {
        result = await runner.run({
          script: command.script,
          cwd: worktreePath,
          ...(opts.timeoutMsPerCommand !== undefined
            ? { timeoutMs: opts.timeoutMsPerCommand }
            : {}),
        });
      } catch (error) {
        // A runner crash is a failing command with diagnostic stderr, never
        // a silently missing record.
        const message = error instanceof Error ? error.message : String(error);
        result = {
          exitCode: 127,
          stdout: new Uint8Array(0),
          stderr: new TextEncoder().encode(message),
          timedOut: false,
          truncated: false,
          durationMs: Math.round(performance.now() - startedAt),
        };
      }
      records[index] = {
        label: command.label,
        script: command.script,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
        durationMs: result.durationMs,
        stdoutDigest: sha256(result.stdout),
        stderrDigest: sha256(result.stderr),
      };
      excerpts[command.label] = {
        stdout: excerpt(result.stdout),
        stderr: excerpt(result.stderr),
      };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(parallelism, commands.length) }, worker),
  );

  const testResult = await sink.recordArtifact({
    step,
    role: "test_result",
    bytes: new TextEncoder().encode(canonicalizeJson({ commands: records })),
    mediaType: "application/json",
  });
  const allPassed = records.every(
    (record) => record.exitCode === 0 && !record.timedOut,
  );
  return { records, excerpts, testResult, allPassed };
}

export type VerificationVerdict = "PASS" | "FAIL" | "PARTIAL";

/**
 * Parse the adversarial verification agent's terminal `VERDICT:` line
 * (VERIFICATION_SYSTEM_PROMPT contract). The LAST verdict line wins; a
 * missing or malformed verdict is `undefined` and callers MUST treat it as
 * a failure — never as an implicit pass.
 */
export function parseVerificationVerdict(
  text: string,
): VerificationVerdict | undefined {
  let verdict: VerificationVerdict | undefined;
  for (const line of text.split("\n")) {
    const match = /^\s*VERDICT:\s*(PASS|FAIL|PARTIAL)\b/.exec(line.trim());
    if (match !== null) verdict = match[1] as VerificationVerdict;
  }
  return verdict;
}
