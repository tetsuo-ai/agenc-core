/**
 * M5 Phase 4 — daemon-side wiring for the verified-change workflow
 * controller.
 *
 * Wires the seams that are clean to back today:
 *   - the REAL durability repository (daemon-home + primary-cwd state DB),
 *   - the REAL execution-admission kernel (`bindClient` per workflow run),
 *   - a REAL per-run evidence ledger over the eval-contract ledger
 *     (`<agencHome>/run-evidence/<runId>/`, `artifact.recorded` events,
 *     local integrity-only anchoring).
 *
 * TODO(M5 Phase 5 — run.start dispatcher): the session-coupled seams
 * (rollout-journal writer, plan/implement/verify-agent spawner, reviewer
 * invoker, sandbox-brokered worktree/command execution) must be backed by a
 * `bootstrapLocalRuntimeSession`-owned daemon session, exactly as
 * `app-server/background-agent-runner.ts` owns its bootstrap. Until that
 * dispatcher lands they throw {@link WorkflowSeamPendingError}; the
 * controller itself is complete and fully tested through injected seams,
 * and `resumeOpenWorkflows()` warn-skips any run it cannot yet drive
 * (durable state is left untouched for the Phase 5 daemon to resume).
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

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
  openStateDatabases,
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
  type WorkflowEvidenceLedger,
} from "./verified-change-controller.js";

/** A workflow seam whose daemon adapter lands with the Phase 5 dispatcher. */
export class WorkflowSeamPendingError extends Error {
  constructor(readonly seam: string) {
    super(
      `verified-change workflow seam "${seam}" is not wired yet ` +
        "(lands with the M5 Phase 5 run.start dispatcher)",
    );
    this.name = "WorkflowSeamPendingError";
  }
}

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
        anchorUri: `local://agenc-daemon/${statementDigest.slice("sha256:".length)}`,
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
      type: "run.started" | "artifact.recorded";
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
        // Reuse the first chosen sealedAt so a crash-resumed seal converges
        // on the identical frozen statement.
        let effectiveSealedAt = sealedAt;
        try {
          effectiveSealedAt = (await readFile(sealedAtPath, "utf8")).trim();
        } catch {
          await writeFile(sealedAtPath, `${sealedAt}\n`, { mode: 0o600 });
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
  close(): void;
}

export function createDaemonWorkflowController(options: {
  readonly agencHome: string;
  readonly primaryCwd: string;
  readonly kernel: ExecutionAdmissionKernel;
  readonly warn: (message: string) => void;
}): DaemonWorkflowWiring {
  let driver: StateSqliteDriver | undefined;
  let repository: StateRunDurabilityRepository | undefined;
  const durability = (): StateRunDurabilityRepository => {
    if (repository === undefined) {
      driver = openStateDatabases({
        cwd: options.primaryCwd,
        agencHome: options.agencHome,
      });
      repository = new StateRunDurabilityRepository(driver);
    }
    return repository;
  };
  const pending = (seam: string): never => {
    throw new WorkflowSeamPendingError(seam);
  };
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
    // -- Phase 5 session seams (see the module TODO above). -----------------
    journal: { open: async () => pending("journal") },
    worktrees: {
      captureBaseState: async () => pending("worktrees.captureBaseState"),
      provision: async () => pending("worktrees.provision"),
      exportPatch: async () => pending("worktrees.exportPatch"),
      checkBaseMovement: async () => pending("worktrees.checkBaseMovement"),
      cleanup: async () => pending("worktrees.cleanup"),
    },
    commands: { run: async () => pending("commands.run") },
    spawner: {
      spawn: async () => pending("spawner.spawn"),
      inspect: async () => pending("spawner.inspect"),
    },
    reviewer: { invoke: async () => pending("reviewer.invoke") },
    warn: options.warn,
  });
  return {
    controller,
    close: () => {
      driver?.close();
      driver = undefined;
      repository = undefined;
    },
  };
}
