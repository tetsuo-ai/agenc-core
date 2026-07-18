import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";

import { resolveToolAllowedPaths } from "./filesystem.js";
import {
  clearCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "src/session/current-session.js";
import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ALLOWED_ROOTS_SIG_ARG,
  SESSION_ID_ARG,
  SESSION_ID_SIG_ARG,
  signAllowedRoots,
  signSessionId,
  verifyAllowedRoots,
  verifySessionId,
  withSignedAllowedRoots,
} from "src/agents/_deps/filesystem-args.js";

// Capture the args that reach the underlying runtime FileRead tool, so
// we can observe exactly what the canonical surface injects. Mocked here
// (not in the per-test body) because vi.mock is hoisted above imports.
const capturedExecuteArgs = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("src/tools/system/file-read.js", () => ({
  createFileReadTool: () => ({
    name: "FileRead",
    description: "mock",
    isReadOnly: true,
    async execute(args: Record<string, unknown>) {
      capturedExecuteArgs.push(args);
      return { content: "ok" };
    },
  }),
}));

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

// (c) The canonical tool surface must ALWAYS inject the AUTHORITATIVE
// session id (from runtime state) signed with withSignedSessionId, and
// must NOT adopt a model-supplied __agencSessionId.
describe("canonicalToolSurface — authoritative signed session id", () => {
  let switchSession: typeof import("src/bootstrap/state.js").switchSession;
  let getSessionId: typeof import("src/bootstrap/state.js").getSessionId;
  let CanonicalFileReadTool: typeof import("src/tools/canonicalToolSurface.js").CanonicalFileReadTool;
  let restoreSessionId: string;
  const legacyTestSession = {
    conversationId: "signed-roots-test-session",
    services: { admissionRequired: false },
  } as never;

  beforeEach(async () => {
    capturedExecuteArgs.length = 0;
    const state = await import("src/bootstrap/state.js");
    switchSession = state.switchSession;
    getSessionId = state.getSessionId;
    restoreSessionId = getSessionId();
    ({ CanonicalFileReadTool } = await import("src/tools/canonicalToolSurface.js"));
    setCurrentRuntimeSession(legacyTestSession);
  });

  afterEach(() => {
    clearCurrentRuntimeSession(legacyTestSession);
    switchSession(restoreSessionId as never);
  });

  function context(): unknown {
    return {
      abortController: new AbortController(),
      readFileState: new Map(),
      getAppState: () => ({}),
    };
  }

  it("injects the authoritative signed id and ignores the model-supplied id", async () => {
    switchSession("authoritative-session" as never);
    await CanonicalFileReadTool.call(
      // The model tries to smuggle its own session id (and even a self-
      // signed-looking value) — both must be discarded.
      {
        file_path: "/tmp/x",
        [SESSION_ID_ARG]: "model-controlled-session",
        [SESSION_ID_SIG_ARG]: signSessionId("model-controlled-session"),
      } as never,
      context() as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    expect(capturedExecuteArgs).toHaveLength(1);
    const injected = capturedExecuteArgs[0]!;
    // Authoritative id wins; model value is dropped.
    expect(injected[SESSION_ID_ARG]).toBe("authoritative-session");
    expect(injected[SESSION_ID_ARG]).not.toBe("model-controlled-session");
    // ...and it carries a signature that verifies for the authoritative id.
    expect(
      verifySessionId(injected[SESSION_ID_ARG], injected[SESSION_ID_SIG_ARG]),
    ).toBe("authoritative-session");
  });
});
