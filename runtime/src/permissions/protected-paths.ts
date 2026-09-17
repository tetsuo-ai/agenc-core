/**
 * Protected-path classifier for system file-tool permission checks.
 *
 * Mirrors the Bash/PowerShell lists in `utils/permissions/filesystem.ts`
 * (`.git` / `.vscode` / `.idea` / `.agenc`, shell rc files, Windows 8.3 /
 * trailing-dot / device-name / ADS spellings) so Write/Edit/notebook/
 * apply-patch cannot auto-allow paths the shell pipeline would ask about.
 */

import { getPlatform } from "../utils/platform.js";
import { containsVulnerableUncPath } from "../utils/shell/readOnlyCommandValidation.js";

/**
 * Dangerous files that should be protected from auto-editing.
 * These files can be used for code execution or data exfiltration.
 */
export const DANGEROUS_FILES = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
] as const;

/**
 * Dangerous directories that should be protected from auto-editing.
 * These directories contain sensitive configuration or executable files.
 */
export const DANGEROUS_DIRECTORIES = [
  ".git",
  ".vscode",
  ".idea",
  ".agenc",
  ".agents",
] as const;

/**
 * The roots the reduced classifier already protected before this list was
 * applied to system writes. Broadening the list must not quietly lower the
 * authority these need: they stay explicit-user-only, while the directories
 * added alongside them follow the new classifier policy.
 */
const EXPLICIT_APPROVAL_ONLY_DIRECTORIES = new Set([
  ".git",
  ".agenc",
  ".agents",
]);

const AGENC_ORDINARY_CHILDREN = new Set(["commands", "worktrees"]);

/**
 * Normalizes a path for case-insensitive comparison.
 * This prevents bypassing security checks using mixed-case paths on
 * case-insensitive filesystems (macOS/Windows).
 */
export function normalizeCaseForComparison(path: string): string {
  return path.toLowerCase();
}

function pathSegments(path: string): string[] {
  return path.split(/[\\/]/);
}

/**
 * Detects suspicious Windows path patterns that could bypass security checks.
 * Checked on every platform: NTFS can be mounted off Windows, and 8.3 / trailing
 * dots / device names are string-level bypasses even before a real NTFS mount.
 *
 * ADS colon syntax is Windows/WSL-only because only the Windows kernel
 * interprets `file:stream`. Pattern detection is used instead of API
 * normalization (GetLongPathNameW) to avoid filesystem-dependent 8.3
 * resolution, TOCTOU, and missing-file cases.
 */
export function hasSuspiciousWindowsPathPattern(path: string): boolean {
  if (getPlatform() === "windows" || getPlatform() === "wsl") {
    const colonIndex = path.indexOf(":", 2);
    if (colonIndex !== -1) {
      return true;
    }
  }

  if (/~\d/.test(path)) {
    return true;
  }

  if (
    path.startsWith("\\\\?\\") ||
    path.startsWith("\\\\.\\") ||
    path.startsWith("//?/") ||
    path.startsWith("//./")
  ) {
    return true;
  }

  if (/[.\s]+$/.test(path)) {
    return true;
  }

  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(path)) {
    return true;
  }

  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(path)) {
    return true;
  }

  if (containsVulnerableUncPath(path)) {
    return true;
  }

  return false;
}

/**
 * Check if a file path is dangerous to auto-edit without explicit permission.
 * Covers `.git` / `.vscode` / `.idea` / `.agenc` (except retired
 * `commands`/`worktrees` children) and well-known shell/git config files.
 * Case-insensitive so mixed-case segments cannot skip the list.
 */
export function isDangerousFilePathToAutoEdit(path: string): boolean {
  if (path.startsWith("\\\\") || path.startsWith("//")) {
    return true;
  }

  const segments = pathSegments(path);
  const fileName = segments.at(-1);

  for (let i = 0; i < segments.length; i++) {
    const normalizedSegment = normalizeCaseForComparison(segments[i]!);

    for (const dir of DANGEROUS_DIRECTORIES) {
      if (normalizedSegment !== normalizeCaseForComparison(dir)) {
        continue;
      }

      if (dir === ".agenc") {
        const nextSegment = segments[i + 1];
        if (
          nextSegment &&
          AGENC_ORDINARY_CHILDREN.has(normalizeCaseForComparison(nextSegment))
        ) {
          break;
        }
      }

      return true;
    }
  }

  if (fileName) {
    const normalizedFileName = normalizeCaseForComparison(fileName);
    if (
      (DANGEROUS_FILES as readonly string[]).some(
        (dangerousFile) =>
          normalizeCaseForComparison(dangerousFile) === normalizedFileName,
      )
    ) {
      return true;
    }
  }

  return false;
}

export type ProtectedPathSafetyResult =
  | { readonly safe: true }
  | {
      readonly safe: false;
      readonly message: string;
      readonly classifierApprovable: boolean;
    };

/**
 * Shared write-safety classification: suspicious Windows spellings first
 * (bypass-immune), then the dangerous-file/directory list.
 *
 * Callers that need extra session-dependent checks (live AgenC config
 * paths) should run those between the two loops rather than forking this
 * list.
 */
/**
 * True when the path sits under one of the originally protected roots, which
 * a classifier may not approve on the user's behalf.
 */
function requiresExplicitApproval(path: string): boolean {
  return pathSegments(path).some((segment) =>
    EXPLICIT_APPROVAL_ONLY_DIRECTORIES.has(normalizeCaseForComparison(segment)),
  );
}

export function checkProtectedPathSafety(
  path: string,
  pathsToCheck: readonly string[],
): ProtectedPathSafetyResult {
  for (const pathToCheck of pathsToCheck) {
    if (hasSuspiciousWindowsPathPattern(pathToCheck)) {
      return {
        safe: false,
        message:
          `AgenC requested permissions to write to ${path}, which contains a ` +
          "suspicious Windows path pattern that requires manual approval.",
        classifierApprovable: false,
      };
    }
  }

  // Every candidate, not the first match. pathsToCheck carries the path as
  // written and its canonical target, so a `.vscode` symlink into `.git` would
  // otherwise be judged by the weaker alias inspected first and never reach the
  // root it actually points at. Take the strongest restriction any candidate
  // implies.
  let dangerous = false;
  let explicitApprovalOnly = false;
  for (const pathToCheck of pathsToCheck) {
    if (!isDangerousFilePathToAutoEdit(pathToCheck)) continue;
    dangerous = true;
    if (requiresExplicitApproval(pathToCheck)) explicitApprovalOnly = true;
  }
  if (dangerous) {
    return {
      safe: false,
      message: `AgenC requested permissions to edit ${path} which is a sensitive file.`,
      classifierApprovable: !explicitApprovalOnly,
    };
  }

  return { safe: true };
}
