/**
 * Phone remote control (`agenc remote`) is retired. A home that paired a
 * phone with an older Core may still hold `remote/pair.json`, and a connector
 * that Core started may still be running: it bridges the phone into this
 * daemon with the daemon cookie. Connectors stop when the stop marker changes
 * or `pair.json` is gone, so the daemon revokes the pairing at every start.
 *
 * Only a removed `pair.json` keeps a later connector from reusing the
 * pairing, so the revocation holds only when `pair.json` no longer exists.
 * Once it holds, the marker and the empty folder go too, and later starts
 * find nothing to do.
 *
 * @module
 */

import { lstatSync, mkdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface RetiredPhonePairingRevocation {
  /** No pairing is left: every connector stops without one. */
  readonly revoked: boolean;
  /** What failed on the way, in order: marker, pairing, check. */
  readonly errors: readonly unknown[];
}

export function retiredPhonePairingPath(home: string): string {
  return join(home, "remote", "pair.json");
}

/** Revoke a phone pairing left by an older Core, and clean up after it. */
export function revokeRetiredPhonePairing(home: string): RetiredPhonePairingRevocation {
  const folder = join(home, "remote");
  const marker = join(folder, "stopped");
  const pairPath = retiredPhonePairingPath(home);
  if (provablyAbsent(folder)) return { revoked: true, errors: [] };
  const errors: unknown[] = [];
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(marker, randomUUID(), { mode: 0o600 });
  } catch (error) {
    errors.push(error);
  }
  try {
    rmSync(pairPath, { force: true });
  } catch (error) {
    errors.push(error);
  }
  // Only ENOENT (nothing there) and ENOTDIR (its folder is now a file) prove
  // the pairing is gone. Any other error, such as EACCES on a folder that
  // lost its search bit, leaves a pairing that may still be on disk, so the
  // daemon fails closed.
  let revoked: boolean;
  try {
    lstatSync(pairPath);
    revoked = false;
  } catch (error) {
    revoked = provablyAbsentError(error);
    if (!revoked) errors.push(error);
  }
  if (revoked) {
    // Connectors already stop without pair.json. The folder may hold other
    // files, so it is removed only when empty.
    try { rmSync(marker, { force: true }); } catch { /* best effort */ }
    try { rmdirSync(folder); } catch { /* not empty, or already gone */ }
  }
  return { revoked, errors: distinct(errors) };
}

function provablyAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return provablyAbsentError(error);
  }
}

function provablyAbsentError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The remove step and the confirming lstat fail with the same errno on the
 * same path (a folder with no search bit raises EACCES on both). Report each
 * distinct failure once.
 */
function distinct(errors: readonly unknown[]): readonly unknown[] {
  const seen = new Set<string>();
  return errors.filter((error) => {
    const e = error as NodeJS.ErrnoException;
    const signature = `${e.code ?? ""}\u0000${e.syscall ?? ""}\u0000${e.path ?? ""}\u0000${e.message ?? ""}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}
