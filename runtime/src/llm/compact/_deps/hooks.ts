/**
 * Compact hook entry points. The compact subsystem fires PreCompact /
 * PostCompact / SessionStart hooks at compaction boundaries; this module
 * adapts those callsites to the gut lifecycle hook dispatcher in
 * `runtime/src/llm/hooks/`.
 *
 * The adapter intentionally mirrors the upstream `claude/src/utils/hooks.ts`
 * + `claude/src/utils/sessionStart.ts` shapes the compact pipeline already
 * consumes (newCustomInstructions / userDisplayMessage; HookResultMessage[]
 * for SessionStart) so no compact-side glue had to change.
 */

import {
  dispatchPostCompact,
  dispatchPreCompact,
  dispatchSessionStart,
  getLifecycleHookRegistry,
  type CompactTrigger,
  type PostCompactDispatchResult,
  type PreCompactDispatchResult,
  type SessionStartSource,
} from "../../hooks/index.js";
import type { HookResultMessage } from "./types-message.js";

interface PreCompactArgs {
  readonly trigger: CompactTrigger;
  readonly customInstructions: string | null;
}

export async function executePreCompactHooks(
  compactData: PreCompactArgs,
  signal?: AbortSignal,
): Promise<PreCompactDispatchResult> {
  return dispatchPreCompact(
    {
      hook_event_name: "PreCompact",
      trigger: compactData.trigger,
      custom_instructions: compactData.customInstructions,
    },
    {
      hooks: getLifecycleHookRegistry().getPreCompact(),
      signal,
    },
  );
}

interface PostCompactArgs {
  readonly trigger: CompactTrigger;
  readonly compactSummary: string;
}

export async function executePostCompactHooks(
  compactData: PostCompactArgs,
  signal?: AbortSignal,
): Promise<PostCompactDispatchResult> {
  return dispatchPostCompact(
    {
      hook_event_name: "PostCompact",
      trigger: compactData.trigger,
      compact_summary: compactData.compactSummary,
    },
    {
      hooks: getLifecycleHookRegistry().getPostCompact(),
      signal,
    },
  );
}

interface SessionStartOpts {
  readonly sessionId?: string;
  readonly agentType?: string;
  readonly model?: string;
}

export async function processSessionStartHooks(
  source: SessionStartSource,
  opts: SessionStartOpts = {},
  signal?: AbortSignal,
): Promise<HookResultMessage[]> {
  return dispatchSessionStart(
    {
      hook_event_name: "SessionStart",
      source,
      ...(opts.sessionId !== undefined ? { session_id: opts.sessionId } : {}),
      ...(opts.agentType !== undefined ? { agent_type: opts.agentType } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    },
    {
      hooks: getLifecycleHookRegistry().getSessionStart(),
      signal,
    },
  );
}
