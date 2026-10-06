import { describe, expect, it } from "vitest";
import { ProcessBrokerV3StatusDecoder } from "../../src/utils/process-broker-protocol-v3.js";

// Hand-written wire fixtures, independent of a production serializer.
const reportedZero = Buffer.from([0x53, 0x41, 0x47, 0x43, 0x33, 0, 0, 0, 0, 0, 0, 0, 0]);
const aborted = Buffer.from([0x53, 0x41, 0x47, 0x43, 0x33, 1, 2, 2, 0, 0, 0, 0, 0]);
const unavailable = Buffer.from([0x53, 0x41, 0x47, 0x43, 0x33, 2, 2, 2, 0, 0, 0, 0, 0]);

function decode(bytes: Uint8Array) {
  const decoder = new ProcessBrokerV3StatusDecoder();
  decoder.push(bytes);
  return decoder.finish();
}

describe("AGB3 outcome and containment status", () => {
  it("accepts every split and signals readiness exactly once", () => {
    for (let split = 0; split <= reportedZero.length; split++) {
      const decoder = new ProcessBrokerV3StatusDecoder();
      const transitions = [decoder.push(reportedZero.subarray(0, split)),
        decoder.push(new Uint8Array()), decoder.push(reportedZero.subarray(split))];
      expect(transitions.filter(Boolean)).toHaveLength(1);
      expect(decoder.finish()).toEqual({ cleanupProven: true,
        outcome: { kind: "reported", result: { kind: "exit", code: 0 }, residual: "none" } });
      expect(() => decoder.push(new Uint8Array())).toThrow("already terminal");
      expect(() => decoder.finish()).toThrow("already terminal");
    }
  });

  it("keeps nonzero command exit125 distinct from unavailable or abort with clean containment", () => {
    const command125 = Buffer.from(reportedZero); command125[8] = 125;
    expect(decode(command125)).toEqual({ cleanupProven: true,
      outcome: { kind: "reported", result: { kind: "exit", code: 125 }, residual: "none" } });
    expect(decode(unavailable)).toEqual({ cleanupProven: true,
      outcome: { kind: "unavailable", residual: "unknown" } });
    expect(decode(aborted)).toEqual({ cleanupProven: true,
      outcome: { kind: "aborted", residual: "unknown" } });
  });

  it("distinguishes numeric143 from SIGTERM and records an observation without a causal termination claim", () => {
    const numeric = Buffer.from(reportedZero); numeric[8] = 143;
    const signalled = Buffer.from(reportedZero); signalled[7] = 1; signalled[8] = 15; signalled[6] = 1;
    expect(decode(numeric).outcome).toEqual({ kind: "reported",
      result: { kind: "exit", code: 143 }, residual: "none" });
    expect(decode(signalled).outcome).toEqual({ kind: "reported",
      result: { kind: "signal", signal: 15 }, residual: "observed" });
  });

  it("rejects every partial EOF and legacy, duplicate or trailing transport", () => {
    for (let length = 0; length < reportedZero.length; length++) {
      expect(() => decode(reportedZero.subarray(0, length))).toThrow();
    }
    for (const value of [Buffer.from("SC"), Buffer.from("SRC"),
      Buffer.concat([Buffer.from("S"), reportedZero]),
      Buffer.concat([reportedZero, reportedZero.subarray(1)]),
      Buffer.concat([reportedZero, Buffer.from([0])])]) {
      expect(() => decode(value)).toThrow();
    }
    const decoder = new ProcessBrokerV3StatusDecoder();
    decoder.push(reportedZero);
    expect(() => decoder.push(Buffer.from([0]))).toThrow("extra status bytes");
    expect(() => decoder.finish()).toThrow("already terminal");
  });

  it("rejects missing readiness, version changes and each reserved byte", () => {
    for (const index of [0, 1, 2, 3, 4, 9, 10, 11, 12]) {
      for (const bit of [1, 128]) {
        const invalid = Buffer.from(reportedZero); invalid[index] = invalid[index]! ^ bit;
        expect(() => decode(invalid)).toThrow();
      }
    }
  });

  it("validates cross-field combinations, not just individual enum ranges", () => {
    const codeValues = [0, 1, 15, 64, 65, 125, 126, 127, 143, 255];
    for (const state of [0, 1, 2, 3, 255]) {
      for (const residual of [0, 1, 2, 3, 255]) {
        for (const kind of [0, 1, 2, 3, 255]) {
          for (const code of codeValues) {
            const frame = Buffer.from(reportedZero);
            frame.set([state, residual, kind, code], 5);
            const ordinary = state === 0 && residual <= 1 &&
              (kind === 0 || (kind === 1 && code >= 1 && code <= 64));
            const unknown = (state === 1 || state === 2) && residual === 2 && kind === 2 && code === 0;
            if (ordinary || unknown) expect(decode(frame).cleanupProven).toBe(true);
            else expect(() => decode(frame)).toThrow();
          }
        }
      }
    }
  });

  it("keeps the accumulator bounded when given an oversized chunk", () => {
    const decoder = new ProcessBrokerV3StatusDecoder();
    expect(() => decoder.push(new Uint8Array(1024 * 1024))).toThrow("extra status bytes");
    expect(() => decoder.push(reportedZero)).toThrow("already terminal");
  });
});
