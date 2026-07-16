import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeDocumentDigest,
  digestDomainSeparated,
  projectTaskForAgent,
  sha256Digest,
  withDocumentDigest,
  type ContentArtifact,
  type OperatorTaskDocument,
  type SuiteManifestDocument,
} from "../../src/eval-contract/index.js";
import {
  EVALUATION_PILOT_CATEGORIES,
  EVALUATION_PILOT_MAXIMUM_DOCUMENT_BYTES,
  EVALUATION_PILOT_STRESSORS,
  EvaluationPilotValidationError,
  computeEvaluationPilotArtifactSetDigest,
  computeEvaluationPilotSelectedRowsDigest,
  getEvaluationPilotRequiredArtifacts,
  loadAndValidateEvaluationPilotCatalog,
  projectEvaluationPilotTaskForAgent,
  validateEvaluationPilotCurationDocument,
  validateEvaluationPilotEvidenceDocuments,
  type EvaluationPilotCurationDocument,
  type EvaluationPilotEvidenceDocuments,
  type EvaluationPilotTaskCuration,
} from "../../src/eval-pilot/index.js";
import { FIXED_TIME, digest, makeOperatorTask } from "./evaluation-contract-fixtures.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface PilotFixture {
  readonly document: EvaluationPilotCurationDocument;
  readonly suite: SuiteManifestDocument;
  readonly blobs: ReadonlyMap<string, Uint8Array>;
  readonly evidence: EvaluationPilotEvidenceDocuments;
}

interface MutablePilotFixture {
  document: EvaluationPilotCurationDocument;
  suite: SuiteManifestDocument;
  blobs: Map<string, Uint8Array>;
  evidence: EvaluationPilotEvidenceDocuments;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resignContract<T extends { readonly documentDigest: string }>(
  value: T,
  mutate: (draft: Record<string, unknown>) => void,
): T {
  const draft = jsonClone(value) as unknown as Record<string, unknown>;
  delete draft.documentDigest;
  mutate(draft);
  return withDocumentDigest<T>(draft as Omit<T, "documentDigest">);
}

function artifactForBytes(
  blobs: Map<string, Uint8Array>,
  bytes: Uint8Array,
  mediaType: string,
): ContentArtifact {
  const digestValue = sha256Digest(bytes);
  blobs.set(digestValue, bytes);
  return {
    digest: digestValue,
    sizeBytes: bytes.byteLength,
    mediaType,
    uri: `cas://sha256/${digestValue.slice("sha256:".length)}`,
  };
}

function jsonArtifact(
  blobs: Map<string, Uint8Array>,
  value: unknown,
): ContentArtifact {
  return artifactForBytes(blobs, Buffer.from(JSON.stringify(value), "utf8"), "application/json");
}

function buildSuite(
  blobs: Map<string, Uint8Array>,
  repositoryFamilyCount = 15,
  publicIssue = true,
  sharedZeroByteSetup = false,
): SuiteManifestDocument {
  const tasks = Array.from({ length: 30 }, (_, index) => {
    const base = makeOperatorTask(index, "development");
    return resignContract(base, (draft) => {
      const repository = draft.repository as Record<string, unknown>;
      repository.cluster = `family-${Math.floor(index * repositoryFamilyCount / 30)}`;
      draft.setupPatch = artifactForBytes(
        blobs,
        Buffer.from(sharedZeroByteSetup ? "" : `setup patch ${index}\n`, "utf8"),
        "text/x-diff",
      );
      const hiddenVerifier = draft.hiddenVerifier as Record<string, unknown>;
      hiddenVerifier.bundle = artifactForBytes(
        blobs,
        Buffer.from(`hidden verifier bundle ${index}\n`, "utf8"),
        "application/octet-stream",
      );
      const referenceSolution = draft.referenceSolution as Record<string, unknown>;
      referenceSolution.patch = artifactForBytes(
        blobs,
        Buffer.from(`reference solution patch ${index}\n`, "utf8"),
        "text/x-diff",
      );
      referenceSolution.validationEvidence = artifactForBytes(
        blobs,
        Buffer.from(JSON.stringify({ task: index, validated: true }), "utf8"),
        "application/json",
      );
      if (!publicIssue) {
        const provenance = draft.provenance as Record<string, unknown>;
        provenance.sourceType = "synthetic_diagnostic";
      }
    });
  });
  const repositoryFamilies = Array.from({ length: repositoryFamilyCount }, (_, index) => {
    const members = tasks
      .filter((task) => task.repository.cluster === `family-${index}`)
      .map((task) => task.repository.uri);
    return {
      cluster: `family-${index}`,
      canonicalRepositoryUri: members[0],
      memberRepositoryUris: members,
    };
  });
  return withDocumentDigest<SuiteManifestDocument>({
    kind: "agenc.eval.suite-manifest",
    contractVersion: "1.0.0",
    suiteId: "public-development-pilot",
    suiteVersion: "1.0.0",
    split: "development",
    createdAt: FIXED_TIME,
    repositoryFamilies,
    tasks,
  });
}

function finalizePilotDocument(
  value: EvaluationPilotCurationDocument,
  suite: SuiteManifestDocument,
): EvaluationPilotCurationDocument {
  const draft = jsonClone(value) as unknown as Record<string, unknown>;
  delete draft.documentDigest;
  const sourceDataset = draft.sourceDataset as Record<string, unknown>;
  const selection = sourceDataset.selection as Record<string, unknown>;
  const tasks = draft.tasks as unknown as EvaluationPilotTaskCuration[];
  selection.selectedRowsDigest = computeEvaluationPilotSelectedRowsDigest(tasks);
  const placeholder = {
    ...draft,
    documentDigest: `sha256:${"0".repeat(64)}`,
  } as unknown as EvaluationPilotCurationDocument;
  const cas = draft.cas as Record<string, unknown>;
  cas.requiredArtifactSetDigest = computeEvaluationPilotArtifactSetDigest(placeholder, suite);
  return withDocumentDigest<EvaluationPilotCurationDocument>(
    draft as unknown as Omit<EvaluationPilotCurationDocument, "documentDigest">,
  );
}

function buildPilotFixture(options: {
  repositoryFamilyCount?: number;
  publicIssue?: boolean;
  sharedZeroByteSetup?: boolean;
} = {}): PilotFixture {
  const blobs = new Map<string, Uint8Array>();
  const suite = buildSuite(
    blobs,
    options.repositoryFamilyCount ?? 15,
    options.publicIssue ?? true,
    options.sharedZeroByteSetup ?? false,
  );
  const datasetId = "swe-live-public-development";
  const revision = "2026-07-15-release";
  const revisionDigest = digestDomainSeparated("agenc.eval.pilot-dataset-revision.v1", revision);
  const spdxIdentifier = "MIT";
  const licenseEvidence = {
    kind: "agenc.eval.pilot-license-evidence",
    evidenceVersion: "1.0.0",
    datasetId,
    datasetRevisionDigest: revisionDigest,
    spdxIdentifier,
    reviewStatus: "confirmed",
  };
  const licenseArtifact = jsonArtifact(blobs, licenseEvidence);
  const selectionImplementation = artifactForBytes(
    blobs,
    Buffer.from("export const select = rows => rows;\n", "utf8"),
    "application/javascript",
  );
  const joinedEvidence = new Map<string, {
    readonly sourceRow: unknown;
    readonly upstreamTriplePreflight: unknown;
    readonly independentSolveReview: unknown;
    readonly negativePatchReview: unknown;
  }>();

  const tasks = suite.tasks.map((task, index): EvaluationPilotTaskCuration => {
    const sourceRow = {
      kind: "agenc.eval.pilot-source-row",
      evidenceVersion: "1.0.0",
      datasetId,
      datasetRevisionDigest: revisionDigest,
      rowId: `row-${index}`,
      taskId: task.taskId,
      operatorTaskDigest: task.documentDigest,
      repositoryUri: task.repository.uri,
      repositoryCommit: task.repository.commit,
      issueDigest: task.issue.digest,
      licenseSpdxIdentifier: spdxIdentifier,
    };
    const preflight = {
      kind: "agenc.eval.pilot-upstream-triple-preflight",
      evidenceVersion: "1.0.0",
      taskId: task.taskId,
      operatorTaskDigest: task.documentDigest,
      status: "complete",
      runs: [1, 2, 3].map((runIndex) => ({
        runIndex,
        coldRebuild: true,
        baseFailsTargetChecks: true,
        basePassesRegressionChecks: true,
        referencePassesAllChecks: true,
        environmentDigest: digest(`${task.taskId}:environment:${runIndex}`),
        evidenceDigest: digest(`${task.taskId}:preflight:${runIndex}`),
      })),
    };
    const independentSolve = {
      kind: "agenc.eval.pilot-independent-solve-review",
      evidenceVersion: "1.0.0",
      taskId: task.taskId,
      operatorTaskDigest: task.documentDigest,
      status: "complete",
      reviewerIdentityDigest: digest(`${task.taskId}:independent-reviewer`),
      reviewerIndependentOfTaskAuthor: true,
      verifierInaccessibleDuringSolve: true,
      startedFromPinnedBase: true,
      solutionPatchDigest: digest(`${task.taskId}:independent-solution`),
      solutionAccepted: true,
      reviewEvidenceDigest: digest(`${task.taskId}:independent-review`),
    };
    const negativePatches = {
      kind: "agenc.eval.pilot-negative-patch-review",
      evidenceVersion: "1.0.0",
      taskId: task.taskId,
      operatorTaskDigest: task.documentDigest,
      status: "complete",
      reviewerIdentityDigest: digest(`${task.taskId}:negative-reviewer`),
      reviewerIndependentOfTaskAuthor: true,
      implementationIndependenceReviewed: true,
      allNegativePatchesRejected: true,
      negativePatches: [
        {
          patchDigest: digest(`${task.taskId}:incomplete-patch`),
          rejectionEvidenceDigest: digest(`${task.taskId}:incomplete-rejection`),
          failureClass: "incomplete_fix",
        },
        {
          patchDigest: digest(`${task.taskId}:overfit-patch`),
          rejectionEvidenceDigest: digest(`${task.taskId}:overfit-rejection`),
          failureClass: "overfit_fix",
        },
      ],
    };
    joinedEvidence.set(task.taskId, {
      sourceRow,
      upstreamTriplePreflight: preflight,
      independentSolveReview: independentSolve,
      negativePatchReview: negativePatches,
    });
    const sourceArtifact = jsonArtifact(blobs, sourceRow);
    return {
      taskId: task.taskId,
      operatorTaskDigest: task.documentDigest,
      repositoryFamily: task.repository.cluster,
      eligibility: "development_public_issue_eligible",
      category: EVALUATION_PILOT_CATEGORIES[index % EVALUATION_PILOT_CATEGORIES.length],
      stressors: [EVALUATION_PILOT_STRESSORS[index % EVALUATION_PILOT_STRESSORS.length]],
      selectionKeyDigest: digest(`selection-key:${index}`),
      source: {
        rowId: `row-${index}`,
        rowDigest: sourceArtifact.digest,
        row: sourceArtifact,
      },
      qa: {
        upstreamTriplePreflight: jsonArtifact(blobs, preflight),
        independentSolveReview: jsonArtifact(blobs, independentSolve),
        negativePatchReview: jsonArtifact(blobs, negativePatches),
      },
    };
  }).sort((left, right) => left.selectionKeyDigest.localeCompare(right.selectionKeyDigest));

  const unsigned = {
    kind: "agenc.eval.development-pilot-curation",
    pilotProtocolVersion: "1.0.0",
    createdAt: FIXED_TIME,
    suite: {
      suiteId: suite.suiteId,
      suiteVersion: suite.suiteVersion,
      manifestDigest: suite.documentDigest,
      split: "development",
      taskCount: 30,
    },
    cas: {
      layout: "cas/sha256/<hex>",
      digestAlgorithm: "sha256",
      requiredArtifactSetDigest: `sha256:${"0".repeat(64)}`,
      maximumArtifactBytes: 16_777_216,
      maximumTotalArtifactBytes: 268_435_456,
    },
    sourceDataset: {
      datasetId,
      revision,
      revisionDigest,
      license: { spdxIdentifier, evidence: licenseArtifact },
      selection: {
        algorithm: "sha256_ranked_stratified_v1",
        algorithmVersion: "1.0.0",
        implementation: selectionImplementation,
        seedDigest: digest("pilot-selection-seed"),
        eligiblePopulationDigest: digest("pilot-eligible-population"),
        selectedRowsDigest: `sha256:${"0".repeat(64)}`,
        taskOrdering: "ascending_selection_key_digest",
        outcomeDataUsed: false,
      },
    },
    coverage: {
      categories: EVALUATION_PILOT_CATEGORIES,
      stressors: EVALUATION_PILOT_STRESSORS,
      minimumRepositoryFamilies: 15,
      maximumTasksPerRepositoryFamily: 2,
    },
    tasks,
  } as unknown as Omit<EvaluationPilotCurationDocument, "documentDigest">;
  const placeholder = {
    ...unsigned,
    documentDigest: `sha256:${"0".repeat(64)}`,
  } as EvaluationPilotCurationDocument;
  const withSelection = {
    ...placeholder,
    sourceDataset: {
      ...placeholder.sourceDataset,
      selection: {
        ...placeholder.sourceDataset.selection,
        selectedRowsDigest: computeEvaluationPilotSelectedRowsDigest(tasks),
      },
    },
  };
  const withArtifactSet = {
    ...withSelection,
    cas: {
      ...withSelection.cas,
      requiredArtifactSetDigest: computeEvaluationPilotArtifactSetDigest(withSelection, suite),
    },
  };
  const { documentDigest: _placeholderDigest, ...documentWithoutDigest } = withArtifactSet;
  const document = withDocumentDigest<EvaluationPilotCurationDocument>(documentWithoutDigest);
  return {
    document,
    suite,
    blobs,
    evidence: { licenseEvidence, taskEvidence: joinedEvidence },
  };
}

async function materializeFixture(fixture: PilotFixture): Promise<{ root: string; catalog: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenc-pilot-"));
  temporaryRoots.push(root);
  const casSha = path.join(root, "cas", "sha256");
  await mkdir(casSha, { recursive: true });
  for (const [artifactDigest, bytes] of fixture.blobs) {
    await writeFile(path.join(casSha, artifactDigest.slice("sha256:".length)), bytes);
  }
  const catalog = path.join(root, "pilot-curation.json");
  await writeFile(catalog, `${JSON.stringify(fixture.document)}\n`);
  return { root, catalog };
}

function mutateEvidence(
  fixture: PilotFixture,
  taskId: string,
  field: "sourceRow" | "upstreamTriplePreflight" | "independentSolveReview" | "negativePatchReview",
  mutate: (draft: Record<string, unknown>) => void,
): EvaluationPilotEvidenceDocuments {
  const taskEvidence = new Map(fixture.evidence.taskEvidence);
  const joined = taskEvidence.get(taskId);
  if (!joined) throw new Error(`missing test evidence ${taskId}`);
  const draft = jsonClone(joined[field]) as Record<string, unknown>;
  mutate(draft);
  taskEvidence.set(taskId, { ...joined, [field]: draft });
  return { licenseEvidence: fixture.evidence.licenseEvidence, taskEvidence };
}

function rebindLicenseArtifact(
  fixture: PilotFixture,
  bytes: Uint8Array,
): MutablePilotFixture {
  const mutable: MutablePilotFixture = {
    document: fixture.document,
    suite: fixture.suite,
    blobs: new Map(fixture.blobs),
    evidence: fixture.evidence,
  };
  const artifact = artifactForBytes(mutable.blobs, bytes, "application/json");
  const draft = jsonClone(fixture.document) as unknown as Record<string, unknown>;
  const sourceDataset = draft.sourceDataset as Record<string, unknown>;
  const license = sourceDataset.license as Record<string, unknown>;
  license.evidence = artifact;
  mutable.document = finalizePilotDocument(
    draft as unknown as EvaluationPilotCurationDocument,
    mutable.suite,
  );
  return mutable;
}

function replaceOperatorTask(
  fixture: PilotFixture,
  taskIndex: number,
  mutate: (draft: Record<string, unknown>) => void,
): PilotFixture {
  const operatorTask = resignContract(fixture.suite.tasks[taskIndex], mutate);
  const suite = resignContract(fixture.suite, (draft) => {
    const tasks = draft.tasks as unknown[];
    tasks[taskIndex] = operatorTask;
  });
  const documentDraft = jsonClone(fixture.document) as unknown as Record<string, unknown>;
  const suiteBinding = documentDraft.suite as Record<string, unknown>;
  suiteBinding.manifestDigest = suite.documentDigest;
  const curated = (documentDraft.tasks as Array<Record<string, unknown>>)
    .find((task) => task.taskId === operatorTask.taskId);
  if (!curated) throw new Error(`missing curated task ${operatorTask.taskId}`);
  curated.operatorTaskDigest = operatorTask.documentDigest;
  return {
    ...fixture,
    suite,
    document: finalizePilotDocument(
      documentDraft as unknown as EvaluationPilotCurationDocument,
      suite,
    ),
  };
}

describe("evaluation development pilot curation protocol", () => {
  it("binds exactly 30 public development issues across a diverse repository set", () => {
    const fixture = buildPilotFixture();
    const validated = validateEvaluationPilotCurationDocument(fixture.document, fixture.suite);
    expect(validated.tasks).toHaveLength(30);
    expect(new Set(validated.tasks.map((task) => task.repositoryFamily)).size).toBe(15);
    expect(Math.max(...[...new Set(validated.tasks.map((task) => task.repositoryFamily))]
      .map((family) => validated.tasks.filter((task) => task.repositoryFamily === family).length)))
      .toBe(2);
    expect(new Set(validated.tasks.map((task) => task.category))).toEqual(
      new Set(EVALUATION_PILOT_CATEGORIES),
    );
    expect(new Set(validated.tasks.flatMap((task) => task.stressors))).toEqual(
      new Set(EVALUATION_PILOT_STRESSORS),
    );
  });

  it("loads every content-addressed join and emits only the canonical agent task projection", async () => {
    const fixture = buildPilotFixture();
    const { root, catalog } = await materializeFixture(fixture);
    const loaded = await loadAndValidateEvaluationPilotCatalog(catalog, {
      suiteManifest: fixture.suite,
      casRoot: root,
    });
    expect(loaded.taskEvidence.size).toBe(30);
    expect(loaded.agentTasks).toHaveLength(30);
    const taskId = fixture.document.tasks[0].taskId;
    const projection = projectEvaluationPilotTaskForAgent(loaded, taskId);
    expect(projection).toEqual(projectTaskForAgent(loaded.operatorTasks.get(taskId)!));
    expect(Object.keys(projection).sort()).toEqual([
      "allowedTools",
      "budget",
      "contractVersion",
      "documentDigest",
      "environment",
      "expectedArtifacts",
      "issue",
      "kind",
      "networkPolicy",
      "permissionPolicy",
      "repository",
      "setupPatch",
      "taskId",
      "taskVersion",
      "verifierCommitment",
    ]);
    const projectedBytes = JSON.stringify(projection);
    const operatorTask = loaded.operatorTasks.get(taskId)!;
    for (const protectedArtifact of [
      operatorTask.hiddenVerifier.bundle,
      operatorTask.referenceSolution.patch,
      operatorTask.referenceSolution.validationEvidence,
    ]) {
      expect(projectedBytes).not.toContain(protectedArtifact.digest);
      expect(projectedBytes).not.toContain(protectedArtifact.uri);
    }
    for (const forbidden of [
      "hiddenVerifier",
      "referenceSolution",
      "provenance",
      "sourceDataset",
      "upstreamTriplePreflight",
      "independentSolveReview",
      "negativePatchReview",
      "selectionKeyDigest",
    ]) {
      expect(projectedBytes).not.toContain(forbidden);
    }
    expect(() => projectEvaluationPilotTaskForAgent(loaded, "not-curated")).toThrow(
      /not present in the validated pilot/u,
    );
  });

  it("commits and verifies every bound operator artifact while allowing shared empty setup patches", async () => {
    const fixture = buildPilotFixture({ sharedZeroByteSetup: true });
    const inventory = getEvaluationPilotRequiredArtifacts(fixture.document, fixture.suite);
    expect(inventory).toHaveLength(242);
    for (const role of [
      "operator_setup_patch",
      "operator_hidden_verifier_bundle",
      "operator_reference_solution_patch",
      "operator_reference_validation_evidence",
    ]) {
      expect(inventory.filter((entry) => entry.role === role)).toHaveLength(30);
    }
    const setupArtifacts = fixture.suite.tasks.map((task) => task.setupPatch);
    expect(new Set(setupArtifacts.map((artifact) => artifact.digest)).size).toBe(1);
    expect(setupArtifacts.every((artifact) => artifact.sizeBytes === 0)).toBe(true);

    const { root, catalog } = await materializeFixture(fixture);
    const loaded = await loadAndValidateEvaluationPilotCatalog(catalog, {
      suiteManifest: fixture.suite,
      casRoot: root,
    });
    expect(loaded.agentTasks).toHaveLength(30);
  });

  it("rejects missing, size-mismatched, digest-mismatched, and symlinked operator artifacts", async () => {
    const fixture = buildPilotFixture();
    const operator = fixture.suite.tasks[0];

    const missing = await materializeFixture(fixture);
    await rm(path.join(
      missing.root,
      "cas",
      "sha256",
      operator.hiddenVerifier.bundle.digest.slice("sha256:".length),
    ));
    await expect(loadAndValidateEvaluationPilotCatalog(missing.catalog, {
      suiteManifest: fixture.suite,
      casRoot: missing.root,
    })).rejects.toThrow(/ENOENT|no such file/u);

    const wrongSize = await materializeFixture(fixture);
    const patchPath = path.join(
      wrongSize.root,
      "cas",
      "sha256",
      operator.referenceSolution.patch.digest.slice("sha256:".length),
    );
    await writeFile(patchPath, Buffer.concat([await readFile(patchPath), Buffer.from("x")]));
    await expect(loadAndValidateEvaluationPilotCatalog(wrongSize.catalog, {
      suiteManifest: fixture.suite,
      casRoot: wrongSize.root,
    })).rejects.toThrow(/exceeds|expected/u);

    const wrongDigest = await materializeFixture(fixture);
    const evidencePath = path.join(
      wrongDigest.root,
      "cas",
      "sha256",
      operator.referenceSolution.validationEvidence.digest.slice("sha256:".length),
    );
    await writeFile(
      evidencePath,
      Buffer.alloc(operator.referenceSolution.validationEvidence.sizeBytes, 0x78),
    );
    await expect(loadAndValidateEvaluationPilotCatalog(wrongDigest.catalog, {
      suiteManifest: fixture.suite,
      casRoot: wrongDigest.root,
    })).rejects.toThrow(/content digest mismatch/u);

    if (process.platform !== "win32") {
      const symlinked = await materializeFixture(fixture);
      const setupPath = path.join(
        symlinked.root,
        "cas",
        "sha256",
        operator.setupPatch.digest.slice("sha256:".length),
      );
      const external = await mkdtemp(path.join(os.tmpdir(), "agenc-pilot-operator-"));
      temporaryRoots.push(external);
      const externalSetup = path.join(external, "setup.patch");
      await writeFile(externalSetup, await readFile(setupPath));
      await rm(setupPath);
      await symlink(externalSetup, setupPath);
      await expect(loadAndValidateEvaluationPilotCatalog(symlinked.catalog, {
        suiteManifest: fixture.suite,
        casRoot: symlinked.root,
      })).rejects.toThrow(/regular non-symlink/u);
    }
  });

  it("requires protected operator artifacts to be unique and included in the aggregate commitment", () => {
    const fixture = buildPilotFixture();
    const reusedVerifier = fixture.suite.tasks[0].hiddenVerifier.bundle;
    const duplicate = replaceOperatorTask(fixture, 1, (draft) => {
      const hiddenVerifier = draft.hiddenVerifier as Record<string, unknown>;
      hiddenVerifier.bundle = reusedVerifier;
    });
    expect(() => validateEvaluationPilotCurationDocument(duplicate.document, duplicate.suite)).toThrow(
      /artifact digests must be unique per task/u,
    );

    const changed = replaceOperatorTask(fixture, 0, (draft) => {
      const hiddenVerifier = draft.hiddenVerifier as Record<string, unknown>;
      hiddenVerifier.bundle = {
        ...(hiddenVerifier.bundle as Record<string, unknown>),
        mediaType: "application/vnd.agenc.verifier",
      };
    });
    const staleCommitmentDraft = jsonClone(changed.document) as unknown as Record<string, unknown>;
    const cas = staleCommitmentDraft.cas as Record<string, unknown>;
    cas.requiredArtifactSetDigest = fixture.document.cas.requiredArtifactSetDigest;
    delete staleCommitmentDraft.documentDigest;
    const staleCommitment = withDocumentDigest<EvaluationPilotCurationDocument>(
      staleCommitmentDraft as unknown as Omit<EvaluationPilotCurationDocument, "documentDigest">,
    );
    expect(() => validateEvaluationPilotCurationDocument(staleCommitment, changed.suite)).toThrow(
      /requiredArtifactSetDigest/u,
    );
  });

  it("rejects schema drift, digest drift, suite substitution, and non-public tasks", () => {
    const fixture = buildPilotFixture();
    const unknown = resignContract(fixture.document, (draft) => {
      draft.unreviewedPolicy = true;
    });
    expect(() => validateEvaluationPilotCurationDocument(unknown, fixture.suite)).toThrow(
      /unknown property unreviewedPolicy/u,
    );

    const digestDrift = { ...fixture.document, createdAt: "2026-07-15T12:00:01Z" };
    expect(() => validateEvaluationPilotCurationDocument(digestDrift, fixture.suite)).toThrow(
      /documentDigest does not match/u,
    );

    const otherSuite = resignContract(fixture.suite, (draft) => {
      draft.suiteVersion = "1.0.1";
    });
    expect(() => validateEvaluationPilotCurationDocument(fixture.document, otherSuite)).toThrow(
      /suite binding does not match/u,
    );

    const nonPublic = buildPilotFixture({ publicIssue: false });
    expect(() => validateEvaluationPilotCurationDocument(nonPublic.document, nonPublic.suite)).toThrow(
      /eligible public issues/u,
    );
  });

  it("rejects fewer than 15 families, more than two tasks per family, and incomplete fixed coverage", () => {
    const concentrated = buildPilotFixture({ repositoryFamilyCount: 14 });
    expect(() => validateEvaluationPilotCurationDocument(concentrated.document, concentrated.suite))
      .toThrow(/at least 15 repository families|at most 2 tasks/u);

    const fixture = buildPilotFixture();
    const missingCategoryDraft = jsonClone(fixture.document) as unknown as Record<string, unknown>;
    const tasks = missingCategoryDraft.tasks as Array<Record<string, unknown>>;
    for (const task of tasks) {
      if (task.category === "ambiguous_issue") task.category = "multi_file_fix";
    }
    const missingCategory = finalizePilotDocument(
      missingCategoryDraft as unknown as EvaluationPilotCurationDocument,
      fixture.suite,
    );
    expect(() => validateEvaluationPilotCurationDocument(missingCategory, fixture.suite)).toThrow(
      /task category coverage/u,
    );

    const missingStressorDraft = jsonClone(fixture.document) as unknown as Record<string, unknown>;
    for (const task of missingStressorDraft.tasks as Array<Record<string, unknown>>) {
      task.stressors = (task.stressors as string[]).filter(
        (stressor) => stressor !== "collaboration_beneficial",
      );
      if ((task.stressors as string[]).length === 0) task.stressors = ["tool_timeout"];
    }
    const missingStressor = finalizePilotDocument(
      missingStressorDraft as unknown as EvaluationPilotCurationDocument,
      fixture.suite,
    );
    expect(() => validateEvaluationPilotCurationDocument(missingStressor, fixture.suite)).toThrow(
      /task stressor coverage/u,
    );
  });

  it("rejects selection reordering, source-row substitution, and artifact-set substitution", () => {
    const fixture = buildPilotFixture();
    const reorderedDraft = jsonClone(fixture.document) as unknown as Record<string, unknown>;
    const tasks = reorderedDraft.tasks as unknown[];
    [tasks[0], tasks[1]] = [tasks[1], tasks[0]];
    const reordered = finalizePilotDocument(
      reorderedDraft as unknown as EvaluationPilotCurationDocument,
      fixture.suite,
    );
    expect(() => validateEvaluationPilotCurationDocument(reordered, fixture.suite)).toThrow(
      /ordered by ascending selectionKeyDigest/u,
    );

    const rowSubstitutionDraft = jsonClone(fixture.document) as unknown as Record<string, unknown>;
    const first = (rowSubstitutionDraft.tasks as Array<Record<string, unknown>>)[0];
    const source = first.source as Record<string, unknown>;
    source.rowDigest = digest("substituted-row");
    const rowSubstitution = finalizePilotDocument(
      rowSubstitutionDraft as unknown as EvaluationPilotCurationDocument,
      fixture.suite,
    );
    expect(() => validateEvaluationPilotCurationDocument(rowSubstitution, fixture.suite)).toThrow(
      /source row digest must equal/u,
    );

    const artifactSetDrift = resignContract(fixture.document, (draft) => {
      const cas = draft.cas as Record<string, unknown>;
      cas.requiredArtifactSetDigest = digest("substituted-artifact-set");
    });
    expect(() => validateEvaluationPilotCurationDocument(artifactSetDrift, fixture.suite)).toThrow(
      /requiredArtifactSetDigest/u,
    );
  });

  it("requires complete triple preflight, independent solve, negative-patch review, and exact QA joins", () => {
    const fixture = buildPilotFixture();
    const taskId = fixture.document.tasks[0].taskId;
    const shortPreflight = mutateEvidence(fixture, taskId, "upstreamTriplePreflight", (draft) => {
      (draft.runs as unknown[]).pop();
    });
    expect(() => validateEvaluationPilotEvidenceDocuments(fixture.document, fixture.suite, shortPreflight))
      .toThrow(/exactly three runs/u);

    const warmPreflight = mutateEvidence(fixture, taskId, "upstreamTriplePreflight", (draft) => {
      ((draft.runs as Array<Record<string, unknown>>)[1]).coldRebuild = false;
    });
    expect(() => validateEvaluationPilotEvidenceDocuments(fixture.document, fixture.suite, warmPreflight))
      .toThrow(/cold rebuild/u);

    const verifierLeak = mutateEvidence(fixture, taskId, "independentSolveReview", (draft) => {
      draft.verifierInaccessibleDuringSolve = false;
    });
    expect(() => validateEvaluationPilotEvidenceDocuments(fixture.document, fixture.suite, verifierLeak))
      .toThrow(/must not access the verifier/u);

    const weakNegatives = mutateEvidence(fixture, taskId, "negativePatchReview", (draft) => {
      draft.negativePatches = (draft.negativePatches as unknown[]).slice(0, 1);
    });
    expect(() => validateEvaluationPilotEvidenceDocuments(fixture.document, fixture.suite, weakNegatives))
      .toThrow(/at least two rejected negative patches/u);

    const wrongJoin = mutateEvidence(fixture, taskId, "sourceRow", (draft) => {
      draft.taskId = "task-elsewhere";
    });
    expect(() => validateEvaluationPilotEvidenceDocuments(fixture.document, fixture.suite, wrongJoin))
      .toThrow(/source row evidence taskId mismatch/u);

    const unknownEvidenceField = mutateEvidence(fixture, taskId, "negativePatchReview", (draft) => {
      draft.unreviewed = true;
    });
    expect(() =>
      validateEvaluationPilotEvidenceDocuments(fixture.document, fixture.suite, unknownEvidenceField)
    ).toThrow(/must contain exactly/u);
  });

  it("rejects duplicate-key, invalid UTF-8, oversized, and symlinked curation documents", async () => {
    const fixture = buildPilotFixture();
    const { root, catalog } = await materializeFixture(fixture);
    await writeFile(catalog, '{"kind":"first","kind":"second"}\n');
    await expect(loadAndValidateEvaluationPilotCatalog(catalog, {
      suiteManifest: fixture.suite,
      casRoot: root,
    })).rejects.toThrow(/duplicate JSON object key/u);

    await writeFile(catalog, Buffer.from([0xff]));
    await expect(loadAndValidateEvaluationPilotCatalog(catalog, {
      suiteManifest: fixture.suite,
      casRoot: root,
    })).rejects.toThrow(/not valid UTF-8 JSON/u);

    await writeFile(catalog, Buffer.alloc(EVALUATION_PILOT_MAXIMUM_DOCUMENT_BYTES + 1, 0x20));
    await expect(loadAndValidateEvaluationPilotCatalog(catalog, {
      suiteManifest: fixture.suite,
      casRoot: root,
    })).rejects.toThrow(/exceeds 4194304 bytes/u);

    if (process.platform !== "win32") {
      const target = path.join(root, "real-catalog.json");
      await writeFile(target, `${JSON.stringify(fixture.document)}\n`);
      await rm(catalog);
      await symlink(target, catalog);
      await expect(loadAndValidateEvaluationPilotCatalog(catalog, {
        suiteManifest: fixture.suite,
        casRoot: root,
      })).rejects.toThrow(/regular non-symlink/u);
    }
  });

  it("rejects CAS symlinks, digest/size drift, non-canonical URIs, and symlinked roots", async () => {
    const fixture = buildPilotFixture();
    const first = await materializeFixture(fixture);
    const artifact = fixture.document.sourceDataset.license.evidence;
    const artifactPath = path.join(first.root, "cas", "sha256", artifact.digest.slice(7));
    await writeFile(artifactPath, Buffer.alloc(artifact.sizeBytes, 0x78));
    await expect(loadAndValidateEvaluationPilotCatalog(first.catalog, {
      suiteManifest: fixture.suite,
      casRoot: first.root,
    })).rejects.toThrow(/content digest mismatch/u);

    const second = await materializeFixture(fixture);
    const secondArtifactPath = path.join(second.root, "cas", "sha256", artifact.digest.slice(7));
    await writeFile(secondArtifactPath, Buffer.concat([
      Buffer.from(await readFile(secondArtifactPath)),
      Buffer.from("x"),
    ]));
    await expect(loadAndValidateEvaluationPilotCatalog(second.catalog, {
      suiteManifest: fixture.suite,
      casRoot: second.root,
    })).rejects.toThrow(/exceeds|expected/u);

    const uriDraft = jsonClone(fixture.document) as unknown as Record<string, unknown>;
    const license = ((uriDraft.sourceDataset as Record<string, unknown>).license as Record<string, unknown>);
    const licenseArtifact = license.evidence as Record<string, unknown>;
    licenseArtifact.uri = "cas://sha256/../../outside";
    const uriDrift = withDocumentDigest<EvaluationPilotCurationDocument>(
      (() => {
        delete uriDraft.documentDigest;
        return uriDraft as unknown as Omit<EvaluationPilotCurationDocument, "documentDigest">;
      })(),
    );
    expect(() => validateEvaluationPilotCurationDocument(uriDrift, fixture.suite)).toThrow(
      /must match pattern|canonical CAS URI/u,
    );

    if (process.platform !== "win32") {
      const third = await materializeFixture(fixture);
      const external = await mkdtemp(path.join(os.tmpdir(), "agenc-pilot-external-"));
      temporaryRoots.push(external);
      const originalCas = path.join(third.root, "cas");
      const movedCas = path.join(external, "cas");
      await symlink(originalCas, movedCas);
      await expect(loadAndValidateEvaluationPilotCatalog(third.catalog, {
        suiteManifest: fixture.suite,
        casRoot: movedCas,
      })).rejects.toThrow(/CAS directory|non-symlink/u);

      const fourth = await materializeFixture(fixture);
      const fourthArtifactPath = path.join(
        fourth.root,
        "cas",
        "sha256",
        artifact.digest.slice(7),
      );
      const externalArtifact = path.join(external, "artifact.json");
      await writeFile(externalArtifact, await readFile(fourthArtifactPath));
      await rm(fourthArtifactPath);
      await symlink(externalArtifact, fourthArtifactPath);
      await expect(loadAndValidateEvaluationPilotCatalog(fourth.catalog, {
        suiteManifest: fixture.suite,
        casRoot: fourth.root,
      })).rejects.toThrow(/regular non-symlink/u);
    }
  });

  it("rejects duplicate-key and invalid UTF-8 QA artifacts even when their CAS digests match", async () => {
    const fixture = buildPilotFixture();
    const duplicate = rebindLicenseArtifact(
      fixture,
      Buffer.from('{"kind":"first","kind":"second"}', "utf8"),
    );
    const duplicateFiles = await materializeFixture(duplicate);
    await expect(loadAndValidateEvaluationPilotCatalog(duplicateFiles.catalog, {
      suiteManifest: duplicate.suite,
      casRoot: duplicateFiles.root,
    })).rejects.toThrow(/duplicate JSON object key/u);

    const invalidUtf8 = rebindLicenseArtifact(fixture, Buffer.from([0xff]));
    const invalidFiles = await materializeFixture(invalidUtf8);
    await expect(loadAndValidateEvaluationPilotCatalog(invalidFiles.catalog, {
      suiteManifest: invalidUtf8.suite,
      casRoot: invalidFiles.root,
    })).rejects.toThrow(/not valid UTF-8 JSON/u);
  });

  it("makes document and selection commitments revert-sensitive", () => {
    const fixture = buildPilotFixture();
    expect(fixture.document.documentDigest).toBe(computeDocumentDigest(fixture.document));
    expect(fixture.document.cas.requiredArtifactSetDigest).toBe(
      computeEvaluationPilotArtifactSetDigest(fixture.document, fixture.suite),
    );
    expect(fixture.document.sourceDataset.selection.selectedRowsDigest).toBe(
      computeEvaluationPilotSelectedRowsDigest(fixture.document.tasks),
    );
    const reversed = [...fixture.document.tasks].reverse();
    expect(computeEvaluationPilotSelectedRowsDigest(reversed)).not.toBe(
      fixture.document.sourceDataset.selection.selectedRowsDigest,
    );
    expect(() => validateEvaluationPilotCurationDocument(
      { ...fixture.document, tasks: reversed },
      fixture.suite,
    )).toThrow(/documentDigest|ascending selectionKeyDigest/u);
    expect(EvaluationPilotValidationError).toBeTypeOf("function");
  });
});
