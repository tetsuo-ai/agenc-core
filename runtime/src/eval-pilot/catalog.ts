import path from "node:path";
import type { SuiteManifestDocument } from "../eval-contract/index.js";
import {
  assertStableDirectory,
  decodeStrictJson,
  isWithinRoot,
  loadArtifact,
  openStableDirectory,
  readBoundedRegularFile,
} from "./safe-io.js";
import {
  EVALUATION_PILOT_MAXIMUM_DOCUMENT_BYTES,
  type ValidatedEvaluationPilotCatalog,
} from "./types.js";
import {
  EvaluationPilotValidationError,
  getEvaluationPilotRequiredArtifacts,
  validateEvaluationPilotCurationDocument,
  validateEvaluationPilotEvidenceDocuments,
  type EvaluationPilotEvidenceDocuments,
} from "./validation.js";

export interface LoadEvaluationPilotCatalogOptions {
  /** Existing, independently loaded evaluation suite manifest to bind. */
  readonly suiteManifest: SuiteManifestDocument;
  /** Root containing the fixed `cas/sha256/<hex>` layout. */
  readonly casRoot: string;
}

export async function loadAndValidateEvaluationPilotCatalog(
  curationFile: string,
  options: LoadEvaluationPilotCatalogOptions,
): Promise<ValidatedEvaluationPilotCatalog> {
  const curationPath = path.resolve(curationFile);
  const curationBytes = await readBoundedRegularFile(
    curationPath,
    EVALUATION_PILOT_MAXIMUM_DOCUMENT_BYTES,
  );
  const curationValue = decodeStrictJson(curationBytes, curationPath);
  const document = validateEvaluationPilotCurationDocument(
    curationValue,
    options.suiteManifest,
  );

  const casRoot = await openStableDirectory(options.casRoot, "CAS root");
  const casDirectory = await openStableDirectory(path.join(casRoot.canonicalPath, "cas"), "CAS directory");
  const shaDirectory = await openStableDirectory(
    path.join(casDirectory.canonicalPath, "sha256"),
    "CAS SHA-256 directory",
  );
  if (!isWithinRoot(casRoot.canonicalPath, casDirectory.canonicalPath) ||
      !isWithinRoot(casDirectory.canonicalPath, shaDirectory.canonicalPath)) {
    throw new EvaluationPilotValidationError(["CAS layout resolves outside its declared root"]);
  }

  const parsedArtifacts = new Map<string, unknown>();
  const loadedArtifacts = new Map<string, Uint8Array>();
  for (const { role, taskId, artifact } of getEvaluationPilotRequiredArtifacts(
    document,
    options.suiteManifest,
  )) {
    const bytes = loadedArtifacts.get(artifact.digest) ??
      await loadArtifact(shaDirectory.canonicalPath, artifact);
    if (bytes.byteLength !== artifact.sizeBytes) {
      throw new EvaluationPilotValidationError([
        `${artifact.digest} has ${bytes.byteLength} bytes; expected ${artifact.sizeBytes}`,
      ]);
    }
    loadedArtifacts.set(artifact.digest, bytes);
    if (artifact.mediaType === "application/json") {
      parsedArtifacts.set(
        artifact.digest,
        decodeStrictJson(bytes, `${taskId ?? "dataset"}.${role}:${artifact.digest}`),
      );
    }
  }
  await assertStableDirectory(shaDirectory, "CAS SHA-256 directory");
  await assertStableDirectory(casDirectory, "CAS directory");
  await assertStableDirectory(casRoot, "CAS root");

  const taskEvidence = new Map<
    string,
    {
      readonly sourceRow: unknown;
      readonly upstreamTriplePreflight: unknown;
      readonly independentSolveReview: unknown;
      readonly negativePatchReview: unknown;
      readonly stressorEvidence: unknown;
    }
  >();
  for (const task of document.tasks) {
    taskEvidence.set(task.taskId, {
      sourceRow: parsedArtifacts.get(task.source.row.digest),
      upstreamTriplePreflight: parsedArtifacts.get(task.qa.upstreamTriplePreflight.digest),
      independentSolveReview: parsedArtifacts.get(task.qa.independentSolveReview.digest),
      negativePatchReview: parsedArtifacts.get(task.qa.negativePatchReview.digest),
      stressorEvidence: parsedArtifacts.get(task.qa.stressorEvidence.digest),
    });
  }
  const evidence: EvaluationPilotEvidenceDocuments = {
    licenseEvidence: parsedArtifacts.get(document.sourceDataset.license.evidence.digest),
    taskEvidence,
  };
  return validateEvaluationPilotEvidenceDocuments(document, options.suiteManifest, evidence);
}
