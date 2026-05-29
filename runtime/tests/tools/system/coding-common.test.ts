import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveWorkspacePath } from "src/tools/system/coding-common.js";
import {
  SESSION_ID_ARG,
  SESSION_ID_SIG_ARG,
  signSessionId,
  verifySessionId,
  withSignedSessionId,
} from "src/agents/_deps/filesystem-args.js";
import {
  clearAllPlanSlugs,
  getPlanFilePath,
  setPlanSlug,
} from "src/planning/plan-files.js";

// Simulate the in-process JSON dispatch serialization (router.ts
// JSON.stringify -> execution.ts JSON.parse, and the child path). The
// PROCESS_SECRET lives in the same Node runtime, so the signature must
// survive the round-trip and still verify.
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const SESSION_ID = "sess-coding-common-test";

describe("HMAC-signed session id (plan-file carve-out)", () => {
  describe("verifySessionId", () => {
    it("returns undefined for non-string ids / non-string sigs", () => {
      expect(verifySessionId(undefined, undefined)).toBeUndefined();
      expect(verifySessionId(42, signSessionId("x"))).toBeUndefined();
      expect(verifySessionId("x", undefined)).toBeUndefined();
      expect(verifySessionId("x", 42)).toBeUndefined();
    });

    it("returns undefined for a forged / mismatched signature", () => {
      expect(verifySessionId(SESSION_ID, "00".repeat(32))).toBeUndefined();
      // signature for a DIFFERENT id must not validate this id
      expect(verifySessionId(SESSION_ID, signSessionId("other"))).toBeUndefined();
      // short/garbage hex (length-guarded buffer compare)
      expect(verifySessionId(SESSION_ID, "ab")).toBeUndefined();
    });

    // (b) LEGIT: a signed id verifies and survives JSON round-trip.
    it("verifies a legitimately signed id through a JSON round-trip", () => {
      const args = roundTrip(withSignedSessionId({}, SESSION_ID));
      expect(verifySessionId(args[SESSION_ID_ARG], args[SESSION_ID_SIG_ARG])).toBe(
        SESSION_ID,
      );
    });

    it("withSignedSessionId writes both id and sig on a NEW object", () => {
      const input: Record<string, unknown> = { file_path: "/x" };
      const out = withSignedSessionId(input, SESSION_ID);
      expect(out).not.toBe(input);
      expect(input[SESSION_ID_SIG_ARG]).toBeUndefined();
      expect(out[SESSION_ID_ARG]).toBe(SESSION_ID);
      expect(out[SESSION_ID_SIG_ARG]).toBe(signSessionId(SESSION_ID));
      expect(out.file_path).toBe("/x");
    });
  });

  // The plan-file carve-out in resolveWorkspacePath grants a WRITE target
  // OUTSIDE the workspace allowlist when the session plan-file is named.
  // It must fire ONLY for a verifiably signed session id.
  describe("plan-file carve-out (resolveWorkspacePath SINK)", () => {
    let agencHome: string;
    let workspace: string;
    let planFile: string;
    let savedAgencHome: string | undefined;

    beforeEach(() => {
      clearAllPlanSlugs();
      agencHome = mkdtempSync(join(tmpdir(), "agenc-home-"));
      workspace = mkdtempSync(join(tmpdir(), "agenc-ws-"));
      savedAgencHome = process.env.AGENC_HOME;
      process.env.AGENC_HOME = agencHome;
      // Pin a deterministic slug so the plan path is stable, then
      // materialize the plan file on disk (canonicalizePath needs it).
      setPlanSlug({ agencHome, sessionId: SESSION_ID }, "fixed-slug");
      planFile = getPlanFilePath({ agencHome, sessionId: SESSION_ID });
      writeFileSync(planFile, "# plan\n", "utf8");
    });

    afterEach(() => {
      if (savedAgencHome === undefined) {
        delete process.env.AGENC_HOME;
      } else {
        process.env.AGENC_HOME = savedAgencHome;
      }
      clearAllPlanSlugs();
    });

    const config = () => ({
      allowedPaths: [workspace] as const,
      persistenceRootDir: workspace,
    });

    // (a) FORGE: an unsigned/forged __agencSessionId must NOT unlock the
    // plan-file path outside the workspace allowlist.
    it("DENIES the carve-out for an unsigned session id", async () => {
      const args = roundTrip({
        file_path: planFile,
        [SESSION_ID_ARG]: SESSION_ID, // no signature — pure model forgery
      });
      const result = await resolveWorkspacePath({
        config: config(),
        args,
        pathArgKeys: ["file_path"],
      });
      expect(typeof result).not.toBe("string");
    });

    it("DENIES the carve-out for a forged-signature session id", async () => {
      const args = roundTrip({
        file_path: planFile,
        [SESSION_ID_ARG]: SESSION_ID,
        [SESSION_ID_SIG_ARG]: "ff".repeat(32),
      });
      const result = await resolveWorkspacePath({
        config: config(),
        args,
        pathArgKeys: ["file_path"],
      });
      expect(typeof result).not.toBe("string");
    });

    // LEGIT: a signed session id DOES unlock the plan-file write target.
    it("ALLOWS the carve-out for a legitimately signed session id", async () => {
      const args = roundTrip(
        withSignedSessionId({ file_path: planFile }, SESSION_ID),
      );
      const result = await resolveWorkspacePath({
        config: config(),
        args,
        pathArgKeys: ["file_path"],
      });
      expect(typeof result).toBe("string");
      expect(result).toBe(resolve(planFile));
    });
  });
});
