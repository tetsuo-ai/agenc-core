/**
 * Per-dir filesystem-tool argument key constants for
 * `runtime/src/agents/**`.
 *
 * The agent run-loop injects two non-enumerable args into every child
 * tool call so the AgenC implementation filesystem tools can scope their
 * I/O:
 *   - `__agencSessionId` — the child conversation id
 *   - `__agencSessionAllowedRoots` — extra workspace roots for the
 *     child (worktree path)
 *
 * Carved as a local `_deps/` (mirroring
 * `runtime/src/tools/system/filesystem.ts`) to cut the gut→AgenC
 * crossing without re-importing the full filesystem tool surface.
 *
 * SECURITY (HMAC-signed trusted roots): the `__agencSessionAllowedRoots`
 * arg widens filesystem confinement, so any value the model could forge
 * would be a sandbox escape. Tool-call args are JSON-serialized on the
 * dispatch path (router → execution, run-agent → tool-registry), all
 * within the same Node process, so the trusted channel must itself be
 * JSON-serializable — a Symbol/WeakMap tag would be lost across the
 * round-trip. We therefore sign the roots with a per-process secret the
 * model never sees and verify the signature at the SINK
 * ({@link resolveToolAllowedPaths}). Unsigned/forged roots are dropped,
 * so a future ingress that forgets the model-arg boundary strip cannot
 * reintroduce the escape.
 */

import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_ID_ARG = "__agencSessionId";
export const SESSION_ALLOWED_ROOTS_ARG = "__agencSessionAllowedRoots";
export const SESSION_ALLOWED_ROOTS_SIG_ARG = "__agencSessionAllowedRootsSig";

/**
 * Per-process secret keying the trusted-roots HMAC. Generated once at
 * module load; never serialized, never exposed to the model. Because the
 * in-process JSON dispatch round-trips (main + child) all run in this
 * same Node runtime, they share this secret and signatures verify.
 */
const PROCESS_SECRET = randomBytes(32);

/**
 * Deterministic canonical serialization of a roots array: dedupe, sort,
 * then JSON.stringify, so order/duplication never changes the signature.
 */
function canonicalizeRoots(roots: readonly string[]): string {
  return JSON.stringify([...new Set(roots)].sort());
}

/**
 * Hex HMAC-SHA256 over the canonical serialization of `roots`.
 */
export function signAllowedRoots(roots: string[]): string {
  return createHmac("sha256", PROCESS_SECRET)
    .update(canonicalizeRoots(roots))
    .digest("hex");
}

/**
 * Return the subset of `roots` that is validly signed by `sig`. Returns
 * the normalized (deduped, sorted) roots when `roots` is a `string[]`,
 * `sig` is a string, and `sig` `timingSafeEqual`-matches
 * `signAllowedRoots(roots)`. Otherwise returns `[]` — non-array inputs,
 * non-string entries, missing or forged signatures are all treated as
 * absent.
 */
export function verifyAllowedRoots(roots: unknown, sig: unknown): string[] {
  if (!Array.isArray(roots) || typeof sig !== "string") return [];
  if (!roots.every((entry): entry is string => typeof entry === "string")) {
    return [];
  }
  const normalized = [...new Set(roots as string[])].sort();
  const expected = signAllowedRoots(normalized);
  const sigBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expectedBuf.length) return [];
  if (!timingSafeEqual(sigBuf, expectedBuf)) return [];
  return normalized;
}

/**
 * Writer helper: union `newRoots` into the signed trusted-roots channel
 * of `args`, returning a NEW object (does not mutate input).
 *
 * Existing roots are read back via {@link verifyAllowedRoots}, so any
 * unsigned/forged roots already present are DROPPED (they cannot be
 * laundered into the signed set). The unioned roots are then written
 * alongside a fresh signature.
 */
export function withSignedAllowedRoots(
  args: Record<string, unknown>,
  newRoots: string[],
): Record<string, unknown> {
  const existing = verifyAllowedRoots(
    args[SESSION_ALLOWED_ROOTS_ARG],
    args[SESSION_ALLOWED_ROOTS_SIG_ARG],
  );
  const unioned = [
    ...new Set([
      ...existing,
      ...newRoots.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      ),
    ]),
  ];
  return {
    ...args,
    [SESSION_ALLOWED_ROOTS_ARG]: unioned,
    [SESSION_ALLOWED_ROOTS_SIG_ARG]: signAllowedRoots(unioned),
  };
}
