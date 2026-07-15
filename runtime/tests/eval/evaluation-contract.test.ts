import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  EVAL_CONTRACT_VERSION,
  canonicalizeJson,
  classifyLegacyEvalReport,
  computeDocumentDigest,
  computeEvidenceSealStatementDigest,
  digestDomainSeparated,
  assertPrivateRootIsolation,
  projectTaskForAgent,
  validateEvalContractDocument,
  withDocumentDigest,
  type AgentTaskDocument,
  type EvidenceLedgerSealDocument,
  type OperatorTaskDocument,
  type PreregistrationDocument,
  type SuiteManifestDocument,
} from "../../src/eval-contract/index.js";
import {
  FIXED_TIME,
  digest,
  makeOperatorTask,
  makeHoldoutDescriptor,
  makePreregistration,
  makeSuite,
  makeSystem,
} from "./evaluation-contract-fixtures.js";

describe("evaluation contract v1", () => {
  test("validates a pinned task and projects only the agent-safe surface", () => {
    const operatorTask = makeOperatorTask(0, "private_holdout");
    expect(validateEvalContractDocument(operatorTask)).toEqual(operatorTask);

    const projected = projectTaskForAgent(operatorTask);
    expect(validateEvalContractDocument(projected)).toEqual(projected);
    expect(projected.documentDigest).not.toBe(operatorTask.documentDigest);
    expect(projected).not.toHaveProperty("hiddenVerifier");
    expect(projected).not.toHaveProperty("referenceSolution");
    expect(projected).not.toHaveProperty("provenance");
    expect(projected).not.toHaveProperty("split");
    expect(projected.verifierCommitment).toEqual(operatorTask.hiddenVerifier.publicCommitment);
  });

  test("allows public base repositories while keeping private oracle material sealed", () => {
    const task = makeOperatorTask(0, "private_holdout");
    expect(task.provenance.repositoryWasPublic).toBe(true);
    expect(() => validateEvalContractDocument(task)).not.toThrow();

    const exposed = withDocumentDigest<OperatorTaskDocument>({
      ...task,
      provenance: { ...task.provenance, verifierWasPublic: true },
    });
    expect(() => validateEvalContractDocument(exposed)).toThrow(/oracle materials.*unexposed/u);
  });

  test("rejects unknown fields, unsafe counters, invalid calendar dates, and forged digests", () => {
    const task = makeOperatorTask();
    expect(() => validateEvalContractDocument({ ...task, surprise: true })).toThrow(/unknown property surprise/u);
    expect(() => validateEvalContractDocument({ ...task, documentDigest: digest("forged") })).toThrow(
      /documentDigest does not match/u,
    );
    expect(() => validateEvalContractDocument({
      ...task,
      budget: { ...task.budget, toolCalls: Number.MAX_SAFE_INTEGER + 1 },
    })).toThrow(/safe I-JSON integer|unsafe integer/u);
    const suite = makeSuite();
    const invalidDate = withDocumentDigest<SuiteManifestDocument>({
      ...suite,
      createdAt: "2026-02-31T12:00:00Z",
    });
    expect(() => validateEvalContractDocument(invalidDate)).toThrow(/not a real UTC timestamp/u);
  });

  test("applies shared task invariants to standalone agent projections", () => {
    const projected = projectTaskForAgent(makeOperatorTask());
    const duplicateTool = withDocumentDigest<AgentTaskDocument>({
      ...projected,
      allowedTools: [...projected.allowedTools, projected.allowedTools[0]],
    });
    expect(() => validateEvalContractDocument(duplicateTool)).toThrow(/allowedTools must be unique/u);

    const networkEscape = withDocumentDigest<AgentTaskDocument>({
      ...projected,
      allowedTools: [{ ...projected.allowedTools[0], capabilities: ["read", "network"] }],
    });
    expect(() => validateEvalContractDocument(networkEscape)).toThrow(/conflicts with network:none/u);
  });

  test("pins repository-family identity so labels cannot evade the ten-percent cap", () => {
    const suite = makeSuite();
    expect(() => validateEvalContractDocument(suite)).not.toThrow();
    const relabeledTask = withDocumentDigest<OperatorTaskDocument>({
      ...suite.tasks[0],
      repository: { ...suite.tasks[0].repository, cluster: "repo-1" },
    });
    const relabeledSuite = withDocumentDigest<SuiteManifestDocument>({
      ...suite,
      tasks: [relabeledTask, ...suite.tasks.slice(1)],
    });
    expect(() => validateEvalContractDocument(relabeledSuite)).toThrow(/not pinned.*family cluster/u);

    const secondTask = suite.tasks[1];
    const firstFamily = suite.repositoryFamilies[0];
    if (!secondTask || !firstFamily) throw new Error("missing repository-cap fixture");
    const sharedFamilyTask = withDocumentDigest<OperatorTaskDocument>({
      ...secondTask,
      repository: {
        ...secondTask.repository,
        cluster: firstFamily.cluster,
      },
    });
    const overCapSuite = withDocumentDigest<SuiteManifestDocument>({
      ...suite,
      repositoryFamilies: suite.repositoryFamilies.map((family, index) => {
        if (index === 0) {
          return {
            ...family,
            memberRepositoryUris: [
              ...family.memberRepositoryUris,
              secondTask.repository.uri,
            ],
          };
        }
        if (index === 1) {
          const unusedUri = "https://example.invalid/repositories/unused-repo-1";
          return {
            ...family,
            canonicalRepositoryUri: unusedUri,
            memberRepositoryUris: [unusedUri],
          };
        }
        return family;
      }),
      tasks: suite.tasks.map((task) =>
        task.taskId === sharedFamilyTask.taskId ? sharedFamilyTask : task),
    });
    expect(() => validateEvalContractDocument(overCapSuite)).toThrow(
      /repository cap exceeds 10%/u,
    );
  });

  test("preregisters matched fairness, exact inference, evidence limits, and comparisons", () => {
    const preregistration = makePreregistration();
    expect(() => validateEvalContractDocument(preregistration)).not.toThrow();

    const comparator = preregistration.systems[1];
    const unfair = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      systems: [
        preregistration.systems[0],
        {
          ...comparator,
          retryPolicy: { ...comparator.retryPolicy, maxAttempts: 2 },
        },
      ],
    });
    expect(() => validateEvalContractDocument(unfair)).toThrow(/matched-model lane.*not externally matched/u);

    const duplicateComparator = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      systems: [...preregistration.systems, makeSystem("comparator-two")],
      comparisons: [
        ...preregistration.comparisons,
        {
          comparisonId: "duplicate-comparator",
          primarySystemId: preregistration.primarySystemId,
          comparatorSystemId: preregistration.systems[1].systemId,
        },
      ],
    });
    expect(() => validateEvalContractDocument(duplicateComparator)).toThrow(
      /comparison comparator system IDs must be unique/u,
    );
  });

  test("separates signed ledger facts from the non-circular anchor receipt", () => {
    const statement = {
      runId: "run-one",
      contractDigest: digest("contract"),
      taskId: "task-one",
      systemId: "system-one",
      ledgerDigest: digest("ledger"),
      ledgerByteLength: 100,
      genesisEventDigest: digest("genesis"),
      headEventDigest: digest("head"),
      eventCount: 2,
      platformProtectionVerifierDigest: digest("platform-protection-verifier"),
      sealedAt: FIXED_TIME,
    } as const;
    const seal: EvidenceLedgerSealDocument = {
      kind: "agenc.eval.evidence-seal",
      contractVersion: EVAL_CONTRACT_VERSION,
      statement,
      receipt: {
        statementDigest: computeEvidenceSealStatementDigest(statement),
        anchorPolicyDigest: digest("anchor-policy"),
        signatureAlgorithm: "ed25519",
        signatureDigest: digest("signature"),
        verificationMaterialDigest: digest("public-key"),
        anchorUri: "https://example.invalid/receipts/run-one",
        signerIdentity: "eval-signer",
      },
    };
    expect(validateEvalContractDocument(seal)).toEqual(seal);
    expect(() => validateEvalContractDocument({
      ...seal,
      receipt: { ...seal.receipt, statementDigest: digest("wrong") },
    })).toThrow(/does not cover the exact seal statement/u);
  });

  test("classifies the old mock-oriented report as non-confirmatory", () => {
    const qualification = classifyLegacyEvalReport({ schemaVersion: 1, run: {}, tasks: [] });
    expect(qualification).toMatchObject({ qualifying: false, classification: "legacy_non_confirmatory" });
    expect(qualification.missingPins).toContain("append-only anchored raw evidence");
  });

  test("exposes deterministic CLI success, validation-failure, and usage exit codes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agenc-eval-contract-cli-"));
    try {
      const validPath = path.join(directory, "valid.json");
      const invalidPath = path.join(directory, "invalid.json");
      await writeFile(validPath, JSON.stringify(makeOperatorTask()), { mode: 0o600 });
      await writeFile(invalidPath, "{\"kind\":\"not-a-contract\"}", { mode: 0o600 });
      const tsxPath = fileURLToPath(
        new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
      );
      const cliPath = fileURLToPath(new URL("../../src/eval-contract/cli.ts", import.meta.url));
      const run = (...arguments_: string[]) => spawnSync(
        process.execPath,
        [tsxPath, cliPath, "--json", ...arguments_],
        { encoding: "utf8" },
      );

      const valid = run(validPath);
      expect(valid.status).toBe(0);
      expect(JSON.parse(valid.stdout)).toMatchObject({
        contractVersion: EVAL_CONTRACT_VERSION,
        results: [{ valid: true, kind: "agenc.eval.operator-task" }],
      });

      const invalid = run(invalidPath);
      expect(invalid.status).toBe(1);
      expect(JSON.parse(invalid.stdout)).toMatchObject({
        results: [{ valid: false }],
      });

      const usage = run();
      expect(usage.status).toBe(2);
      expect(usage.stderr).toContain("Usage:");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("binds custody attestations to one canonical private holdout root", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "agenc-holdout-isolation-"));
    try {
      await chmod(base, 0o700);
      const privateRoot = path.join(base, "private");
      const secondPrivateRoot = path.join(base, "private-two");
      const repositoryRoot = path.join(base, "repository");
      const agentRoot = path.join(base, "agent");
      for (const directory of [privateRoot, secondPrivateRoot, repositoryRoot, agentRoot]) {
        await mkdir(directory, { mode: 0o700 });
        await chmod(directory, 0o700);
      }
      const descriptor = makeHoldoutDescriptor();
      const canonicalRoot = await realpath(privateRoot);
      const rootStats = await stat(canonicalRoot, { bigint: true });
      const custodyAttestation = {
        mode: descriptor.custody.mode,
        holdoutDescriptorDigest: descriptor.documentDigest,
        accessPolicyDigest: descriptor.accessPolicyDigest,
        custodianIdentity: descriptor.custody.custodianIdentity,
        implementerPrincipalSetDigest: descriptor.custody.implementerPrincipalSetDigest,
        accessControlEvidenceDigest: descriptor.custody.accessControlEvidenceDigest,
        verifierDigest: descriptor.custody.custodyVerifierDigest,
        canonicalRootDigest: digestDomainSeparated("agenc.eval.holdout-root.v1", canonicalRoot),
        rootDevice: rootStats.dev.toString(),
        rootInode: rootStats.ino.toString(),
      } as const;
      const custodyVerifier = {
        verifierDigest: descriptor.custody.custodyVerifierDigest,
        verify: () => true,
      } as const;
      await expect(assertPrivateRootIsolation({
        privateRoot,
        repositoryRoot,
        agentRoots: [agentRoot],
        holdoutDescriptor: descriptor,
        custodyAttestation,
        custodyVerifier,
      })).resolves.toBe(canonicalRoot);
      await expect(assertPrivateRootIsolation({
        privateRoot: secondPrivateRoot,
        repositoryRoot,
        agentRoots: [agentRoot],
        holdoutDescriptor: descriptor,
        custodyAttestation,
        custodyVerifier,
      })).rejects.toThrow(/not bound to this descriptor\/root\/verifier/u);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("RFC 8785 canonicalization boundary", () => {
  test("sorts keys and rejects values that JSON would silently execute or discard", () => {
    expect(canonicalizeJson({ z: 1, a: [true, null] })).toBe('{"a":[true,null],"z":1}');
    expect(() => canonicalizeJson(Number.NaN)).toThrow(/finite/u);
    expect(() => canonicalizeJson(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe/u);
    expect(() => canonicalizeJson(-0)).toThrow(/negative zero/u);
    expect(() => canonicalizeJson([, 1])).toThrow(/sparse/u);
    expect(() => canonicalizeJson({ value: "\ud800" })).toThrow(/lone high surrogate/u);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrow(/cycle/u);
    const accessor = {};
    Object.defineProperty(accessor, "secret", { enumerable: true, get: () => "executed" });
    expect(() => canonicalizeJson(accessor)).toThrow(/data property/u);
    const symbol = { visible: true } as Record<PropertyKey, unknown>;
    symbol[Symbol("hidden")] = true;
    expect(() => canonicalizeJson(symbol)).toThrow(/symbol property/u);

    let getterCalls = 0;
    const accessorDocument = { kind: "test" } as Record<string, unknown>;
    Object.defineProperty(accessorDocument, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-run";
      },
    });
    expect(() => computeDocumentDigest(accessorDocument)).toThrow(/data property/u);
    expect(() => withDocumentDigest(accessorDocument)).toThrow(/data property/u);
    expect(getterCalls).toBe(0);
  });
});
