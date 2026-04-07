import { existsSync } from "node:fs";

import type { DelegationExecutionContext } from "../utils/delegation-execution-context.js";
import {
  isPathWithinAnyRoot,
  isPathWithinRoot,
  normalizeWorkspaceRoot,
} from "../workflow/path-normalization.js";

export type DelegatedScopePreflightIssueCode =
  | "missing_execution_context"
  | "missing_workspace_root"
  | "workspace_root_mismatch"
  | "required_source_outside_read_roots"
  | "target_outside_write_roots"
  | "read_root_outside_workspace_root"
  | "write_root_outside_workspace_root"
  | "required_source_outside_workspace_root"
  | "target_outside_workspace_root"
  | "workspace_root_missing_for_required_sources"
  | "required_source_missing";

export interface DelegatedScopePreflightIssue {
  readonly code: DelegatedScopePreflightIssueCode;
  readonly message: string;
  readonly path?: string;
}

export type DelegatedScopePreflightResult =
  | { ok: true }
  | {
      ok: false;
      issues: readonly DelegatedScopePreflightIssue[];
      error: string;
    };

function addUniqueIssue(
  issues: DelegatedScopePreflightIssue[],
  issue: DelegatedScopePreflightIssue,
): void {
  if (
    issues.some(
      (entry) => entry.code === issue.code && entry.path === issue.path,
    )
  ) {
    return;
  }
  issues.push(issue);
}

function hasDelegatedLocalFileScope(
  context: DelegationExecutionContext | undefined,
  workingDirectory?: string,
): boolean {
  return Boolean(
    workingDirectory?.trim().length ||
      context?.workspaceRoot?.trim().length ||
      context?.allowedReadRoots?.length ||
      context?.allowedWriteRoots?.length ||
      context?.requiredSourceArtifacts?.length ||
      context?.targetArtifacts?.length,
  );
}

const LOCAL_FILESYSTEM_CAPABLE_TOOL_NAMES = new Set([
  "desktop.bash",
  "desktop.text_editor",
  "system.appendFile",
  "system.bash",
  "system.calendarInfo",
  "system.calendarRead",
  "system.delete",
  "system.emailMessageExtractText",
  "system.emailMessageInfo",
  "system.listDir",
  "system.mkdir",
  "system.move",
  "system.officeDocumentExtractText",
  "system.officeDocumentInfo",
  "system.pdfExtractText",
  "system.pdfInfo",
  "system.processStart",
  "system.readFile",
  "system.serverStart",
  "system.spreadsheetInfo",
  "system.spreadsheetRead",
  "system.sqliteQuery",
  "system.sqliteSchema",
  "system.stat",
  "system.writeFile",
]);

export function toolScopeRequiresStructuredExecutionContext(
  allowedTools?: readonly string[],
): boolean {
  return (allowedTools ?? []).some((toolName) =>
    LOCAL_FILESYSTEM_CAPABLE_TOOL_NAMES.has(toolName.trim())
  );
}

function isWithinWorkspaceRoot(path: string, workspaceRoot: string): boolean {
  return path === workspaceRoot || isPathWithinRoot(path, workspaceRoot);
}

export function preflightDelegatedLocalFileScope(params: {
  readonly executionContext?: DelegationExecutionContext;
  readonly workingDirectory?: string;
  readonly allowedTools?: readonly string[];
}): DelegatedScopePreflightResult {
  const context = params.executionContext;
  const workingDirectory = params.workingDirectory?.trim();
  const requiresStructuredExecutionContext =
    toolScopeRequiresStructuredExecutionContext(params.allowedTools);

  if (!hasDelegatedLocalFileScope(context, workingDirectory) &&
      !requiresStructuredExecutionContext) {
    return { ok: true };
  }

  if (!context && requiresStructuredExecutionContext) {
    const issue: DelegatedScopePreflightIssue = {
      code: "missing_execution_context",
      message:
        "Direct execute_with_agent local-file work must provide a structured executionContext before child execution.",
    };
    return {
      ok: false,
      issues: [issue],
      error: issue.message,
    };
  }

  // Audit S1.6: normalize so the within-root checks below compare
  // canonical paths from both sides instead of mixing trim-only and
  // resolve-based forms.
  const workspaceRoot =
    normalizeWorkspaceRoot(context?.workspaceRoot) ?? workingDirectory;
  const issues: DelegatedScopePreflightIssue[] = [];

  if (!workspaceRoot) {
    addUniqueIssue(issues, {
      code: "missing_workspace_root",
      message:
        "Delegated local-file work must have a canonical workspace root before child execution.",
    });
  }

  if (
    workspaceRoot &&
    workingDirectory &&
    !isPathWithinRoot(workingDirectory, workspaceRoot) &&
    !isPathWithinRoot(workspaceRoot, workingDirectory)
  ) {
    addUniqueIssue(issues, {
      code: "workspace_root_mismatch",
      message:
        `Delegated workspace root "${workspaceRoot}" does not match the child working directory "${workingDirectory}".`,
    });
  }

  const allowedReadRoots = context?.allowedReadRoots ?? [];
  const allowedWriteRoots = context?.allowedWriteRoots ?? [];
  const requiredSourceArtifacts = context?.requiredSourceArtifacts ?? [];
  const targetArtifacts = context?.targetArtifacts ?? [];

  for (const artifact of requiredSourceArtifacts) {
    if (
      allowedReadRoots.length > 0 &&
      !isPathWithinAnyRoot(artifact, allowedReadRoots)
    ) {
      addUniqueIssue(issues, {
        code: "required_source_outside_read_roots",
        message:
          `Required source artifact "${artifact}" is outside the delegated read roots.`,
        path: artifact,
      });
    }
  }

  for (const artifact of targetArtifacts) {
    if (
      allowedWriteRoots.length > 0 &&
      !isPathWithinAnyRoot(artifact, allowedWriteRoots)
    ) {
      addUniqueIssue(issues, {
        code: "target_outside_write_roots",
        message:
          `Target artifact "${artifact}" is outside the delegated write roots.`,
        path: artifact,
      });
    }
  }

  if (workspaceRoot) {
    for (const root of allowedReadRoots) {
      if (!isWithinWorkspaceRoot(root, workspaceRoot)) {
        addUniqueIssue(issues, {
          code: "read_root_outside_workspace_root",
          message:
            `Delegated read root "${root}" is outside the canonical workspace root "${workspaceRoot}".`,
          path: root,
        });
      }
    }
    for (const root of allowedWriteRoots) {
      if (!isWithinWorkspaceRoot(root, workspaceRoot)) {
        addUniqueIssue(issues, {
          code: "write_root_outside_workspace_root",
          message:
            `Delegated write root "${root}" is outside the canonical workspace root "${workspaceRoot}".`,
          path: root,
        });
      }
    }
    for (const artifact of requiredSourceArtifacts) {
      if (!isWithinWorkspaceRoot(artifact, workspaceRoot)) {
        addUniqueIssue(issues, {
          code: "required_source_outside_workspace_root",
          message:
            `Required source artifact "${artifact}" is outside the canonical workspace root "${workspaceRoot}".`,
          path: artifact,
        });
      }
    }
    for (const artifact of targetArtifacts) {
      if (!isWithinWorkspaceRoot(artifact, workspaceRoot)) {
        addUniqueIssue(issues, {
          code: "target_outside_workspace_root",
          message:
            `Target artifact "${artifact}" is outside the canonical workspace root "${workspaceRoot}".`,
          path: artifact,
        });
      }
    }

    if (requiredSourceArtifacts.length > 0 && !existsSync(workspaceRoot)) {
      addUniqueIssue(issues, {
        code: "workspace_root_missing_for_required_sources",
        message:
          `Delegated workspace root "${workspaceRoot}" does not exist, but required source artifacts were declared inside it.`,
        path: workspaceRoot,
      });
    }
  }

  for (const artifact of requiredSourceArtifacts) {
    if (!existsSync(artifact)) {
      addUniqueIssue(issues, {
        code: "required_source_missing",
        message:
          `Required source artifact "${artifact}" does not exist, so the delegated contract cannot be satisfied before child execution.`,
        path: artifact,
      });
    }
  }

  if (issues.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    issues,
    error: issues.map((issue) => issue.message).join(" "),
  };
}
