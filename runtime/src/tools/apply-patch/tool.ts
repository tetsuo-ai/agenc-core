/**
 * Ports the donor apply-patch tool surface onto AgenC's Tool contract.
 *
 * Shape differences from upstream:
 *   - AgenC exposes the JSON input shape universally and accepts raw
 *     string calls through the registry string-argument adapter.
 *   - The Lark grammar is exported for providers/runtime surfaces that
 *     can consume freeform grammars later.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Provider-specific freeform wire serialization is not present in
 *     AgenC's current LLMTool type.
 */

import { checkToolPathPermission } from "../../permissions/path-validation.js";
import type { PermissionResult } from "../../permissions/types.js";
import { nonEmptyString as asNonEmptyString } from "../../utils/stringUtils.js";
import type {
  Tool,
  ToolExecutionInjectedArgs,
  ToolResult,
} from "../types.js";
import { plainTextErrorToolResult as errorResult } from "../results.js";
import { SESSION_ID_ARG } from "../system/filesystem.js";
import { parsePatch } from "./parser.js";
import { applyPatchText } from "./runtime.js";
import type { ApplyPatchHunk } from "./types.js";

export const APPLY_PATCH_TOOL_NAME = "apply_patch";

export const APPLY_PATCH_LARK_GRAMMAR = String.raw`start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

const APPLY_PATCH_DESCRIPTION = `Use the apply_patch tool to edit files.

Input must obey this patch format:

*** Begin Patch
[one or more file hunks]
*** End Patch

Supported hunks:
- *** Add File: path followed by one or more + lines
- *** Delete File: path
- *** Update File: path, optionally followed by *** Move to: path, then one or more @@ chunks

Patch paths should be workspace-relative unless an absolute path is necessary and inside the allowed workspace roots.`;

export interface ApplyPatchToolConfig {
  readonly cwd: string;
  readonly allowedPaths?: readonly string[];
}

interface ApplyPatchToolInput extends ToolExecutionInjectedArgs {
  readonly input?: unknown;
  readonly cwd?: unknown;
  readonly [SESSION_ID_ARG]?: unknown;
}

function pathsForHunk(hunk: ApplyPatchHunk): readonly {
  readonly path: string;
  readonly operationType: "write" | "create";
}[] {
  switch (hunk.kind) {
    case "add":
      return [{ path: hunk.path, operationType: "create" }];
    case "delete":
      return [{ path: hunk.path, operationType: "write" }];
    case "update":
      return hunk.movePath === null
        ? [{ path: hunk.path, operationType: "write" }]
        : [
            { path: hunk.path, operationType: "write" },
            { path: hunk.movePath, operationType: "write" },
          ];
    default: {
      const exhaustive: never = hunk;
      return exhaustive;
    }
  }
}

function permissionForPatch(
  input: Record<string, unknown>,
  patch: string,
  cwd: string,
  allowedPaths: readonly string[],
  context: Parameters<NonNullable<Tool["checkPermissions"]>>[1],
): PermissionResult {
  let hunks: readonly ApplyPatchHunk[];
  try {
    hunks = parsePatch(patch).hunks;
  } catch (error) {
    // SECURITY: fail CLOSED on an unparseable patch. The previous
    // fail-open `behavior: "allow"` let a malformed patch skip the
    // per-target path-permission check entirely; an attacker could
    // dodge confinement by sending input that the strict parser
    // rejects but the apply path still partially honors. Deny instead.
    const reason = `apply_patch payload could not be parsed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return {
      behavior: "deny",
      message: reason,
      decisionReason: {
        type: "safetyCheck",
        reason,
        classifierApprovable: false,
      },
    };
  }

  for (const hunk of hunks) {
    for (const target of pathsForHunk(hunk)) {
      const result = checkToolPathPermission({
        toolName: APPLY_PATCH_TOOL_NAME,
        input,
        path: target.path,
        cwd,
        context: context.getAppState().toolPermissionContext,
        operationType: target.operationType,
        extraWorkingDirectories: allowedPaths,
      });
      if (result.behavior !== "allow") return result;
    }
  }

  return { behavior: "allow", updatedInput: input };
}

export function createApplyPatchTool(config: ApplyPatchToolConfig): Tool {
  const allowedPaths = config.allowedPaths ?? [config.cwd];

  return {
    name: APPLY_PATCH_TOOL_NAME,
    description: APPLY_PATCH_DESCRIPTION,
    metadata: {
      family: "filesystem",
      source: "builtin",
      keywords: ["patch", "edit", "file", "diff"],
      preferredProfiles: ["coding", "general"],
      hiddenByDefault: true,
      mutating: true,
      deferred: true,
    },
    requiresApproval: true,
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "The full apply_patch payload.",
        },
      },
      required: ["input"],
      additionalProperties: false,
    },
    checkPermissions(input, context) {
      const args = input as ApplyPatchToolInput;
      const patch = asNonEmptyString(args.input);
      if (!patch) {
        return {
          behavior: "ask",
          message: "input must be a non-empty string",
        };
      }
      const cwd = asNonEmptyString(args.cwd) ?? config.cwd;
      // SECURITY: check permissions against the TRUSTED closure roots
      // only (mirror FileWriteTool/FileEditTool, file-write.ts:231).
      // Folding `resolveToolAllowedPaths(..., input)` here would honor a
      // model-supplied `__agencSessionAllowedRoots`, defeating
      // confinement. Runtime-injected roots are still applied at execute
      // time via `safePathAllowingSessionPlanFile`.
      return permissionForPatch(
        input as Record<string, unknown>,
        patch,
        cwd,
        allowedPaths,
        context,
      );
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as ApplyPatchToolInput;
      const patch = asNonEmptyString(args.input);
      if (!patch) return errorResult("input must be a non-empty string");

      const cwd = asNonEmptyString(args.cwd) ?? config.cwd;
      const sessionId = asNonEmptyString(args[SESSION_ID_ARG]);

      try {
        const result = await applyPatchText(patch, {
          cwd,
          // Pass the TRUSTED closure roots; `applyPatchText` folds any
          // runtime-injected `__agencSessionAllowedRoots` from `rawArgs`
          // through `safePathAllowingSessionPlanFile`. Pre-folding with
          // `resolveToolAllowedPaths(allowedPaths, rawArgs)` is redundant
          // and was the same model-controlled widening vector.
          allowedPaths,
          rawArgs,
          ...(sessionId !== undefined ? { sessionId } : {}),
        });
        return {
          content: result.summary,
          metadata: result.metadata,
        };
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}
