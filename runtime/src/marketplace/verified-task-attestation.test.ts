import { Keypair } from "@solana/web3.js";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { signAgentMessage } from "../social/crypto.js";
import {
  beginVerifiedTaskAttestationReplay,
  canonicalJson,
  computeCanonicalMarketplaceTaskHash,
  finalizeVerifiedTaskAttestationReplay,
  releaseVerifiedTaskAttestationReplay,
  unsignedVerifiedTaskAttestation,
  verifyVerifiedTaskAttestation,
  type MarketplaceCanonicalTaskInput,
  type VerifiedTaskAttestation,
} from "./verified-task-attestation.js";

const JOB_SPEC_HASH = "a".repeat(64);

function baseCanonicalTaskInput(
  overrides: Partial<MarketplaceCanonicalTaskInput> = {},
): MarketplaceCanonicalTaskInput {
  return {
    environment: "devnet",
    creatorWallet: Keypair.generate().publicKey.toBase58(),
    creatorAgentPda: Keypair.generate().publicKey.toBase58(),
    taskDescription: "Verified storefront task",
    rewardLamports: "50000000",
    requiredCapabilities: "1",
    rewardMint: null,
    maxWorkers: 1,
    deadline: 4_102_444_800,
    taskType: 0,
    minReputation: 0,
    constraintHash: null,
    validationMode: "auto",
    reviewWindowSecs: null,
    jobSpecHash: JOB_SPEC_HASH,
    ...overrides,
  };
}

function signAttestation(
  keypair: Keypair,
  attestation: Omit<VerifiedTaskAttestation, "signature">,
): VerifiedTaskAttestation {
  const signature = signAgentMessage(
    keypair,
    new TextEncoder().encode(canonicalJson(attestation)),
  );
  return {
    ...attestation,
    signature: Buffer.from(signature).toString("hex"),
  };
}

function createSignedAttestation(
  keypair: Keypair,
  canonicalTaskInput = baseCanonicalTaskInput(),
  overrides: Partial<Omit<VerifiedTaskAttestation, "signature">> = {},
): VerifiedTaskAttestation {
  const unsigned = {
    kind: "agenc.marketplace.verifiedTaskAttestation",
    schemaVersion: 1,
    environment: "devnet",
    issuer: "agenc-services-storefront",
    issuerKeyId: "storefront-devnet-1",
    orderId: "order-123",
    serviceTemplateId: "template-runtime-smoke",
    jobSpecHash: canonicalTaskInput.jobSpecHash,
    canonicalTaskHash: computeCanonicalMarketplaceTaskHash(canonicalTaskInput),
    buyerWallet: canonicalTaskInput.creatorWallet,
    nonce: "nonce-123",
    issuedAt: "2026-04-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  } satisfies Omit<VerifiedTaskAttestation, "signature">;
  return signAttestation(keypair, unsigned);
}

describe("verified task attestations", () => {
  it("accepts a valid storefront-signed devnet attestation", async () => {
    const keypair = Keypair.generate();
    const canonicalTask = baseCanonicalTaskInput();
    const attestation = createSignedAttestation(keypair, canonicalTask);

    const result = await verifyVerifiedTaskAttestation(attestation, {
      issuerKeys: { "storefront-devnet-1": keypair.publicKey.toBase58() },
      expectedJobSpecHash: canonicalTask.jobSpecHash,
      expectedCanonicalTaskHash: computeCanonicalMarketplaceTaskHash(canonicalTask),
      expectedBuyerWallet: canonicalTask.creatorWallet,
      now: new Date("2026-04-02T00:00:00.000Z"),
    });

    expect(result.verifiedTaskHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.verifiedTaskUri).toBe(
      `agenc://verified-task/devnet/${result.verifiedTaskHash}`,
    );
    expect(result.unsignedAttestation).toEqual(unsignedVerifiedTaskAttestation(attestation));
  });

  it("rejects a tampered attestation field", async () => {
    const keypair = Keypair.generate();
    const canonicalTask = baseCanonicalTaskInput();
    const attestation = createSignedAttestation(keypair, canonicalTask);

    await expect(
      verifyVerifiedTaskAttestation(
        { ...attestation, orderId: "tampered-order" },
        {
          issuerKeys: { "storefront-devnet-1": keypair.publicKey.toBase58() },
          expectedJobSpecHash: canonicalTask.jobSpecHash,
          expectedCanonicalTaskHash: computeCanonicalMarketplaceTaskHash(canonicalTask),
          expectedBuyerWallet: canonicalTask.creatorWallet,
          now: new Date("2026-04-02T00:00:00.000Z"),
        },
      ),
    ).rejects.toThrow(/signature verification failed/);
  });

  it("rejects mismatched job specs, non-devnet attestations, expired attestations, and unknown keys", async () => {
    const keypair = Keypair.generate();
    const canonicalTask = baseCanonicalTaskInput();
    const attestation = createSignedAttestation(keypair, canonicalTask);
    const options = {
      issuerKeys: { "storefront-devnet-1": keypair.publicKey.toBase58() },
      expectedJobSpecHash: canonicalTask.jobSpecHash,
      expectedCanonicalTaskHash: computeCanonicalMarketplaceTaskHash(canonicalTask),
      expectedBuyerWallet: canonicalTask.creatorWallet,
      now: new Date("2026-04-02T00:00:00.000Z"),
    };

    await expect(
      verifyVerifiedTaskAttestation(attestation, {
        ...options,
        expectedJobSpecHash: "b".repeat(64),
      }),
    ).rejects.toThrow(/jobSpecHash/);

    await expect(
      verifyVerifiedTaskAttestation(
        { ...attestation, environment: "mainnet" as "devnet" },
        options,
      ),
    ).rejects.toThrow(/environment must be devnet/);

    await expect(
      verifyVerifiedTaskAttestation(
        createSignedAttestation(keypair, canonicalTask, {
          expiresAt: "2026-04-01T12:00:00.000Z",
        }),
        options,
      ),
    ).rejects.toThrow(/expired/);

    await expect(
      verifyVerifiedTaskAttestation(attestation, {
        ...options,
        issuerKeys: {},
      }),
    ).rejects.toThrow(/unknown verified task issuerKeyId/);
  });

  it("rejects replayed verified task hashes and nonces after a finalized reservation", async () => {
    const keypair = Keypair.generate();
    const canonicalTask = baseCanonicalTaskInput();
    const issuerKeys = { "storefront-devnet-1": keypair.publicKey.toBase58() };
    const replayStoreDir = await mkdtemp(
      join(tmpdir(), "agenc-verified-task-replay-"),
    );
    const verification = await verifyVerifiedTaskAttestation(
      createSignedAttestation(keypair, canonicalTask),
      {
        issuerKeys,
        expectedJobSpecHash: canonicalTask.jobSpecHash,
        expectedCanonicalTaskHash: computeCanonicalMarketplaceTaskHash(canonicalTask),
        expectedBuyerWallet: canonicalTask.creatorWallet,
        now: new Date("2026-04-02T00:00:00.000Z"),
      },
    );

    const reservation = await beginVerifiedTaskAttestationReplay(verification, {
      rootDir: replayStoreDir,
      taskPda: Keypair.generate().publicKey.toBase58(),
      taskId: "1".repeat(64),
    });
    await finalizeVerifiedTaskAttestationReplay(reservation, {
      taskPda: reservation.verification.attestation.buyerWallet ?? "",
      taskId: "1".repeat(64),
      transactionSignature: "tx-signature-1",
    });
    await expect(
      beginVerifiedTaskAttestationReplay(verification, {
        rootDir: replayStoreDir,
        taskPda: Keypair.generate().publicKey.toBase58(),
        taskId: "2".repeat(64),
      }),
    ).rejects.toThrow(/verifiedTaskHash|nonce/);

    const sameNonceDifferentHash = await verifyVerifiedTaskAttestation(
      createSignedAttestation(keypair, canonicalTask, {
        orderId: "order-456",
        nonce: "nonce-123",
      }),
      {
        issuerKeys,
        expectedJobSpecHash: canonicalTask.jobSpecHash,
        expectedCanonicalTaskHash: computeCanonicalMarketplaceTaskHash(canonicalTask),
        expectedBuyerWallet: canonicalTask.creatorWallet,
        now: new Date("2026-04-02T00:00:00.000Z"),
      },
    );
    await expect(
      beginVerifiedTaskAttestationReplay(sameNonceDifferentHash, {
        rootDir: replayStoreDir,
        taskPda: Keypair.generate().publicKey.toBase58(),
        taskId: "3".repeat(64),
      }),
    ).rejects.toThrow(/nonce/);
  });

  it("does not consume a nonce if the on-chain create fails (release rolls back the pending reservation)", async () => {
    const keypair = Keypair.generate();
    const canonicalTask = baseCanonicalTaskInput();
    const issuerKeys = { "storefront-devnet-1": keypair.publicKey.toBase58() };
    const replayStoreDir = await mkdtemp(
      join(tmpdir(), "agenc-verified-task-replay-"),
    );
    const verification = await verifyVerifiedTaskAttestation(
      createSignedAttestation(keypair, canonicalTask),
      {
        issuerKeys,
        expectedJobSpecHash: canonicalTask.jobSpecHash,
        expectedCanonicalTaskHash: computeCanonicalMarketplaceTaskHash(canonicalTask),
        expectedBuyerWallet: canonicalTask.creatorWallet,
        now: new Date("2026-04-02T00:00:00.000Z"),
      },
    );

    const reservation = await beginVerifiedTaskAttestationReplay(verification, {
      rootDir: replayStoreDir,
      taskPda: Keypair.generate().publicKey.toBase58(),
      taskId: "1".repeat(64),
    });

    // While the reservation is pending, a concurrent attempt is rejected — but
    // releasing it lets the next attempt succeed (the simulated retry path).
    await expect(
      beginVerifiedTaskAttestationReplay(verification, {
        rootDir: replayStoreDir,
        taskPda: Keypair.generate().publicKey.toBase58(),
        taskId: "2".repeat(64),
      }),
    ).rejects.toThrow(/in flight/);

    await releaseVerifiedTaskAttestationReplay(reservation);
    await expect(access(reservation.hashMarkerPath)).rejects.toThrow();
    await expect(access(reservation.nonceMarkerPath)).rejects.toThrow();

    const retryReservation = await beginVerifiedTaskAttestationReplay(
      verification,
      {
        rootDir: replayStoreDir,
        taskPda: Keypair.generate().publicKey.toBase58(),
        taskId: "1".repeat(64),
      },
    );
    await finalizeVerifiedTaskAttestationReplay(retryReservation, {
      taskPda: "11111111111111111111111111111111",
      taskId: "1".repeat(64),
      transactionSignature: "retry-tx",
    });
    const finalNonce = JSON.parse(
      await readFile(retryReservation.nonceMarkerPath, "utf8"),
    );
    expect(finalNonce.state).toBe("consumed");
    expect(finalNonce.verifiedTask.transactionSignature).toBe("retry-tx");
  });
});
