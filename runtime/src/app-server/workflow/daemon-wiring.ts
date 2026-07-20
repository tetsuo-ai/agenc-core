/**
 * M5 Phase 5 — daemon-side wiring for the verified-change workflow
 * controller.
 *
 * Wires every controller seam with real daemon services:
 *   - per-run durability repositories resolved from the run's OWN
 *     repository path (journal projection and controller reads share one
 *     state database; the Phase 4 primary-cwd repository stays the
 *     default),
 *   - the REAL execution-admission kernel (`bindClient` per workflow run),
 *   - a REAL per-run evidence ledger over the eval-contract ledger
 *     (`<agencHome>/run-evidence/<runId>/`, `artifact.recorded` events,
 *     local integrity-only anchoring),
 *   - the session-coupled seams (rollout journal, worktree/command broker,
 *     child-agent spawner, reviewer invoker) backed by ONE
 *     `bootstrapLocalRuntimeSession`-owned daemon session per run — see
 *     `session-adapters.ts`.
 *
 * `resumeOpenWorkflows()` sweeps every known project state database so a
 * daemon restarted in a different cwd still resumes runs it started for
 * other repositories.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

import type { AuthBackend } from "../../auth/backend.js";
import type { ExecutionAdmissionKernel } from "../../budget/execution-admission-kernel.js";
import {
  appendEvidenceEvent,
  EvidenceLedgerError,
  initializeEvidenceLedger,
  inspectEvidenceLedger,
  sealEvidenceLedger,
  type EvidenceAnchorProvider,
} from "../../eval-contract/evidence-ledger.js";
import { sha256Digest } from "../../eval-contract/canonical-json.js";
import { canonicalizeJson } from "../../eval-contract/canonical-json.js";
import type { Sha256Digest } from "../../eval-contract/types.js";
import {
  openStateDatabasePaths,
  resolveStateDatabasePaths,
  type StateDatabasePaths,
  type StateSqliteDriver,
} from "../../state/sqlite-driver.js";
import { StateRunDurabilityRepository } from "../../state/run-durability.js";
import type {
  RunArtifactPointer,
  RunStepIdentity,
  WorkflowSpec,
} from "../../contracts/run-contracts.js";
import { computeSpecDigest } from "../../workflow/evidence-record.js";
import {
  VerifiedChangeWorkflowController,
  type WorkflowDurabilityContext,
  type WorkflowEvidenceLedger,
} from "./verified-change-controller.js";
import { readWorkflowStepEvidence } from "./steps.js";
import {
  createWorkflowSessionSeams,
  type WorkflowSessionSeams,
  type WorkflowSessionSeamsOptions,
} from "./session-adapters.js";

const WORKFLOW_TASK_ID = "verified-change";
const WORKFLOW_SYSTEM_ID = "agenc.workflow.m5";
const WORKFLOW_PRODUCER = {
  identity: "agenc-daemon-workflow",
  version: "1",
  binaryDigest: sha256Digest("agenc-daemon-workflow.v1"),
} as const;
const REDACTION_POLICY_DIGEST = sha256Digest(
  "agenc.workflow.m5.no-redaction.v1",
);

function sanitizeIdentifierPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "-");
}

/**
 * Integrity-only local anchor for the per-run workflow evidence ledger.
 * Keyed by a per-daemon-home secret so a seal cannot be silently reforged
 * by editing ledger files, but NOT externally anchored — external anchoring
 * remains an explicit later concern.
 */
async function loadLocalAnchorProvider(
  evidenceRoot: string,
): Promise<EvidenceAnchorProvider> {
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const secretPath = path.join(evidenceRoot, "local-anchor-secret");
  let secret: Uint8Array;
  try {
    secret = await readFile(secretPath);
  } catch {
    secret = randomBytes(32);
    await writeFile(secretPath, secret, { mode: 0o600, flag: "wx" }).catch(
      async () => {
        secret = await readFile(secretPath);
      },
    );
  }
  const anchorPolicyDigest = sha256Digest("agenc.workflow.m5.local-anchor.v1");
  const verifierDigest = sha256Digest("agenc.workflow.m5.local-anchor-verifier.v1");
  const verificationMaterialDigest = sha256Digest(secret);
  const signatureFor = (bytes: Uint8Array): Sha256Digest => {
    const joined = new Uint8Array(secret.byteLength + bytes.byteLength);
    joined.set(secret, 0);
    joined.set(bytes, secret.byteLength);
    return sha256Digest(joined);
  };
  return {
    anchorPolicyDigest,
    verifierDigest,
    async anchor(statementBytes, statementDigest) {
      return {
        statementDigest,
        anchorPolicyDigest,
        signatureAlgorithm: "ed25519",
        signatureDigest: signatureFor(statementBytes),
        verificationMaterialDigest,
        // The seal schema requires an https URI; the reserved `.invalid`
        // TLD makes the local-only (non-fetchable) anchoring explicit.
        anchorUri: `https://local-anchor.agenc-daemon.invalid/${statementDigest.slice("sha256:".length)}`,
        signerIdentity: "agenc-daemon-local-anchor",
      };
    },
    verify(statementBytes, receipt) {
      return (
        receipt.signatureDigest === signatureFor(statementBytes) &&
        receipt.verificationMaterialDigest === verificationMaterialDigest
      );
    },
  };
}

/**
 * Real per-run workflow evidence ledger over the eval-contract ledger.
 * Artifacts are `artifact.recorded` events with the payload bytes in the
 * ledger's CAS; append and seal are crash-idempotent (dedupe by derived
 * event id; seal reuses a persisted `sealedAt` and the ledger's stored
 * seal recovery).
 */
export function createDaemonWorkflowEvidenceLedgerFactory(options: {
  readonly agencHome: string;
}): (spec: WorkflowSpec) => Promise<WorkflowEvidenceLedger> {
  const evidenceRoot = path.join(options.agencHome, "run-evidence");
  return async (spec: WorkflowSpec): Promise<WorkflowEvidenceLedger> => {
    const root = path.join(evidenceRoot, sanitizeIdentifierPart(spec.runId));
    await mkdir(root, { recursive: true, mode: 0o700 });
    const access = { root };
    const context = {
      runId: spec.runId,
      contractDigest: computeSpecDigest(spec),
      taskId: WORKFLOW_TASK_ID,
      systemId: WORKFLOW_SYSTEM_ID,
    };
    try {
      await initializeEvidenceLedger(access, spec.runId);
    } catch (error) {
      if (
        !(error instanceof EvidenceLedgerError) ||
        error.code !== "EVIDENCE_ALREADY_EXISTS"
      ) {
        throw error;
      }
    }
    let inspection = await inspectEvidenceLedger(access, spec.runId);
    const state = {
      eventCount: inspection.eventCount,
      headEventDigest:
        inspection.headEventDigest ?? sha256Digest("empty-ledger"),
      sealed: inspection.terminal,
      lastOccurredAt:
        inspection.events.at(-1)?.occurredAt ?? new Date(0).toISOString(),
      knownEvents: new Map(
        inspection.events.map((event) => [event.eventId, event]),
      ),
    };
    const nextOccurredAt = (): string => {
      const now = new Date().toISOString();
      return now >= state.lastOccurredAt ? now : state.lastOccurredAt;
    };
    const append = async (input: {
      eventId: string;
      type: "run.started" | "artifact.recorded" | "run.finished";
      mediaType: string;
      payloadBytes: Uint8Array;
    }) => {
      const known = state.knownEvents.get(input.eventId);
      if (known !== undefined) return known;
      const result = await appendEvidenceEvent({
        ...access,
        event: {
          ...context,
          eventId: input.eventId,
          occurredAt: nextOccurredAt(),
          producer: WORKFLOW_PRODUCER,
          type: input.type,
          mediaType: input.mediaType,
          redactionPolicyDigest: REDACTION_POLICY_DIGEST,
        },
        payloadBytes: input.payloadBytes,
      });
      state.knownEvents.set(result.event.eventId, result.event);
      if (result.status === "appended") {
        state.eventCount += 1;
        state.headEventDigest = result.event.eventDigest;
        state.lastOccurredAt = result.event.occurredAt;
      }
      return result.event;
    };
    if (state.eventCount === 0) {
      await append({
        eventId: "run.started",
        type: "run.started",
        mediaType: "application/json",
        payloadBytes: new TextEncoder().encode(canonicalizeJson(spec)),
      });
    }
    const sealedAtPath = path.join(root, "workflow-sealed-at");
    return {
      async recordArtifact(input: {
        readonly step: RunStepIdentity;
        readonly role: RunArtifactPointer["role"];
        readonly bytes: Uint8Array;
        readonly mediaType: string;
      }): Promise<RunArtifactPointer> {
        const digest = sha256Digest(input.bytes);
        const hex = digest.slice("sha256:".length);
        const eventId = sanitizeIdentifierPart(
          `artifact.${input.step.stepId}.${input.role}.${hex.slice(0, 24)}`,
        );
        const event = await append({
          eventId,
          type: "artifact.recorded",
          mediaType: input.mediaType,
          payloadBytes: input.bytes,
        });
        return {
          step: input.step,
          role: input.role,
          digest: digest as `sha256:${string}`,
          bytes: input.bytes.byteLength,
          storagePath: event.payload.uri,
          recordedAt: event.occurredAt,
        };
      },
      head() {
        return {
          eventCount: state.eventCount,
          headEventDigest: state.headEventDigest,
          sealed: state.sealed,
        };
      },
      async readArtifact(pointer: RunArtifactPointer): Promise<Uint8Array> {
        const hex = pointer.digest.slice("sha256:".length);
        for (const entry of await readdir(root)) {
          if (!entry.endsWith(".payloads")) continue;
          return readFile(path.join(root, entry, `sha256-${hex}.bin`));
        }
        throw new Error(`workflow evidence payload not found: ${pointer.digest}`);
      },
      async seal(sealedAt: string): Promise<{ sealDigest: string }> {
        // The eval-contract ledger only seals a ledger whose LAST event is
        // the terminal `run.finished`; append it first (idempotent by event
        // id, deterministic payload).
        await append({
          eventId: "run.finished",
          type: "run.finished",
          mediaType: "application/json",
          payloadBytes: new TextEncoder().encode(
            canonicalizeJson({ runId: spec.runId }),
          ),
        });
        // The frozen seal timestamp must not predate the terminal event
        // (the requested sealedAt was captured just before the append, so
        // clamp across a millisecond boundary), and a crash-resumed seal
        // must converge on the identical frozen statement — reuse the
        // first persisted choice.
        const terminalAt = state.lastOccurredAt;
        let effectiveSealedAt = sealedAt >= terminalAt ? sealedAt : terminalAt;
        try {
          effectiveSealedAt = (await readFile(sealedAtPath, "utf8")).trim();
        } catch {
          await writeFile(sealedAtPath, `${effectiveSealedAt}\n`, {
            mode: 0o600,
          });
        }
        const anchorProvider = await loadLocalAnchorProvider(evidenceRoot);
        const seal = await sealEvidenceLedger({
          ...access,
          context,
          sealedAt: effectiveSealedAt,
          anchorProvider,
        });
        state.sealed = true;
        inspection = await inspectEvidenceLedger(access, spec.runId);
        state.eventCount = inspection.eventCount;
        state.headEventDigest =
          inspection.headEventDigest ?? state.headEventDigest;
        return { sealDigest: seal.sealDigest };
      },
      async persistRecord(record): Promise<void> {
        await writeFile(
          path.join(root, "verified-change-record.json"),
          `${canonicalizeJson(record)}\n`,
          { mode: 0o600 },
        );
      },
    };
  };
}

export interface DaemonWorkflowWiring {
  readonly controller: VerifiedChangeWorkflowController;
  /**
   * D3 startup recovery across every known project state database (a run
   * journals into its OWN repository's project database, which need not be
   * the daemon's primary one).
   */
  resumeOpenWorkflows(): Promise<readonly string[]>;
  close(): void;
}

export function createDaemonWorkflowController(options: {
  readonly agencHome: string;
  readonly primaryCwd: string;
  readonly kernel: ExecutionAdmissionKernel;
  readonly warn: (message: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly authBackend?: AuthBackend;
  /**
   * Fresh discovery of project state databases owned by this daemon home
   * (`run.start` may target any repository; resume must sweep them all).
   * Defaults to just the primary cwd's database.
   */
  readonly stateDatabasePaths?: () => readonly StateDatabasePaths[];
  /** Test seam: inject scripted session seams instead of real bootstraps. */
  readonly sessionSeams?: WorkflowSessionSeams;
  /** Test seam forwarded to the session adapters' bootstrap. */
  readonly bootstrap?: WorkflowSessionSeamsOptions["bootstrap"];
}): DaemonWorkflowWiring {
  const opened = new Map<
    string,
    { readonly driver: StateSqliteDriver; readonly repository: StateRunDurabilityRepository }
  >();
  const repoForPaths = (
    paths: StateDatabasePaths,
  ): StateRunDurabilityRepository => {
    const existing = opened.get(paths.stateDbPath);
    if (existing !== undefined) return existing.repository;
    const driver = openStateDatabasePaths(paths);
    const repository = new StateRunDurabilityRepository(driver);
    opened.set(paths.stateDbPath, { driver, repository });
    return repository;
  };
  const primaryPaths = resolveStateDatabasePaths({
    cwd: options.primaryCwd,
    agencHome: options.agencHome,
  });
  const candidatePaths = (): readonly StateDatabasePaths[] => {
    const all = [primaryPaths, ...(options.stateDatabasePaths?.() ?? [])];
    const seen = new Set<string>();
    const unique: StateDatabasePaths[] = [];
    for (const paths of all) {
      if (seen.has(paths.stateDbPath)) continue;
      seen.add(paths.stateDbPath);
      if (
        paths.stateDbPath !== primaryPaths.stateDbPath &&
        !existsSync(paths.stateDbPath)
      ) {
        continue;
      }
      unique.push(paths);
    }
    return unique;
  };
  /** Repository the current resume sweep is scoped to (see resumeOpenWorkflows). */
  let activeResumePaths: StateDatabasePaths | undefined;
  const durability = (
    context?: WorkflowDurabilityContext,
  ): StateRunDurabilityRepository => {
    if (context?.repoPath !== undefined) {
      return repoForPaths(
        resolveStateDatabasePaths({
          cwd: context.repoPath,
          agencHome: options.agencHome,
        }),
      );
    }
    if (context?.runId !== undefined) {
      for (const paths of candidatePaths()) {
        const repository = repoForPaths(paths);
        if (
          repository.getEffect(context.runId, "workflow.intake") !==
            undefined ||
          repository.getCurrentTerminalResult(context.runId) !== undefined
        ) {
          return repository;
        }
      }
    }
    return repoForPaths(activeResumePaths ?? primaryPaths);
  };
  const resolveRunRepoPath = (runId: string): string | undefined => {
    const intake = durability({ runId }).getEffect(runId, "workflow.intake");
    if (intake === undefined) return undefined;
    const spec = readWorkflowStepEvidence(intake).spec as
      | WorkflowSpec
      | undefined;
    return spec?.repoPath;
  };
  const seams =
    options.sessionSeams ??
    createWorkflowSessionSeams({
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.authBackend !== undefined
        ? { authBackend: options.authBackend }
        : {}),
      kernel: options.kernel,
      durability,
      resolveRunRepoPath,
      fallbackCwd: options.primaryCwd,
      warn: options.warn,
      ...(options.bootstrap !== undefined
        ? { bootstrap: options.bootstrap }
        : {}),
    });
  const controller = new VerifiedChangeWorkflowController({
    durability,
    admission: ({ runId, sessionId, workspaceId, spec }) =>
      options.kernel.bindClient({
        cwd: spec.repoPath,
        budgetIdentity: runId,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        scope: {
          runId,
          sessionId,
          autonomous: true,
          ...(spec.budget.maxCostUsd !== undefined
            ? { maxCostUsd: spec.budget.maxCostUsd, hasHardCostCap: true }
            : {}),
          ...(spec.budget.maxTokens !== undefined
            ? { maxTokens: spec.budget.maxTokens, hasHardTokenCap: true }
            : {}),
          ...(spec.budget.deadlineAt !== undefined
            ? { deadlineAt: spec.budget.deadlineAt }
            : {}),
        },
      }),
    evidenceLedger: createDaemonWorkflowEvidenceLedgerFactory({
      agencHome: options.agencHome,
    }),
    journal: seams.journal,
    worktrees: seams.worktrees,
    commands: seams.commands,
    spawner: seams.spawner,
    reviewer: seams.reviewer,
    warn: options.warn,
  });
  return {
    controller,
    resumeOpenWorkflows: async () => {
      const resumed: string[] = [];
      // Sequential sweep: `durability()` (no context) is scoped to the
      // database currently being resumed so the controller's enumeration
      // sees each project exactly once.
      for (const paths of candidatePaths()) {
        activeResumePaths = paths;
        try {
          resumed.push(...(await controller.resumeOpenWorkflows()));
        } finally {
          activeResumePaths = undefined;
        }
      }
      return resumed;
    },
    close: () => {
      void seams.close().catch((error) => {
        options.warn(
          `workflow session seams close failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      for (const entry of opened.values()) {
        entry.driver.close();
      }
      opened.clear();
    },
  };
}
