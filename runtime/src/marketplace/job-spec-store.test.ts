import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  linkMarketplaceJobSpecToTask,
  readMarketplaceJobSpecPointerForTask,
  resolveMarketplaceJobSpecReference,
  verifyMarketplaceJobSpecEnvelope,
  type MarketplaceJobSpecEnvelope,
} from "./job-spec-store.js";
import {
  canonicalJson,
  computeCanonicalMarketplaceTaskHash,
  type MarketplaceCanonicalTaskInput,
  type VerifiedTaskAttestation,
} from "./verified-task-attestation.js";
import { signAgentMessage } from "../social/crypto.js";

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "agenc.marketplace.jobSpec",
    title: "Remote audit task",
    shortDescription: "Remote audit task",
    fullDescription: null,
    acceptanceCriteria: [],
    deliverables: [],
    constraints: null,
    attachments: [],
    custom: null,
    context: {},
    ...overrides,
  };
}

function legacyCanonicalJson(value: unknown): string {
  return JSON.stringify(legacySort(value));
}

function legacySort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacySort);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = legacySort((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function canonicalJobSpecUri(hash: string): string {
  return `agenc://job-spec/sha256/${hash}`;
}

function makeEnvelope(payload: Record<string, unknown>): {
  envelope: MarketplaceJobSpecEnvelope;
  hash: string;
} {
  const hash = sha256Hex(legacyCanonicalJson(payload));
  return {
    hash,
    envelope: {
      schemaVersion: 1,
      kind: "agenc.marketplace.jobSpecEnvelope",
      integrity: {
        algorithm: "sha256",
        canonicalization: "json-stable-v1",
        payloadHash: hash,
        uri: canonicalJobSpecUri(hash),
      },
      payload: payload as MarketplaceJobSpecEnvelope["payload"],
    },
  };
}

function remoteResponse(envelope: MarketplaceJobSpecEnvelope) {
  const body = JSON.stringify(envelope);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-length" ? String(Buffer.byteLength(body)) : null),
    },
    text: async () => body,
  } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("marketplace job spec integrity", () => {
  it("does not fetch remote job spec URIs unless explicitly allowed", async () => {
    const { envelope, hash } = makeEnvelope(basePayload());
    const fetchSpy = vi.fn(async () => remoteResponse(envelope));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      resolveMarketplaceJobSpecReference({
        jobSpecHash: hash,
        jobSpecUri: "https://attacker.invalid/job-spec.json",
      }),
    ).rejects.toThrow(/allowRemote=true/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves remote job spec URIs only when allowRemote is true", async () => {
    const { envelope, hash } = makeEnvelope(basePayload());
    const fetchSpy = vi.fn(async () => remoteResponse(envelope));
    vi.stubGlobal("fetch", fetchSpy);

    const resolved = await resolveMarketplaceJobSpecReference(
      {
        jobSpecHash: hash,
        jobSpecUri: "https://trusted.example/job-spec.json",
      },
      { allowRemote: true },
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(resolved.jobSpecHash).toBe(hash);
    expect(resolved.payload.title).toBe("Remote audit task");
  });

  it.each([
    ["custom.__proto__", { custom: JSON.parse('{"__proto__":{"polluted":true}}') }],
    ["context.nested.constructor", { context: { nested: { constructor: { polluted: true } } } }],
    ["constraints[0].prototype", { constraints: [{ prototype: { polluted: true } }] }],
    [
      "attachments[0].__proto__",
      { attachments: [JSON.parse('{"uri":"https://example.com/spec.md","__proto__":{"polluted":true}}')] },
    ],
  ])("rejects forbidden payload keys at %s", (_label, overrides) => {
    const { envelope } = makeEnvelope(basePayload(overrides));

    expect(verifyMarketplaceJobSpecEnvelope(envelope)).toBe(false);
  });

  it("rejects a local envelope whose canonical hash omitted a forbidden key", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agenc-job-spec-integrity-"));
    const objectsDir = join(rootDir, "objects");
    const { envelope, hash } = makeEnvelope(
      basePayload({ custom: JSON.parse('{"__proto__":{"polluted":true}}') }),
    );

    await mkdir(objectsDir, { recursive: true });
    await writeFile(join(objectsDir, `${hash}.json`), `${JSON.stringify(envelope)}\n`, "utf8");

    await expect(
      resolveMarketplaceJobSpecReference(
        { jobSpecHash: hash, jobSpecUri: canonicalJobSpecUri(hash) },
        { rootDir },
      ),
    ).rejects.toThrow(/integrity verification/);
  });

  it("rejects a remote envelope whose canonical hash omitted a forbidden key", async () => {
    const { envelope, hash } = makeEnvelope(
      basePayload({ custom: JSON.parse('{"__proto__":{"polluted":true}}') }),
    );
    const fetchSpy = vi.fn(async () => remoteResponse(envelope));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      resolveMarketplaceJobSpecReference(
        {
          jobSpecHash: hash,
          jobSpecUri: "https://trusted.example/job-spec.json",
        },
        { allowRemote: true },
      ),
    ).rejects.toThrow(/integrity verification/);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe("marketplace task link verified-task binding", () => {
  function fixedDeadline(): number {
    return Math.floor(Date.parse("2099-01-01T00:00:00.000Z") / 1000);
  }

  function makeCanonicalInput(
    overrides: Partial<MarketplaceCanonicalTaskInput>,
  ): MarketplaceCanonicalTaskInput {
    return {
      environment: "devnet",
      creatorWallet: Keypair.generate().publicKey.toBase58(),
      creatorAgentPda: Keypair.generate().publicKey.toBase58(),
      taskDescription: "Verified link binding test",
      rewardLamports: "10000000",
      requiredCapabilities: "1",
      rewardMint: null,
      maxWorkers: 1,
      deadline: fixedDeadline(),
      taskType: 0,
      minReputation: 0,
      constraintHash: null,
      validationMode: "auto",
      reviewWindowSecs: null,
      jobSpecHash: "a".repeat(64),
      ...overrides,
    };
  }

  function signAttestation(
    issuer: Keypair,
    canonical: MarketplaceCanonicalTaskInput,
    overrides: Partial<Omit<VerifiedTaskAttestation, "signature">> = {},
  ): VerifiedTaskAttestation {
    const unsigned = {
      kind: "agenc.marketplace.verifiedTaskAttestation" as const,
      schemaVersion: 1 as const,
      environment: "devnet" as const,
      issuer: "agenc-services-storefront" as const,
      issuerKeyId: "storefront-devnet-1",
      orderId: "binding-test",
      serviceTemplateId: "template-binding",
      jobSpecHash: canonical.jobSpecHash,
      canonicalTaskHash: computeCanonicalMarketplaceTaskHash(canonical),
      buyerWallet: canonical.creatorWallet,
      nonce: `nonce-${Math.random().toString(36).slice(2)}`,
      issuedAt: "2026-04-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      ...overrides,
    };
    const signature = signAgentMessage(
      issuer,
      new TextEncoder().encode(canonicalJson(unsigned)),
    );
    return { ...unsigned, signature: Buffer.from(signature).toString("hex") };
  }

  function makeTaskPda(): string {
    return Keypair.generate().publicKey.toBase58();
  }

  function makeTaskId(seed: string): string {
    const hash = createHash("sha256").update(seed).digest("hex");
    return hash;
  }

  it("rejects an attestation copied from another link sharing the same jobSpecHash", async () => {
    const issuer = Keypair.generate();
    const issuerKeys = { "storefront-devnet-1": issuer.publicKey.toBase58() };
    const rootDir = await mkdtemp(join(tmpdir(), "agenc-link-binding-"));
    const sharedJobSpecHash = "b".repeat(64);
    const sharedJobSpecUri = `agenc://job-spec/sha256/${sharedJobSpecHash}`;

    const taskAPda = makeTaskPda();
    const taskAId = makeTaskId("task-A");
    const canonicalA = makeCanonicalInput({
      jobSpecHash: sharedJobSpecHash,
      taskDescription: "Task A description",
      rewardLamports: "10000000",
    });
    const attestationA = signAttestation(issuer, canonicalA);
    await linkMarketplaceJobSpecToTask(
      {
        hash: sharedJobSpecHash,
        uri: sharedJobSpecUri,
        taskPda: taskAPda,
        taskId: taskAId,
        transactionSignature: "tx-A",
        verifiedTaskAttestation: attestationA,
        verifiedTaskAcceptedAt: "2026-04-27T00:00:00.000Z",
        verifiedTaskCanonicalInput: canonicalA,
      },
      { rootDir },
    );

    const taskBPda = makeTaskPda();
    const taskBId = makeTaskId("task-B");
    const canonicalB = makeCanonicalInput({
      jobSpecHash: sharedJobSpecHash,
      // Different task material so canonicalTaskHash differs from A's.
      taskDescription: "Task B description",
      rewardLamports: "20000000",
      maxWorkers: 2,
    });
    const attestationB = signAttestation(issuer, canonicalB);
    const linkBPath = await linkMarketplaceJobSpecToTask(
      {
        hash: sharedJobSpecHash,
        uri: sharedJobSpecUri,
        taskPda: taskBPda,
        taskId: taskBId,
        transactionSignature: "tx-B",
        verifiedTaskAttestation: attestationB,
        verifiedTaskAcceptedAt: "2026-04-27T00:00:00.000Z",
        verifiedTaskCanonicalInput: canonicalB,
      },
      { rootDir },
    );

    // Sanity: B reads as verified before tampering.
    const okB = await readMarketplaceJobSpecPointerForTask(taskBPda, {
      rootDir,
      verifiedTaskIssuerKeys: issuerKeys,
    });
    expect(okB?.verifiedTask).not.toBeNull();
    expect(okB?.verifiedTask?.canonicalTaskHash).toBe(
      computeCanonicalMarketplaceTaskHash(canonicalB),
    );

    // Attack scenario from the review: copy A's signed attestation into B's
    // link. The attacker cannot forge a new issuer signature, so they leave
    // B's persisted canonical task material in place. The read path must
    // detect that A's signed canonicalTaskHash does not match B's recomputed
    // canonicalTaskHash and report unverified.
    const linkB = JSON.parse(await readFile(linkBPath, "utf8"));
    linkB.verifiedTaskAttestation = attestationA;
    await writeFile(linkBPath, `${JSON.stringify(linkB)}\n`);
    const tamperedB = await readMarketplaceJobSpecPointerForTask(taskBPda, {
      rootDir,
      verifiedTaskIssuerKeys: issuerKeys,
    });
    expect(tamperedB?.verifiedTask).toBeNull();
  });

  it("rejects a link whose persisted canonical input does not match the attestation", async () => {
    const issuer = Keypair.generate();
    const issuerKeys = { "storefront-devnet-1": issuer.publicKey.toBase58() };
    const rootDir = await mkdtemp(join(tmpdir(), "agenc-link-mismatch-"));
    const jobSpecHash = "c".repeat(64);
    const jobSpecUri = `agenc://job-spec/sha256/${jobSpecHash}`;

    const canonical = makeCanonicalInput({ jobSpecHash });
    const attestation = signAttestation(issuer, canonical);
    const taskPda = makeTaskPda();
    const linkPath = await linkMarketplaceJobSpecToTask(
      {
        hash: jobSpecHash,
        uri: jobSpecUri,
        taskPda,
        taskId: makeTaskId("mismatch"),
        transactionSignature: "tx-mismatch",
        verifiedTaskAttestation: attestation,
        verifiedTaskCanonicalInput: canonical,
      },
      { rootDir },
    );

    // Tamper only the persisted canonicalInput so its recomputed hash no longer
    // matches the signed attestation.
    const link = JSON.parse(await readFile(linkPath, "utf8"));
    link.verifiedTaskCanonicalInput = {
      ...link.verifiedTaskCanonicalInput,
      taskDescription: "Tampered description",
    };
    await writeFile(linkPath, `${JSON.stringify(link)}\n`);

    const pointer = await readMarketplaceJobSpecPointerForTask(taskPda, {
      rootDir,
      verifiedTaskIssuerKeys: issuerKeys,
    });
    expect(pointer?.verifiedTask).toBeNull();
  });

  it("rejects a link whose persisted canonical input is absent (no independent material to bind)", async () => {
    const issuer = Keypair.generate();
    const issuerKeys = { "storefront-devnet-1": issuer.publicKey.toBase58() };
    const rootDir = await mkdtemp(join(tmpdir(), "agenc-link-no-canonical-"));
    const jobSpecHash = "d".repeat(64);
    const jobSpecUri = `agenc://job-spec/sha256/${jobSpecHash}`;

    const canonical = makeCanonicalInput({ jobSpecHash });
    const attestation = signAttestation(issuer, canonical);
    const taskPda = makeTaskPda();
    const linkPath = await linkMarketplaceJobSpecToTask(
      {
        hash: jobSpecHash,
        uri: jobSpecUri,
        taskPda,
        taskId: makeTaskId("no-canonical"),
        transactionSignature: "tx-no-canonical",
        verifiedTaskAttestation: attestation,
        verifiedTaskCanonicalInput: canonical,
      },
      { rootDir },
    );

    // Drop the canonical input on disk — simulates a legacy / partially-rolled
    // upgrade where only the attestation is present. Without the independent
    // canonical material the read path must NOT surface verified status.
    const link = JSON.parse(await readFile(linkPath, "utf8"));
    delete link.verifiedTaskCanonicalInput;
    await writeFile(linkPath, `${JSON.stringify(link)}\n`);

    const pointer = await readMarketplaceJobSpecPointerForTask(taskPda, {
      rootDir,
      verifiedTaskIssuerKeys: issuerKeys,
    });
    expect(pointer?.verifiedTask).toBeNull();
  });
});
