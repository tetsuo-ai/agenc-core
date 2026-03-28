import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pathExists(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function hasAnchorToml(workspaceRoot: string): boolean {
  return pathExists(path.join(workspaceRoot, "Anchor.toml"));
}

function getProtocolWorkspaceCandidates(): string[] {
  const envRoot = process.env.AGENC_PROTOCOL_WORKSPACE_ROOT;
  return [
    envRoot
      ? path.isAbsolute(envRoot)
        ? envRoot
        : path.resolve(CORE_ROOT, envRoot)
      : null,
    CORE_ROOT,
    path.resolve(CORE_ROOT, "..", "agenc-protocol"),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

export function resolveProtocolWorkspaceRoot(): string {
  const candidates = getProtocolWorkspaceCandidates();

  for (const candidate of candidates) {
    if (hasAnchorToml(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate an agenc-protocol workspace. Set AGENC_PROTOCOL_WORKSPACE_ROOT to a repo containing Anchor.toml.`,
  );
}

export function isProtocolWorkspaceAvailable(): boolean {
  return getProtocolWorkspaceCandidates().some((candidate) =>
    hasAnchorToml(candidate),
  );
}

export function resolveProtocolTargetIdlPath(): string {
  return path.join(resolveProtocolWorkspaceRoot(), "target", "idl", "agenc_coordination.json");
}

export function resolveProtocolProgramBinaryPath(): string {
  const workspaceRoot = resolveProtocolWorkspaceRoot();
  const candidates = [
    path.join(workspaceRoot, "target", "deploy", "agenc_coordination.so"),
    path.join(
      workspaceRoot,
      "programs",
      "agenc-coordination",
      "target",
      "deploy",
      "agenc_coordination.so",
    ),
  ];

  for (const candidate of candidates) {
    if (pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate agenc_coordination.so under ${workspaceRoot}. Build agenc-protocol first or set AGENC_PROTOCOL_WORKSPACE_ROOT to a built protocol workspace.`,
  );
}
