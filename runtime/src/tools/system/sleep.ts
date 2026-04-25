/**
 * `Sleep` — port of openclaude `SleepTool`.
 *
 * The model-facing prompt is byte-identical to openclaude's at
 * `src/tools/SleepTool/prompt.ts`. Openclaude's actual implementation
 * isn't in the open-source mirror (the SleepTool.ts file is a runtime
 * stub loaded via `require('./tools/SleepTool/SleepTool.js')` in
 * `src/tools.ts:18-20`); the implementation below is the minimal
 * setTimeout-based wait that honors the abort signal.
 *
 * Schema: `{ durationMs: number }`. The `tick` poll-mention and
 * "5-minute prompt cache" guidance are kept verbatim from upstream so
 * a model trained on openclaude prompts behaves identically here.
 *
 * @module
 */

import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";

const SLEEP_MIN_MS = 0;
const SLEEP_MAX_MS = 60 * 60 * 1000; // 1 hour ceiling — same as openclaude.

/**
 * Verbatim port of openclaude `SLEEP_TOOL_PROMPT`
 * (src/tools/SleepTool/prompt.ts:6-16). The `<tick>` reference matches
 * `TICK_TAG = 'tick'` from openclaude `src/constants/xml.ts:25`.
 */
const SLEEP_DESCRIPTION = `Wait for a specified duration. The user can interrupt the sleep at any time.

Use this when the user tells you to sleep or rest, when you have nothing to do, or when you're waiting for something.

You may receive <tick> prompts — these are periodic check-ins. Look for useful work to do before sleeping.

You can call this concurrently with other tools — it won't interfere with them.

Prefer this over \`Bash(sleep ...)\` — it doesn't hold a shell process.

Each wake-up costs an API call, but the prompt cache expires after 5 minutes of inactivity — balance accordingly.`;

interface SleepToolInput extends ToolExecutionInjectedArgs {
  readonly durationMs?: unknown;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function createSleepTool(): Tool {
  return {
    name: "Sleep",
    description: SLEEP_DESCRIPTION,
    metadata: {
      family: "utility",
      source: "builtin",
      keywords: ["sleep", "wait", "delay", "tick"],
      preferredProfiles: ["coding", "general", "operator"],
      hiddenByDefault: false,
      mutating: false,
      deferred: false,
    },
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        durationMs: {
          type: "number",
          description:
            "How long to sleep, in milliseconds. The user can interrupt at any time.",
        },
      },
      required: ["durationMs"],
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const args = rawArgs as SleepToolInput;
      const requested = asNumber(args.durationMs);
      if (requested === undefined) {
        return {
          content: "durationMs must be a finite number of milliseconds",
          isError: true,
        };
      }
      const durationMs = Math.max(
        SLEEP_MIN_MS,
        Math.min(SLEEP_MAX_MS, Math.floor(requested)),
      );
      const startedAt = Date.now();
      const signal = args.__abortSignal;
      try {
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("Sleep aborted", "AbortError"));
            return;
          }
          const timer = setTimeout(() => {
            cleanup();
            resolve();
          }, durationMs);
          timer.unref?.();
          const onAbort = (): void => {
            cleanup();
            reject(new DOMException("Sleep aborted", "AbortError"));
          };
          const cleanup = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      } catch (err) {
        const elapsedMs = Date.now() - startedAt;
        return {
          content: `Sleep interrupted after ${elapsedMs}ms`,
          isError: true,
          metadata: {
            interrupted: true,
            elapsedMs,
            requestedMs: durationMs,
          },
        };
      }
      const elapsedMs = Date.now() - startedAt;
      return {
        content: `Slept ${elapsedMs}ms`,
        metadata: {
          interrupted: false,
          elapsedMs,
          requestedMs: durationMs,
        },
      };
    },
  };
}

export default createSleepTool;
