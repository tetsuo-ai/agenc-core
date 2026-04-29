/**
 * Execution-envelope helpers extracted from chat-executor-tool-loop.
 *
 * The execution envelope is a per-turn policy surface carried on the
 * turn's runtime context. It declares allowedTools (tools the model
 * may invoke), allowedReadRoots / allowedWriteRoots (filesystem
 * scoping), and a workspaceRoot (the origin for relative paths).
 *
 * This module owns three pure helpers:
 * - classifying which filesystem-tool names are "read" vs "write"
 *   under the envelope's access-mode rules
 * - canonicalizing explicit artifact references in tool arguments
 *   (so `src/main.c` in args resolves to an absolute path matching
 *   the declared artifacts)
 * - enforcing the envelope at the top-level tool-dispatch boundary
 *   and returning a string error message when the call violates it
 *
 * All three are pure functions over their inputs; no loop state, no
 * callbacks, no side effects beyond building a fresh args object in
 * canonicalizeExplicitArtifactReferenceArgs.
 *
 * @module
 */

import { type ArtifactAccessMode } from "../workflow/artifact-contract.js";
import type { ExecutionEnvelope } from "../workflow/execution-envelope.js";
import {
  isPathWithinAnyRoot,
  normalizeEnvelopePath,
  normalizeEnvelopeRoots,
  normalizeWorkspaceRoot,
  resolveExplicitArtifactReferencePath,
} from "../workflow/path-normalization.js";

const READ_ONLY_ENVELOPE_TOOL_NAMES = new Set([
  "system.readFile",
  "system.listDir",
  "system.stat",
]);

const WRITE_ENVELOPE_TOOL_MODES: Readonly<Record<string, ArtifactAccessMode>> = {
  "desktop.text_editor": "write",
  "system.writeFile": "write",
  "system.appendFile": "write",
  "system.delete": "write",
  "system.mkdir": "write",
  "system.move": "write",
};

const ENVELOPE_TOOL_PATH_ARG_KEYS: Readonly<Record<string, readonly string[]>> = {
  "desktop.text_editor": ["path"],
  "system.readFile": ["path"],
  "system.writeFile": ["path"],
  "system.appendFile": ["path"],
  "system.listDir": ["path"],
  "system.stat": ["path"],
  "system.mkdir": ["path"],
  "system.delete": ["path"],
  "system.move": ["source", "destination"],
};

/**
 * Map a tool name to the filesystem access mode the envelope should
 * treat it as — "read" for path-inspection tools, "write" for
 * mutating tools, undefined for tools that don't touch the
 * filesystem. Used to pick which allowed-roots list to consult.
 */
export function getExecutionEnvelopeFilesystemAccessMode(
  toolName: string,
): ArtifactAccessMode | undefined {
  if (READ_ONLY_ENVELOPE_TOOL_NAMES.has(toolName)) {
    return "read";
  }
  return WRITE_ENVELOPE_TOOL_MODES[toolName];
}

/**
 * Canonicalize path-bearing arguments against the declared-artifacts
 * manifest. When the model supplies a short form like `src/main.c`
 * and an absolute artifact path is declared for the turn, rewrite
 * the argument to the absolute path. Returns the (possibly new) args
 * object plus a list of fields that were canonicalized (for tracing).
 *
 * Argument object is only cloned when at least one field is rewritten
 * — otherwise the input is returned unchanged.
 */
export function canonicalizeExplicitArtifactReferenceArgs(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly workspaceRoot?: string;
  readonly declaredArtifacts?: readonly string[];
}): {
  readonly args: Record<string, unknown>;
  readonly canonicalizedFields: readonly string[];
} {
  const pathKeys = ENVELOPE_TOOL_PATH_ARG_KEYS[params.toolName] ?? [];
  if (pathKeys.length === 0) {
    return { args: params.args, canonicalizedFields: [] };
  }

  let nextArgs = params.args;
  const canonicalizedFields: string[] = [];
  for (const key of pathKeys) {
    const rawValue = nextArgs[key];
    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      continue;
    }
    const canonicalPath = resolveExplicitArtifactReferencePath({
      rawPath: rawValue,
      workspaceRoot: params.workspaceRoot,
      declaredArtifacts: params.declaredArtifacts,
    });
    if (!canonicalPath || canonicalPath === rawValue) {
      continue;
    }
    if (nextArgs === params.args) {
      nextArgs = { ...params.args };
    }
    nextArgs[key] = canonicalPath;
    canonicalizedFields.push(`${key}:artifact_ref`);
  }

  return { args: nextArgs, canonicalizedFields };
}

/**
 * Enforce the top-level execution envelope against a tool call.
 * Returns an error string on violation, undefined on pass.
 *
 * Checks performed, in order:
 * 1. Tool name must be in envelope.allowedTools (when that list is set)
 * 2. Path arguments must be within envelope.allowedReadRoots or
 *    envelope.allowedWriteRoots depending on the tool's access mode
 *
 * Tools that don't match a filesystem access mode and pass the
 * allowedTools check are accepted without a path check.
 */
export function enforceTopLevelExecutionEnvelope(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly executionEnvelope?: ExecutionEnvelope;
  readonly defaultWorkingDirectory?: string;
}): string | undefined {
  const envelope = params.executionEnvelope;
  if (!envelope) return undefined;

  if (
    envelope.allowedTools?.length &&
    !envelope.allowedTools.includes(params.toolName)
  ) {
    return `Tool ${params.toolName} is outside the execution envelope for this turn`;
  }

  const mode = getExecutionEnvelopeFilesystemAccessMode(params.toolName);
  if (!mode) {
    return undefined;
  }

  const pathKeys = ENVELOPE_TOOL_PATH_ARG_KEYS[params.toolName] ?? [];
  if (pathKeys.length === 0) {
    return undefined;
  }

  const workspaceRoot =
    normalizeWorkspaceRoot(envelope.workspaceRoot) ??
    params.defaultWorkingDirectory;
  const allowedRoots = normalizeEnvelopeRoots(
    mode === "read"
      ? envelope.allowedReadRoots ?? []
      : envelope.allowedWriteRoots ?? [],
    workspaceRoot,
  );
  for (const key of pathKeys) {
    const rawValue = params.args[key];
    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      continue;
    }
    const normalizedPath = normalizeEnvelopePath(rawValue, workspaceRoot);
    if (
      allowedRoots.length > 0 &&
      !isPathWithinAnyRoot(normalizedPath, allowedRoots)
    ) {
      return `Path ${normalizedPath} is outside the execution envelope roots for this turn`;
    }
  }

  return undefined;
}
