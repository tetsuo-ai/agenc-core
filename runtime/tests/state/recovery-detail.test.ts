import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MAX_RECOVERY_OPERATOR_NOTE_UTF8_BYTES,
  MAX_RECOVERY_SAFE_DETAIL_UTF8_BYTES,
  assertRecoverySha256,
  boundedRecoveryDetail,
  boundedRecoveryNote,
  recoveryDeferredKey,
  recoveryIncidentFingerprint,
  requiredRecoveryText,
} from "../../src/state/recovery-contract.js";

const XAI_SECRET = `xai-${"z".repeat(24)}`;
const SHA256 = "a".repeat(64);

describe("assertRecoverySha256", () => {
  it("accepts a lowercase 64-character digest and returns it", () => {
    expect(assertRecoverySha256(SHA256, "sourceSha256")).toBe(SHA256);
  });

  it("rejects uppercase, short, prefixed, and empty digests", () => {
    for (const value of [
      SHA256.toUpperCase(),
      "abc",
      `sha256:${SHA256}`,
      "",
    ]) {
      expect(() => assertRecoverySha256(value, "sourceSha256")).toThrow(
        /sourceSha256 must be a lowercase SHA-256 digest/,
      );
    }
  });
});

describe("boundedRecoveryDetail", () => {
  it("redacts secrets in strings and objects", () => {
    expect(boundedRecoveryDetail(`token=${XAI_SECRET}`)).toBe(
      "token=[REDACTED_SECRET]",
    );
    expect(boundedRecoveryDetail({ token: XAI_SECRET, line: 4 })).toBe(
      '{"token":"[REDACTED_SECRET]","line":4}',
    );
  });

  it("truncates a long detail on a UTF-8 byte budget and marks the cut", () => {
    const detail = boundedRecoveryDetail("x".repeat(5000));
    expect(Buffer.byteLength(detail, "utf8")).toBe(
      MAX_RECOVERY_SAFE_DETAIL_UTF8_BYTES,
    );
    expect(detail.endsWith("...[truncated]")).toBe(true);
    expect(detail).not.toContain("x".repeat(5000));
  });

  it("redacts before truncating, so a cut through a secret leaves no prefix of it", () => {
    // The secret starts 12 bytes before the cut: truncating first would keep
    // "xai-" plus 8 characters, too short for the redactor to recognise.
    const beforeCut =
      MAX_RECOVERY_SAFE_DETAIL_UTF8_BYTES - "...[truncated]".length - 12;
    const detail = boundedRecoveryDetail(
      `${"x".repeat(beforeCut - 1)} ${XAI_SECRET} ${"y".repeat(100)}`,
    );
    expect(Buffer.byteLength(detail, "utf8")).toBe(
      MAX_RECOVERY_SAFE_DETAIL_UTF8_BYTES,
    );
    expect(detail).not.toContain("xai-");
  });
});

describe("boundedRecoveryNote", () => {
  it("trims a short operator note", () => {
    expect(boundedRecoveryNote("  repaired after replay  ")).toBe(
      "repaired after replay",
    );
  });

  it("rejects a blank note", () => {
    expect(() => boundedRecoveryNote("   ")).toThrow(/operator note is required/);
  });

  it("truncates a long note on the operator-note budget", () => {
    const note = boundedRecoveryNote("n".repeat(3000));
    expect(Buffer.byteLength(note, "utf8")).toBe(
      MAX_RECOVERY_OPERATOR_NOTE_UTF8_BYTES,
    );
    expect(note.endsWith("...[truncated]")).toBe(true);
  });
});

describe("requiredRecoveryText", () => {
  it("keeps a short identity string and rejects empty or oversized values", () => {
    expect(requiredRecoveryText("run-1", "runId")).toBe("run-1");
    expect(() => requiredRecoveryText("   ", "runId")).toThrow(
      /runId is empty or exceeds its byte limit/,
    );
    expect(() => requiredRecoveryText("x".repeat(513), "runId")).toThrow(
      /runId is empty or exceeds its byte limit/,
    );
  });
});

describe("recovery fingerprints", () => {
  const incident = {
    runId: "run-1",
    sourceKind: "rollout" as const,
    sourcePath: "/tmp/rollout.jsonl",
    reasonCode: "malformed_json" as const,
    sourceSha256: SHA256,
  };

  it("is stable for the same incident and changes when facts change", () => {
    const first = recoveryIncidentFingerprint(incident);
    const second = recoveryIncidentFingerprint({
      ...incident,
      facts: { lineNumber: 12 },
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(recoveryIncidentFingerprint(incident)).toBe(first);
    expect(second).not.toBe(first);
  });

  // Both identities are stored, so their exact format is pinned: each is a
  // SHA-256 over its own domain string and length-prefixed parts. Outputs of
  // the two functions always differ anyway (different parts), so only this
  // pins the domain separation itself.
  function lengthPrefixedDigest(...values: readonly string[]): string {
    const hash = createHash("sha256");
    for (const value of values) {
      const bytes = Buffer.from(value, "utf8");
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(bytes.byteLength));
      hash.update(length).update(bytes);
    }
    return hash.digest("hex");
  }

  it("hashes quarantine fingerprints and deferred keys under separate domains", () => {
    const { runId, sourceKind, sourcePath, reasonCode, sourceSha256 } = incident;
    expect(recoveryIncidentFingerprint(incident)).toBe(
      lengthPrefixedDigest(
        "agenc.run-recovery-quarantine.v1",
        runId, sourceKind, sourcePath, reasonCode, sourceSha256, "", "", "", "",
      ),
    );
    expect(
      recoveryDeferredKey({
        runId, sourceKind, sourcePath,
        reasonCode: "database_busy",
        errorClass: "RECOVERY_OPERATIONAL",
      }),
    ).toBe(
      lengthPrefixedDigest(
        "agenc.run-recovery-deferred.v1",
        runId, sourceKind, sourcePath, "database_busy", "RECOVERY_OPERATIONAL",
      ),
    );
  });
});
