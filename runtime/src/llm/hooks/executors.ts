/**
 * Hook executors. One executor per hook kind.
 *
 * The command/http paths match the reference runtime's stdin JSON
 * schema (snake_case keys: `session_id`, `transcript_path`, `cwd`,
 * `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`,
 * `tool_response`, `error`, `is_interrupt`) and exit-code contract
 * (0 = passthrough / noop, 2 = deny with stderr, other non-zero =
 * non-blocking error logged through `outcome.message`).
 *
 * @module
 */

import { spawn } from "node:child_process";
import type { HookContext, HookDefinition, HookOutcome } from "./types.js";

export type HookExecutor = (
  definition: HookDefinition,
  context: HookContext,
) => Promise<HookOutcome>;

/**
 * Default composite executor: dispatch on `definition.kind`. Callers
 * may register their own (e.g. inject a mock for tests).
 */
export const defaultHookExecutor: HookExecutor = async (definition, context) => {
  switch (definition.kind) {
    case "command":
      return runCommandHook(definition, context);
    case "callback":
    case "function":
      // Callback / function hooks need a runtime-side registry that
      // chat-executor / gateway will own. For now no-op so the chain
      // composes cleanly until that wiring lands.
      return { action: "noop" };
    case "http":
      return runHttpHook(definition, context);
    default:
      return { action: "noop" };
  }
};

/**
 * Build the upstream-compatible stdin payload for command/http hooks.
 * Fields use snake_case to match the reference runtime's `HookInput`
 * shape so user scripts ported from that ecosystem work unchanged.
 */
function buildHookStdinPayload(context: HookContext): Record<string, unknown> {
  const base: Record<string, unknown> = {
    session_id: context.sessionId,
    hook_event_name: context.event,
  };
  if (context.transcriptPath !== undefined) {
    base.transcript_path = context.transcriptPath;
  }
  if (context.cwd !== undefined) {
    base.cwd = context.cwd;
  }
  if (context.permissionMode !== undefined) {
    base.permission_mode = context.permissionMode;
  }

  switch (context.event) {
    case "PreToolUse":
      return {
        ...base,
        tool_name: context.toolCall.name,
        tool_use_id: context.toolCall.id,
        tool_input: context.parsedInput ?? {},
      };
    case "PostToolUse":
      return {
        ...base,
        tool_name: context.toolCall.name,
        tool_use_id: context.toolCall.id,
        tool_input: context.parsedInput ?? {},
        tool_response: context.result,
      };
    case "PostToolUseFailure":
      return {
        ...base,
        tool_name: context.toolCall.name,
        tool_use_id: context.toolCall.id,
        tool_input: context.parsedInput ?? {},
        error: context.errorMessage,
        ...(context.isInterrupt !== undefined
          ? { is_interrupt: context.isInterrupt }
          : {}),
      };
    case "SessionStart":
    case "Stop":
    case "StopFailure":
      return {
        ...base,
        ...(context.stopReason !== undefined
          ? { stop_reason: context.stopReason }
          : {}),
        ...(context.stopReasonDetail !== undefined
          ? { stop_reason_detail: context.stopReasonDetail }
          : {}),
      };
    case "PreCompact":
    case "PostCompact":
      return { ...base, compaction_layer: context.layer };
    default:
      return base;
  }
}

async function runCommandHook(
  definition: HookDefinition,
  context: HookContext,
): Promise<HookOutcome> {
  return new Promise((resolve) => {
    const start = Date.now();
    const payload = JSON.stringify(buildHookStdinPayload(context));
    const child = spawn("/bin/sh", ["-c", definition.target], {
      env: {
        ...process.env,
        AGENC_HOOK_EVENT: definition.event,
        AGENC_HOOK_SESSION_ID: context.sessionId ?? "",
      },
      cwd: context.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin.on("error", () => undefined);
    try {
      // Trailing newline keeps `read -r line` shells from hitting EOF
      // before the delimiter — see upstream gh-30509.
      child.stdin.end(`${payload}\n`);
    } catch {
      // If stdin closes before write completes the child will still
      // run; resolve via the exit handler below.
    }
    child.on("error", () => {
      resolve({
        action: "noop",
        message: "hook command spawn failed",
        durationMs: Date.now() - start,
      });
    });
    child.on("exit", (code) => {
      const durationMs = Date.now() - start;
      if (code === 0) {
        resolve({
          action: "noop",
          ...(stdout.trim().length > 0 ? { message: stdout.trim() } : {}),
          durationMs,
        });
      } else if (code === 2) {
        // Convention: exit code 2 means "block" — surface as deny.
        resolve({
          action: "deny",
          message:
            stderr.trim() ||
            stdout.trim() ||
            `hook exited with code 2`,
          durationMs,
        });
      } else {
        resolve({
          action: "noop",
          message:
            stderr.trim() ||
            `hook exited with code ${code ?? "unknown"}`,
          durationMs,
        });
      }
    });
  });
}

async function runHttpHook(
  definition: HookDefinition,
  context: HookContext,
): Promise<HookOutcome> {
  const start = Date.now();
  try {
    const response = await fetch(definition.target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildHookStdinPayload(context)),
    });
    if (response.status === 204) {
      return { action: "noop", durationMs: Date.now() - start };
    }
    const json = (await response.json().catch(() => null)) as
      | { action?: string; message?: string; updatedInput?: Record<string, unknown> }
      | null;
    if (json?.action === "deny") {
      return {
        action: "deny",
        message: json.message,
        durationMs: Date.now() - start,
      };
    }
    if (json?.action === "allow" && json.updatedInput) {
      return {
        action: "allow",
        updatedInput: json.updatedInput,
        durationMs: Date.now() - start,
      };
    }
    return { action: "noop", durationMs: Date.now() - start };
  } catch (error) {
    return {
      action: "noop",
      message: error instanceof Error ? error.message : "http hook failed",
      durationMs: Date.now() - start,
    };
  }
}
