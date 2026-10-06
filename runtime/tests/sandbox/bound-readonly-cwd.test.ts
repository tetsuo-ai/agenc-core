import { describe, expect, test } from "vitest";

import {
  issueBoundReadOnlyCwdCapability,
  parseBoundReadOnlyCwdIdentity,
  readBoundReadOnlyCwdCapability,
} from "../../src/sandbox/bound-readonly-cwd.js";

const IDENTITY = {
  path: "/workspace",
  dev: "9007199254740993",
  ino: "18446744073709551615",
  mode: "16832",
} as const;

describe("parseBoundReadOnlyCwdIdentity", () => {
  test("accepts a precise absolute identity and rejects forged wire shapes", () => {
    expect(parseBoundReadOnlyCwdIdentity(IDENTITY)).toEqual(IDENTITY);
    for (const invalid of [
      null,
      undefined,
      IDENTITY.path,
      [IDENTITY],
      { ...IDENTITY, extra: true },
      { path: IDENTITY.path, dev: IDENTITY.dev, ino: IDENTITY.ino },
      { ...IDENTITY, path: "relative" },
      { ...IDENTITY, path: "/workspace/" },
      { ...IDENTITY, path: "/workspace/../outside" },
      { ...IDENTITY, path: "/workspace\0secret" },
      { ...IDENTITY, dev: 1 },
      { ...IDENTITY, ino: "01" },
      { ...IDENTITY, mode: "-1" },
      { ...IDENTITY, mode: "" },
      { ...IDENTITY, dev: `1${"0".repeat(31)}` },
    ]) {
      expect(() => parseBoundReadOnlyCwdIdentity(invalid)).toThrow(
        "invalid inherited cwd identity",
      );
    }
  });
});

describe("bound read-only cwd capability", () => {
  test("returns the frozen issued identity only while the source still owns it", () => {
    const input = { ...IDENTITY };
    let current = true;
    const capability = issueBoundReadOnlyCwdCapability(input, () => current);
    input.path = "/forged";
    const held = readBoundReadOnlyCwdCapability(capability);
    expect(held).toEqual(IDENTITY);
    expect(held).not.toBe(input);
    expect(() => {
      (held as { path: string }).path = "/mutated";
    }).toThrow(TypeError);
    current = false;
    expect(() => readBoundReadOnlyCwdCapability(capability)).toThrow(
      "current source-owned directory capability",
    );
  });

  test("rejects copied, unknown, and never-issued tokens", () => {
    const capability = issueBoundReadOnlyCwdCapability(IDENTITY, () => true);
    for (const invalid of [
      undefined,
      null,
      IDENTITY,
      { ...capability },
      {},
    ]) {
      expect(() => readBoundReadOnlyCwdCapability(invalid)).toThrow(
        "current source-owned directory capability",
      );
    }
    expect(readBoundReadOnlyCwdCapability(capability)).toEqual(IDENTITY);
  });
});
