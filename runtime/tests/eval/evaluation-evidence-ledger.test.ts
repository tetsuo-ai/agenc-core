import {
  appendFile,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  EvidenceLedgerError,
  appendEvidenceEvent,
  initializeEvidenceLedger,
  inspectEvidenceLedger,
  sealEvidenceLedger,
  verifyEvidenceLedger,
  writeAllEvidenceBytes,
  type EvidenceEventType,
  type EvidenceLedgerAccess,
  type EvidenceLedgerContext,
} from "../../src/eval-contract/index.js";
import {
  FIXED_TIME,
  LATER_TIME,
  digest,
  makeAnchorProvider,
} from "./evaluation-contract-fixtures.js";

let root: string;

const platformProtection = {
  verifierDigest: digest("test-platform-protection-verifier"),
  async verify() {
    return true;
  },
} as const;

function access(overrides: Omit<Partial<EvidenceLedgerAccess>, "root"> = {}) {
  return { root, platformProtection, ...overrides } as const;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "agenc-eval-evidence-"));
  await chmod(root, 0o700);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const context: EvidenceLedgerContext = {
  runId: "run-one",
  contractDigest: digest("contract"),
  taskId: "task-one",
  systemId: "system-one",
};

function event(
  eventId: string,
  type: EvidenceEventType,
  occurredAt = FIXED_TIME,
) {
  return {
    ...context,
    eventId,
    occurredAt,
    producer: {
      identity: "test-evaluator",
      version: "1.0.0",
      binaryDigest: digest("test-evaluator-binary"),
    },
    type,
    mediaType: "application/json",
    redactionPolicyDigest: digest("redaction-policy"),
  } as const;
}

async function appendStartAndFinish(): Promise<void> {
  await appendEvidenceEvent({ ...access(), event: event("start", "run.started"), payloadBytes: Buffer.from("{\"start\":true}") });
  await appendEvidenceEvent({ ...access(), event: event("finish", "run.finished", LATER_TIME), payloadBytes: Buffer.from("{\"outcome\":\"pass\"}") });
}

describe("append-only evaluation evidence ledger", () => {
  test("persists restricted payloads, verifies the exact chain, seals, and requires an external anchor", async () => {
    const paths = await initializeEvidenceLedger(access(), context.runId);
    await appendStartAndFinish();
    const duplicate = await appendEvidenceEvent({
      ...access(),
      event: event("finish", "run.finished", LATER_TIME),
      payloadBytes: Buffer.from("{\"outcome\":\"pass\"}"),
    });
    expect(duplicate.status).toBe("already_present");

    const inspection = await inspectEvidenceLedger(access(), context.runId);
    expect(inspection).toMatchObject({
      trust: "integrity_only_unanchored",
      eventCount: 2,
      terminal: true,
      runId: context.runId,
    });
    expect(inspection.events.map((entry) => entry.sequence)).toEqual([0, 1]);
    expect(inspection.events[1].previousEventDigest).toBe(inspection.events[0].eventDigest);
    expect((await readdir(paths.payloads)).length).toBe(2);

    const provider = makeAnchorProvider();
    const seal = await sealEvidenceLedger({
      ...access(),
      context,
      sealedAt: "2026-07-15T12:00:02Z",
      anchorProvider: provider,
    });
    const verified = await verifyEvidenceLedger({
      ...access(),
      runId: context.runId,
      expectedSealDigest: seal.sealDigest,
      anchorVerifier: provider,
    });
    expect(verified).toMatchObject({ trust: "externally_anchored" });
    expect(verified.seal.sealDigest).toBe(seal.sealDigest);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.inspection.events[0].payload)).toBe(true);
    expect(() => {
      (verified.inspection.events[0].payload as { redactionPolicyDigest: string })
        .redactionPolicyDigest = digest("forged-redaction-policy");
    }).toThrow(TypeError);
    await expect(verifyEvidenceLedger({
      ...access(),
      runId: context.runId,
      expectedSealDigest: digest("wrong-seal"),
      anchorVerifier: provider,
    })).rejects.toMatchObject({ code: "EVIDENCE_UNANCHORED" });
    await expect(appendEvidenceEvent({
      ...access(),
      event: event("late", "diagnostic", "2026-07-15T12:00:03Z"),
      payloadBytes: Buffer.from("late"),
    })).rejects.toMatchObject({ code: "EVIDENCE_SEALED" });

    if (process.platform !== "win32") {
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.metadata)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.ledger)).mode & 0o777).toBe(0o600);
      for (const name of await readdir(paths.payloads)) {
        expect((await stat(path.join(paths.payloads, name))).mode & 0o777).toBe(0o600);
      }
    }
  });

  test("serializes concurrent writers into one contiguous chain", async () => {
    await initializeEvidenceLedger(access(), context.runId);
    await appendEvidenceEvent({ ...access(), event: event("start", "run.started"), payloadBytes: Buffer.from("start") });
    await Promise.all([
      appendEvidenceEvent({
        ...access(),
        event: event("diagnostic-a", "diagnostic", "2026-07-15T12:00:00.100Z"),
        payloadBytes: Buffer.from("a"),
      }),
      appendEvidenceEvent({
        ...access(),
        event: event("diagnostic-b", "diagnostic", "2026-07-15T12:00:00.100Z"),
        payloadBytes: Buffer.from("b"),
      }),
    ]);
    await appendEvidenceEvent({ ...access(), event: event("finish", "run.finished", LATER_TIME), payloadBytes: Buffer.from("finish") });
    const inspection = await inspectEvidenceLedger(access(), context.runId);
    expect(inspection.events.map((entry) => entry.sequence)).toEqual([0, 1, 2, 3]);
    expect(new Set(inspection.events.map((entry) => entry.eventId)).size).toBe(4);
  });

  test("rejects backwards event time before persisting another payload", async () => {
    const paths = await initializeEvidenceLedger(access(), context.runId);
    await appendEvidenceEvent({
      ...access(),
      event: event("start", "run.started"),
      payloadBytes: Buffer.from("start"),
    });
    const beforeLedger = await readFile(paths.ledger);
    const beforePayloads = await readdir(paths.payloads);
    await expect(appendEvidenceEvent({
      ...access(),
      event: event("backwards", "diagnostic", "2026-07-15T11:59:59Z"),
      payloadBytes: Buffer.from("must-not-persist"),
    })).rejects.toMatchObject({ code: "EVIDENCE_CONFLICT" });
    expect(await readFile(paths.ledger)).toEqual(beforeLedger);
    expect(await readdir(paths.payloads)).toEqual(beforePayloads);
  });

  test("binds every operation to the platform verifier chosen at initialization", async () => {
    await initializeEvidenceLedger(access(), context.runId);
    const changedPlatformProtection = {
      verifierDigest: digest("different-platform-protection-verifier"),
      async verify() {
        return true;
      },
    } as const;
    await expect(appendEvidenceEvent({
      ...access({ platformProtection: changedPlatformProtection }),
      event: event("start", "run.started"),
      payloadBytes: Buffer.from("start"),
    })).rejects.toMatchObject({ code: "EVIDENCE_PERMISSION" });
  });

  test("fails closed on a torn tail and never repairs it during append", async () => {
    const paths = await initializeEvidenceLedger(access(), context.runId);
    await appendEvidenceEvent({ ...access(), event: event("start", "run.started"), payloadBytes: Buffer.from("start") });
    await appendFile(paths.ledger, "{\"torn\":true}", { encoding: "utf8" });
    const before = await readFile(paths.ledger);
    await expect(inspectEvidenceLedger(access(), context.runId)).rejects.toMatchObject({ code: "EVIDENCE_CORRUPT" });
    await expect(appendEvidenceEvent({
      ...access(),
      event: event("finish", "run.finished", LATER_TIME),
      payloadBytes: Buffer.from("finish"),
    })).rejects.toMatchObject({ code: "EVIDENCE_CORRUPT" });
    expect(await readFile(paths.ledger)).toEqual(before);
  });

  test("rejects noncanonical duplicate-key source bytes", async () => {
    const paths = await initializeEvidenceLedger(access(), context.runId);
    await appendEvidenceEvent({ ...access(), event: event("start", "run.started"), payloadBytes: Buffer.from("start") });
    await appendFile(paths.ledger, "{\"a\":1,\"a\":1}\n", { encoding: "utf8" });
    await expect(inspectEvidenceLedger(access(), context.runId)).rejects.toThrow(/not exact canonical JSON/u);
  });

  test("freezes before an anchor call and resumes the exact frozen statement", async () => {
    await initializeEvidenceLedger(access(), context.runId);
    await appendStartAndFinish();
    const provider = makeAnchorProvider();
    await expect(sealEvidenceLedger({
      ...access(),
      context,
      sealedAt: "2026-07-15T12:00:02Z",
      anchorProvider: { ...provider, anchor: async () => { throw new Error("anchor unavailable"); } },
    })).rejects.toThrow(/anchor unavailable/u);
    await expect(appendEvidenceEvent({
      ...access(),
      event: event("late", "diagnostic", "2026-07-15T12:00:03Z"),
      payloadBytes: Buffer.from("late"),
    })).rejects.toMatchObject({ code: "EVIDENCE_SEALED" });

    const seal = await sealEvidenceLedger({
      ...access(),
      context,
      sealedAt: "2026-07-15T13:00:00Z",
      anchorProvider: provider,
    });
    expect(seal.statement.sealedAt).toBe("2026-07-15T12:00:02Z");
  });

  test("concurrent sealers with distinct valid receipts converge on the first durable seal", async () => {
    await initializeEvidenceLedger(access(), context.runId);
    await appendStartAndFinish();
    const base = makeAnchorProvider();
    const validSignatures = new Set<string>();
    let anchorCalls = 0;
    let releaseSecondAnchor: (() => void) | undefined;
    const bothAnchorsStarted = new Promise<void>((resolve) => {
      releaseSecondAnchor = resolve;
    });
    const provider = {
      anchorPolicyDigest: base.anchorPolicyDigest,
      verifierDigest: base.verifierDigest,
      async anchor(_bytes: Uint8Array, statementDigest: `sha256:${string}`) {
        anchorCalls += 1;
        const call = anchorCalls;
        if (call === 2) releaseSecondAnchor?.();
        else await bothAnchorsStarted;
        const signatureDigest = digest(`nondeterministic-signature-${call}`);
        validSignatures.add(signatureDigest);
        return {
          statementDigest,
          anchorPolicyDigest: base.anchorPolicyDigest,
          signatureAlgorithm: "ecdsa-p256-sha256" as const,
          signatureDigest,
          verificationMaterialDigest: digest("nondeterministic-public-key"),
          anchorUri: `https://example.invalid/evidence/receipt-${call}`,
          signerIdentity: "test-anchor",
        };
      },
      verify(_bytes: Uint8Array, receipt: { readonly signatureDigest: string }) {
        return validSignatures.has(receipt.signatureDigest);
      },
    } as const;
    const [first, second] = await Promise.all([
      sealEvidenceLedger({
        ...access(),
        context,
        sealedAt: "2026-07-15T12:00:02Z",
        anchorProvider: provider,
      }),
      sealEvidenceLedger({
        ...access(),
        context,
        sealedAt: "2026-07-15T12:00:03Z",
        anchorProvider: provider,
      }),
    ]);
    expect(anchorCalls).toBe(2);
    expect(first.sealDigest).toBe(second.sealDigest);
    expect(first.statement).toEqual(second.statement);
  });

  test("rejects permissive roots and resumes only an empty initialized ledger", async () => {
    if (process.platform !== "win32") {
      await chmod(root, 0o755);
      await expect(initializeEvidenceLedger(access(), context.runId)).rejects.toBeInstanceOf(Error);
      await chmod(root, 0o700);
    }
    const initialized = await initializeEvidenceLedger(access(), context.runId);
    await expect(initializeEvidenceLedger(access(), context.runId)).resolves.toEqual(initialized);
    await appendEvidenceEvent({
      ...access(),
      event: event("start", "run.started"),
      payloadBytes: Buffer.from("start"),
    });
    await expect(initializeEvidenceLedger(access(), context.runId)).rejects.toMatchObject({
      code: "EVIDENCE_ALREADY_EXISTS",
    });
  });

  test("rejects an over-limit append before persisting another payload", async () => {
    const limited = access({ limits: { maximumEvents: 2 } });
    const paths = await initializeEvidenceLedger(limited, context.runId);
    await appendEvidenceEvent({
      ...limited,
      event: event("start", "run.started"),
      payloadBytes: Buffer.from("start"),
    });
    await appendEvidenceEvent({
      ...limited,
      event: event("finish", "run.finished", LATER_TIME),
      payloadBytes: Buffer.from("finish"),
    });
    const beforeLedger = await readFile(paths.ledger);
    const beforePayloads = await readdir(paths.payloads);
    await expect(appendEvidenceEvent({
      ...limited,
      event: event("too-many", "diagnostic", "2026-07-15T12:00:02Z"),
      payloadBytes: Buffer.from("must-not-persist"),
    })).rejects.toMatchObject({ code: "EVIDENCE_LIMIT" });
    expect(await readFile(paths.ledger)).toEqual(beforeLedger);
    expect(await readdir(paths.payloads)).toEqual(beforePayloads);
  });

  test("retries a landed ledger write by re-establishing durability", async () => {
    await initializeEvidenceLedger(access(), context.runId);
    let failLedgerSync = true;
    const flaky = access({
      durabilityHooks: {
        beforeFileSync(_path, kind) {
          if (kind === "ledger" && failLedgerSync) {
            failLedgerSync = false;
            throw new Error("injected ledger fsync failure");
          }
        },
      },
    });
    const options = {
      event: event("start", "run.started"),
      payloadBytes: Buffer.from("start"),
    } as const;
    await expect(appendEvidenceEvent({ ...flaky, ...options })).rejects.toThrow(/injected/u);
    await expect(appendEvidenceEvent({ ...access(), ...options })).resolves.toMatchObject({
      status: "already_present",
    });
    await expect(inspectEvidenceLedger(access(), context.runId)).resolves.toMatchObject({
      eventCount: 1,
    });
  });
});

describe("bounded write loop", () => {
  test("handles short writes and rejects zero progress", async () => {
    const collected: number[] = [];
    await writeAllEvidenceBytes({
      async write(_buffer, offset, length) {
        const bytesWritten = Math.min(2, length);
        collected.push(offset);
        return { bytesWritten };
      },
    }, Buffer.from("abcdef"));
    expect(collected).toEqual([0, 2, 4]);

    await expect(writeAllEvidenceBytes({
      async write() {
        return { bytesWritten: 0 };
      },
    }, Buffer.from("x"))).rejects.toBeInstanceOf(EvidenceLedgerError);
  });
});
