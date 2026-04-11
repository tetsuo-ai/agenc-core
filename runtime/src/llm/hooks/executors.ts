/**
 * Hook executors (Cut 5.2). One executor per hook kind.
 *
 * Mirrors the spawn / fetch / require dispatch in
 * `claude_code/utils/hooks.ts:executeHookCommand`.
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

async function runCommandHook(
  definition: HookDefinition,
  context: HookContext,
): Promise<HookOutcome> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn("/bin/sh", ["-c", definition.target], {
      env: {
        ...process.env,
        AGENC_HOOK_EVENT: definition.event,
        AGENC_HOOK_SESSION_ID: context.sessionId ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
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
        resolve({ action: "noop", durationMs });
      } else if (code === 2) {
        // Convention: exit code 2 means "block" — surface as deny.
        resolve({
          action: "deny",
          message: stderr.trim() || `hook exited with code 2`,
          durationMs,
        });
      } else {
        resolve({
          action: "noop",
          message: stderr.trim(),
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
      body: JSON.stringify({
        event: definition.event,
        sessionId: context.sessionId,
        chainId: context.chainId,
        depth: context.depth,
      }),
    });
    if (response.status === 204) {
      return { action: "noop", durationMs: Date.now() - start };
    }
    const json = (await response.json().catch(() => null)) as
      | { action?: string; message?: string }
      | null;
    if (json?.action === "deny") {
      return {
        action: "deny",
        message: json.message,
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
