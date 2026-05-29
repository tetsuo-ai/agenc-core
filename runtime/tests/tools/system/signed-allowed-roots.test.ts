import { describe, it, expect } from "vitest";
import { resolve } from "node:path";

import { resolveToolAllowedPaths } from "./filesystem.js";
import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ALLOWED_ROOTS_SIG_ARG,
  signAllowedRoots,
  verifyAllowedRoots,
  withSignedAllowedRoots,
} from "src/agents/_deps/filesystem-args.js";

// Simulate the in-process JSON dispatch serialization
// (router.ts JSON.stringify -> execution.ts JSON.parse, and the child
// path). The PROCESS_SECRET lives in the same Node runtime, so the
// signature must survive the round-trip and still verify.
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const BASE = [resolve("/srv/trusted")] as const;

describe("HMAC-signed trusted filesystem roots", () => {
  describe("verifyAllowedRoots", () => {
    it("rejects non-array roots and non-string signatures", () => {
      expect(verifyAllowedRoots(undefined, undefined)).toEqual([]);
      expect(verifyAllowedRoots("/", "deadbeef")).toEqual([]);
      expect(verifyAllowedRoots(["/tmp"], undefined)).toEqual([]);
      expect(verifyAllowedRoots(["/tmp"], 42)).toEqual([]);
      expect(verifyAllowedRoots([1, 2], signAllowedRoots(["/tmp"]))).toEqual([]);
    });

    it("is order/duplication-insensitive (canonical signature)", () => {
      const sig = signAllowedRoots(["/b", "/a", "/a"]);
      expect(verifyAllowedRoots(["/a", "/b"], sig)).toEqual(["/a", "/b"]);
      expect(verifyAllowedRoots(["/b", "/a"], sig)).toEqual(["/a", "/b"]);
    });
  });

  // (a) FORGE: a model-supplied root with NO / a bogus signature must NOT
  // be folded into the resolved allowed paths.
  describe("FORGE — sink ignores unsigned/forged model roots", () => {
    it("ignores __agencSessionAllowedRoots with no signature", () => {
      const args = roundTrip({ [SESSION_ALLOWED_ROOTS_ARG]: ["/"] });
      expect(resolveToolAllowedPaths(BASE, args)).toEqual([...BASE]);
    });

    it("ignores __agencSessionAllowedRoots with a bogus signature", () => {
      const args = roundTrip({
        [SESSION_ALLOWED_ROOTS_ARG]: ["/"],
        [SESSION_ALLOWED_ROOTS_SIG_ARG]: "00".repeat(32),
      });
      expect(resolveToolAllowedPaths(BASE, args)).toEqual([...BASE]);
    });

    it("ignores a signature copied from a DIFFERENT root set", () => {
      // Model knows a valid signature for ["/srv/trusted"] but swaps the
      // roots to ["/"] — the recomputed HMAC will not match.
      const args = roundTrip({
        [SESSION_ALLOWED_ROOTS_ARG]: ["/"],
        [SESSION_ALLOWED_ROOTS_SIG_ARG]: signAllowedRoots(["/srv/trusted"]),
      });
      expect(resolveToolAllowedPaths(BASE, args)).toEqual([...BASE]);
    });
  });

  // (b) LEGIT: roots injected via withSignedAllowedRoots ARE honored,
  // surviving the JSON dispatch serialization.
  describe("LEGIT — sink honors signed roots through JSON round-trip", () => {
    it("folds in a legitimately-signed root", () => {
      const injected = withSignedAllowedRoots({}, ["/work/tree"]);
      const args = roundTrip(injected);
      const resolved = resolveToolAllowedPaths(BASE, args);
      expect(resolved).toContain(resolve("/work/tree"));
      expect(resolved).toContain(BASE[0]);
    });
  });

  // (c) LAUNDERING: a writer given args that already contain an UNSIGNED
  // model root drops it and only signs its own legitimately-added root.
  describe("LAUNDERING — writer drops unsigned existing roots", () => {
    it("does not carry a forged root into the signed set", () => {
      const dirty = roundTrip({
        [SESSION_ALLOWED_ROOTS_ARG]: ["/"],
        // no valid signature — pure model forgery
      });
      const injected = withSignedAllowedRoots(dirty, ["/work/tree"]);
      const args = roundTrip(injected);

      expect(verifyAllowedRoots(
        args[SESSION_ALLOWED_ROOTS_ARG],
        args[SESSION_ALLOWED_ROOTS_SIG_ARG],
      )).toEqual(["/work/tree"]);

      const resolved = resolveToolAllowedPaths(BASE, args);
      expect(resolved).toContain(resolve("/work/tree"));
      expect(resolved).not.toContain(resolve("/"));
    });

    it("drops a root carrying a bogus signature when laundering", () => {
      const dirty = roundTrip({
        [SESSION_ALLOWED_ROOTS_ARG]: ["/etc"],
        [SESSION_ALLOWED_ROOTS_SIG_ARG]: "ff".repeat(32),
      });
      const injected = withSignedAllowedRoots(dirty, ["/work/tree"]);
      expect(verifyAllowedRoots(
        injected[SESSION_ALLOWED_ROOTS_ARG],
        injected[SESSION_ALLOWED_ROOTS_SIG_ARG],
      )).toEqual(["/work/tree"]);
    });
  });

  // (d) UNION: two successive withSignedAllowedRoots passes accumulate
  // both legitimate roots and the final signature verifies.
  describe("UNION — successive signed passes accumulate roots", () => {
    it("preserves the first signed root when adding a second", () => {
      const first = withSignedAllowedRoots({}, ["/root/a"]);
      const second = withSignedAllowedRoots(roundTrip(first), ["/root/b"]);
      const args = roundTrip(second);

      const verified = verifyAllowedRoots(
        args[SESSION_ALLOWED_ROOTS_ARG],
        args[SESSION_ALLOWED_ROOTS_SIG_ARG],
      );
      expect(verified).toEqual(["/root/a", "/root/b"]);

      const resolved = resolveToolAllowedPaths(BASE, args);
      expect(resolved).toContain(resolve("/root/a"));
      expect(resolved).toContain(resolve("/root/b"));
    });

    it("is idempotent when re-adding an existing signed root", () => {
      const first = withSignedAllowedRoots({}, ["/root/a"]);
      const again = withSignedAllowedRoots(roundTrip(first), ["/root/a"]);
      expect(verifyAllowedRoots(
        again[SESSION_ALLOWED_ROOTS_ARG],
        again[SESSION_ALLOWED_ROOTS_SIG_ARG],
      )).toEqual(["/root/a"]);
    });
  });
});
