import path from "node:path";
import { canonicalAuthorityPath, isWithinAuthorityPath } from "../desktop-authority-protection.js";
import type { BoundReadOnlyCwdIdentity } from "../bound-readonly-cwd.js";
import { AGENC_INHERITED_CWD_SANDBOX_PATH } from "./constants.js";
import { resolvePermissionPath, type PermissionProfile, type FileSystemSandboxEntry } from "./index.js";

export function narrowBoundReadOnlyProfile(
  profile: PermissionProfile,
  binding: BoundReadOnlyCwdIdentity,
  policyCwd: string,
  sessionTempRoot: string,
): PermissionProfile {
  const policy = profile.fileSystem;
  if (policy.kind !== "restricted" || policy.entries.some(entry => entry.access === "none" || entry.path.kind === "glob")) {
    throw new Error("narrow inherited cwd cannot represent read-deny or glob policy entries");
  }
  const entries: FileSystemSandboxEntry[] = [];
  let covered = false;
  for (const entry of policy.entries) {
    const root = resolvePermissionPath(entry.path, policyCwd, sessionTempRoot);
    if (root === null) continue;
    // The admitted root spelling is a label for the held descriptor. Never
    // re-resolve that pathname after the capability has been issued.
    if (isWithinAuthorityPath(binding.path, root)) {
      covered = true;
      continue;
    }
    if (isWithinAuthorityPath(root, binding.path)) continue;
    const canonical = canonicalAuthorityPath(root);
    if (canonical !== path.resolve(root) || isWithinAuthorityPath(binding.path, canonical) || isWithinAuthorityPath(canonical, binding.path)) {
      throw new Error("narrow inherited cwd cannot retain an aliased read root");
    }
    entries.push({ path: { kind: "path", path: root }, access: "read" });
  }
  if (!covered) throw new Error("narrow inherited cwd is not wholly covered by a directory read grant");
  entries.push({ path: { kind: "path", path: AGENC_INHERITED_CWD_SANDBOX_PATH }, access: "read" });
  return { ...profile, network: "disabled", fileSystem: { ...policy, entries } };
}
