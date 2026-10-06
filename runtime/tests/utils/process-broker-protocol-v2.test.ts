import { describe, expect, it } from "vitest";
import { serializeProcessBrokerPayload } from "../../src/utils/process-broker-protocol.js";
import { serializeProcessBrokerV2Payload } from "../../src/utils/process-broker-protocol-v2.js";

const command = { program: "/usr/bin/bwrap", args: ["--", "/bin/true"], env: {}, ownerPid: 1234 };

describe("owner-bound one-role broker protocol", () => {
  it("preserves the independent AGB1 wire bytes", () => {
    expect(serializeProcessBrokerPayload("/x", ["a"], { env: { K: "v" }, argv0: "z" }).toString("hex"))
      .toBe("414742310000000b00000002000000012f78007a0061004b3d7600");
  });

  it("encodes the owner, full invocation, commit and zero descriptor maps", () => {
    const frame = serializeProcessBrokerV2Payload({ ...command, env: { EMPTY: "", UNICODE: "雪\n", UNSET: undefined } });
    expect(frame.subarray(0, 4).toString()).toBe("AGB2");
    expect([4, 8, 12, 16, 20, 24].map(offset => frame.readUInt32BE(offset)))
      .toEqual([frame.length - 29, 3, 2, 0, 0, 1234]);
    expect(frame.subarray(28, -1).toString()).toBe("/usr/bin/bwrap\0/usr/bin/bwrap\0--\0/bin/true\0EMPTY=\0UNICODE=雪\n\0");
    expect(frame.at(-1)).toBe(0xa5);
  });

  it("copies expected BPF bytes and only encodes source5 to child3 role1", () => {
    const seccomp = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const frame = serializeProcessBrokerV2Payload({ ...command, args: ["--seccomp", "3", ...command.args], seccomp });
    seccomp.fill(0);
    expect([20, 28, 32, 36, 40].map(offset => frame.readUInt32BE(offset))).toEqual([1, 5, 3, 1, 8]);
    expect([...frame.subarray(-9, -1)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("rejects malformed owners, strings, environment and oversize payloads before spawn", () => {
    for (const ownerPid of [0, 1, -1, 1.5, NaN, Infinity, 0x80000000]) {
      expect(() => serializeProcessBrokerV2Payload({ ...command, ownerPid })).toThrow();
    }
    for (const program of ["", "relative", "/bad\0path"]) {
      expect(() => serializeProcessBrokerV2Payload({ ...command, program })).toThrow();
    }
    for (const env of [{ "": "x" }, { "a=b": "x" }, { "a\0b": "x" }, { a: "x\0y" }]) {
      expect(() => serializeProcessBrokerV2Payload({ ...command, env })).toThrow();
    }
    for (const args of [["--", "bad\0arg"], ["--", "x".repeat(2097152)], ["--", ...new Array<string>(65535).fill("")]]) {
      expect(() => serializeProcessBrokerV2Payload({ ...command, args })).toThrow();
    }
  });

  it("rejects missing, duplicate, unexpected or ambiguous descriptor roles", () => {
    const seccomp = Buffer.alloc(8);
    for (const args of [[], ["--seccomp", "3", "--"], ["--seccomp", "4", "--"]]) {
      expect(() => serializeProcessBrokerV2Payload({ ...command, args })).toThrow();
    }
    expect(() => serializeProcessBrokerV2Payload({ ...command, seccomp })).toThrow();
    expect(() => serializeProcessBrokerV2Payload({ ...command, seccomp, args: ["--seccomp", "3", "--seccomp", "3", "--"] })).toThrow();
    for (const option of ["--add-seccomp-fd", "--ro-bind-fd", "--bind-fd", "--args", "--file", "--bind-data", "--ro-bind-data", "--sync-fd", "--info-fd", "--json-status-fd", "--userns", "--userns2", "--pidns", "--block-fd", "--userns-block-fd"]) {
      expect(() => serializeProcessBrokerV2Payload({ ...command, args: [option, "3", "--"] })).toThrow();
      expect(() => serializeProcessBrokerV2Payload({ ...command, args: [option + "=3", "--"] })).toThrow();
    }
    for (const length of [0, 7, 9, 32776]) {
      expect(() => serializeProcessBrokerV2Payload({ ...command, args: ["--seccomp", "3", "--"], seccomp: Buffer.alloc(length) })).toThrow();
    }
    // Command arguments after the delimiter are opaque, including flag-like text.
    expect(() => serializeProcessBrokerV2Payload({ ...command, args: ["--", "/bin/echo", "--info-fd", "3"] })).not.toThrow();
  });
});
