import { describe, expect, test } from "vitest";

import {
  normalizePathForPolicy,
  pathOverlaps,
  pathStartsWith,
  resolvePathAgainstBase,
} from "../../../src/sandbox/engine/policy.js";

describe("sandbox path policy primitives", () => {
  test("normalizePathForPolicy resolves and drops a trailing separator", () => {
    expect(normalizePathForPolicy("/tmp/")).toBe("/tmp");
    expect(normalizePathForPolicy("/tmp")).toBe("/tmp");
    expect(normalizePathForPolicy("/tmp/./foo/../bar/")).toBe("/tmp/bar");
  });

  test("pathStartsWith requires a real descendant, not a prefix-string neighbor", () => {
    expect(pathStartsWith("/tmp/foo", "/tmp")).toBe(true);
    expect(pathStartsWith("/tmp", "/tmp")).toBe(true);
    expect(pathStartsWith("/tmp", "/tmp/foo")).toBe(false);
    expect(pathStartsWith("/tmpfoo", "/tmp")).toBe(false);
    expect(pathStartsWith("/var/log", "/tmp")).toBe(false);
  });

  test("pathOverlaps is true when either path contains the other", () => {
    expect(pathOverlaps("/tmp", "/tmp/foo")).toBe(true);
    expect(pathOverlaps("/tmp/foo", "/tmp")).toBe(true);
    expect(pathOverlaps("/tmp/a", "/tmp/b")).toBe(false);
    expect(pathOverlaps("/tmp", "/tmpfoo")).toBe(false);
  });

  test("resolvePathAgainstBase keeps absolutes and resolves relatives", () => {
    expect(resolvePathAgainstBase("/abs/x", "/base")).toBe("/abs/x");
    expect(resolvePathAgainstBase("rel", "/base")).toBe("/base/rel");
    expect(resolvePathAgainstBase("../escape", "/base/sub")).toBe("/base/escape");
  });
});
