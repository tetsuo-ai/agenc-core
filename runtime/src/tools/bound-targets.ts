/**
 * File targets bound to the call that was checked.
 *
 * A file tool's permission check, and the approval prompt it may lead to,
 * happen before its effect. A link re-pointed or a folder swapped in the
 * meantime would make the tool read or change a file nobody checked. Before
 * any prompt the dispatcher asks the tool where its targets are
 * ({@link Tool.observeTargets}) and hands that observation to the call,
 * signed with the per-process secret. At its effect the tool observes the
 * target again and refuses when it is not the same file.
 *
 * @module
 */

import { realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import {
  BOUND_TARGETS_ARG,
  BOUND_TARGETS_SIG_ARG,
  signBoundTargets,
  verifyBoundTargetsSignature,
} from "../agents/_deps/filesystem-args.js";
import { writeLandingAuthorityPath } from "../sandbox/desktop-authority-protection.js";
import type { Tool } from "./types.js";

export interface ObservedFileTarget {
  /** The absolute path the tool resolves its argument to, links not followed. */
  readonly path: string;
  /**
   * Where that path is: the real path of the file, or of its deepest existing
   * folder followed by the missing rest. Never Unicode-normalized: distinct
   * POSIX names are distinct files.
   */
  readonly canonical: string;
  /** `dev:ino` of the file when it exists, null when it does not. */
  readonly identity: string | null;
}

/** Observe the file `path` names now, the way the file transaction does. */
export function observeFileTarget(path: string): ObservedFileTarget {
  const absolute = resolve(path);
  try {
    const stats = statSync(absolute);
    return {
      path: absolute,
      canonical: filesystemIdentityPath(realpathSync.native(absolute)),
      identity: `${stats.dev}:${stats.ino}`,
    };
  } catch {
    return { path: absolute, canonical: filesystemIdentityPath(canonicalMissingPath(absolute)), identity: null };
  }
}

/** POSIX names are bytes; Windows keys them NFC, as the file transaction does. */
function filesystemIdentityPath(path: string): string {
  return process.platform === "win32" ? path.normalize("NFC") : path;
}

function canonicalMissingPath(absolute: string): string {
  const missing: string[] = [];
  for (let current = absolute; ;) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    missing.unshift(basename(current));
    current = parent;
    try {
      return resolve(realpathSync.native(current), ...missing);
    } catch {
      // Missing as well: keep walking up.
    }
  }
}

/**
 * The places a write to `path` reaches, to key a session grant on its file:
 * where the path is now, and where its links lead even when nothing is
 * there yet. Never Unicode-normalized, so two names that normalize alike
 * key two grants.
 */
export function fileGrantTargets(path: string): readonly string[] {
  const observed = observeFileTarget(path).canonical;
  let landing: string | undefined;
  try {
    landing = writeLandingAuthorityPath(path);
  } catch {
    landing = undefined;
  }
  return landing === undefined || landing === observed ? [observed] : [observed, landing];
}

/** Whether a target observed now is the file the call was checked against. */
export function sameObservedTarget(expected: ObservedFileTarget, current: ObservedFileTarget): boolean {
  return expected.canonical === current.canonical && expected.identity === current.identity;
}

/**
 * What the tool says its file targets are for `args`, before any prompt.
 * Undefined when it does not say, or cannot.
 */
export function observeBoundTargets(
  tool: object,
  args: Readonly<Record<string, unknown>>,
): readonly ObservedFileTarget[] | undefined {
  const observe = (tool as { readonly observeTargets?: unknown }).observeTargets as Tool["observeTargets"] | undefined;
  if (typeof observe !== "function") return undefined;
  try {
    const targets = observe.call(tool, args);
    return targets.length === 0 ? undefined : targets;
  } catch {
    return undefined;
  }
}

/** The dispatch arguments carrying the observed targets, signed. */
export function withBoundTargets(
  args: Record<string, unknown>,
  targets: readonly ObservedFileTarget[] | undefined,
): Record<string, unknown> {
  if (targets === undefined || targets.length === 0) return args;
  const serialized = JSON.stringify(targets.map((target) => [target.path, target.canonical, target.identity]));
  return {
    ...args,
    [BOUND_TARGETS_ARG]: serialized,
    [BOUND_TARGETS_SIG_ARG]: signBoundTargets(serialized),
  };
}

/** The targets bound to this call; undefined when none or not validly signed. */
export function boundTargetsFromArgs(
  args: Readonly<Record<string, unknown>>,
): readonly ObservedFileTarget[] | undefined {
  const serialized = args[BOUND_TARGETS_ARG];
  if (typeof serialized !== "string" || !verifyBoundTargetsSignature(serialized, args[BOUND_TARGETS_SIG_ARG])) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const targets: ObservedFileTarget[] = [];
  for (const entry of parsed) {
    if (
      !Array.isArray(entry) || entry.length !== 3 ||
      typeof entry[0] !== "string" || typeof entry[1] !== "string" ||
      (entry[2] !== null && typeof entry[2] !== "string")
    ) return undefined;
    targets.push({ path: entry[0], canonical: entry[1], identity: entry[2] });
  }
  return targets;
}

/** The bound observation of the target `path` resolves to, if the call has one. */
export function boundTargetFor(
  args: Readonly<Record<string, unknown>>,
  path: string,
): ObservedFileTarget | undefined {
  const absolute = resolve(path);
  return boundTargetsFromArgs(args)?.find((target) => target.path === absolute);
}

/** The target is not the file the call was checked against: nothing was done. */
export class BoundTargetChangedError extends Error {
  constructor(readonly path: string) {
    super(
      `${path} is not the file this call was checked against: it changed after the check ` +
        "(for example a link was pointed elsewhere). Nothing was read or changed; run the call again.",
    );
    this.name = "BoundTargetChangedError";
  }
}
