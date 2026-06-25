/**
 * Phase-yielded event envelope.
 *
 * Each phase may yield events into a shared event channel. Today the
 * run-turn dispatcher yields the pre-existing `QueryEvent` shape so
 * bin/agenc.ts's renderer doesn't need to change. T6 wires the full
 * event-log protocol (EventMsg discriminated union, sidecar consumers).
 *
 * @module
 */

import type {
  LLMContentPart,
  LLMToolCall,
  LLMUsage,
} from "../llm/types.js";
import type { ToolDispatchResult } from "./_deps/tool-registry.js";

export type PhaseEvent =
  | { readonly type: "turn_start"; readonly turnIndex: number }
  | { readonly type: "history_cleared"; readonly timestamp: number }
  | {
      readonly type: "assistant_text";
      readonly content: string;
      readonly usage?: LLMUsage;
      readonly model?: string;
    }
  | { readonly type: "tool_call"; readonly toolCall: LLMToolCall }
  | {
      readonly type: "tool_result";
      readonly toolCall: LLMToolCall;
      readonly result: ToolDispatchResult;
    }
  | {
      readonly type: "queued_command";
      readonly uuid: string;
      readonly commandMode: "prompt" | "task-notification";
      readonly content: string | readonly LLMContentPart[];
      readonly displayText: string;
      readonly isMeta?: true;
      readonly originKind?: string;
    }
  | {
      readonly type: "turn_complete";
      readonly content: string;
      readonly usage: LLMUsage;
      readonly stopReason:
        | "completed"
        | "max_turns"
        | "cancelled"
        | "error"
        | "empty_response"
        | "no_progress"; // behavioral backstop (semantic non-termination, goal #3)
      readonly error?: Error;
    };
