import { existsSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveHomePath } from "../config/home.js";
import { getCanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";
import { resolveManagedRootPath } from "../utils/settings/managedPath.js";
import type { PermissionProfile } from "./engine/policy.js";
import { canonicalAuthorityPath, isWithinAuthorityPath, protectDesktopAuthority } from "./desktop-authority-protection.js";

type AuthorityPaths = readonly string[];
interface CapturedPaths {
  readonly generation: unknown;
  readonly paths: AuthorityPaths;
}
// Cache only with a bound ConfigStore lifecycle. Outside that lifecycle,
// capture afresh so owner link edits are visible immediately. ConfigStore
// reload invalidates before reading sources; bound snapshots share one capture.
const captured = new Map<string, CapturedPaths>();
const metadata = new WeakMap<AuthorityPaths, { readonly configFiles: AuthorityPaths; readonly managedRoots: AuthorityPaths; readonly protectedPaths: AuthorityPaths }>();
const MAX_CAPTURED_HOMES = 128;

function coordinates(home?: string, managedRoot?: string, environment: NodeJS.ProcessEnv = process.env) {
  const authority = getCanonicalSettingsAuthority();
  // Paths need no native credential account. resolveHomeContext also calls
  // userInfo(), which must not make ordinary filesystem checks depend on NSS.
  const root = resolve(home ?? authority?.homeContext.path ?? resolveHomePath(environment));
  const boundHome = authority?.homeContext.path;
  const sameHome = boundHome !== undefined && resolve(boundHome) === root;
  const managed = resolve(managedRoot ?? (sameHome ? authority?.managedPaths.root : undefined) ?? resolveManagedRootPath(environment));
  const bound = sameHome && authority?.managedPaths.root !== undefined && resolve(authority.managedPaths.root) === managed;
  return { root, managed, key: `${root}\0${managed}`, generation: bound && typeof authority.current === "function" ? authority.current() : undefined };
}

export function invalidateRemoteControlAuthorityPaths(home: string, managedRoot: string): void {
  captured.delete(`${resolve(home)}\0${resolve(managedRoot)}`);
}

/** Capture from host/session authority, never from a tool's environment. */
export function remoteControlAuthorityPaths(
  home?: string,
  managedRoot?: string,
  environment: NodeJS.ProcessEnv = process.env,
): AuthorityPaths {
  const { root, managed, key, generation } = coordinates(home, managedRoot, environment);
  const previous = captured.get(key);
  if (generation !== undefined && previous !== undefined && previous.generation === generation) return previous.paths;
  const paths = new Set<string>();
  let config = join(root, "config.toml");
  for (let depth = 0; depth < 40; depth += 1) {
    paths.add(config);
    paths.add(canonicalAuthorityPath(config));
    let target: string;
    try { target = readlinkSync(config); } catch { break; }
    config = isAbsolute(target) ? target : join(dirname(config), target);
  }
  const configFiles = Object.freeze([...paths]);
  const managedRoots = Object.freeze([...new Set([managed, canonicalAuthorityPath(managed)])]);
  for (const path of managedRoots) paths.add(path);
  const result = Object.freeze([...paths]);
  metadata.set(result, { configFiles, managedRoots, protectedPaths: Object.freeze([
    ...configFiles, ...managedRoots.flatMap(path => [join(path, "config.toml"), join(path, "config.d")]),
  ]) });
  if (captured.size >= MAX_CAPTURED_HOMES) captured.delete(captured.keys().next().value!);
  captured.set(key, { generation, paths: result });
  return result;
}

/** Config leaves/drop-ins only. A parent's ordinary children are not config. */
export function isRemoteControlAuthorityPath(
  target: string,
  options: { readonly home?: string; readonly managedRoot?: string; readonly includeAncestors?: boolean } = {},
): boolean {
  const paths = remoteControlAuthorityPaths(options.home, options.managedRoot);
  const protectedPaths = metadata.get(paths)!.protectedPaths;
  const matches = (candidate: string) => protectedPaths.some(root =>
    isWithinAuthorityPath(candidate, root) ||
    (options.includeAncestors === true && isWithinAuthorityPath(root, candidate)));
  const lexical = resolve(target);
  if (matches(lexical)) return true;
  // Permission-denied/unresolvable unrelated paths must keep their previous
  // tool outcome, not become a remote-control failure before execution.
  try { return matches(canonicalAuthorityPath(target)); } catch { return false; }
}

/** Never ask bubblewrap to materialize an absent file or managed directory. */
export function protectRemoteControlAuthority(
  profile: PermissionProfile,
  paths: AuthorityPaths = remoteControlAuthorityPaths(),
): PermissionProfile {
  const existing = new Set<string>();
  const files = metadata.get(paths)?.configFiles ?? paths;
  for (const path of paths) {
    if (existsSync(path)) {
      existing.add(path);
    } else if (files.includes(path)) {
      // A fresh home already exists before command launch. Reserve it rather
      // than constructing a mountpoint at a missing config.toml. Other missing
      // authority leaves remain denied by native/shell preflight; the managed
      // root is also protected by its operating-system installation permissions.
      const parent = dirname(path);
      if (existsSync(parent)) existing.add(parent);
    }
  }
  return [...existing].reduce((current, root) => protectDesktopAuthority(current, root), profile);
}
