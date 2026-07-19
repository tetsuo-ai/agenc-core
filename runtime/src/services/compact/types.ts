/**
 * Compact service shared types.
 *
 * Source snapshot: `src/services/compact/*` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 *
 * This file keeps the live AgenC compact service independent from the
 * short-lived upstream mirror and from excluded UI/session modules.
 */

import type { LLMProvider } from "../../llm/types.js";
import type { Session } from "../../session/session.js";

export type RuntimeMessage = {
  readonly role?: "system" | "user" | "assistant" | "tool";
  readonly originalRole?: "system" | "developer" | "user" | "assistant" | "tool";
  readonly type?: string;
  readonly content?: unknown;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly phase?: string;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments?: string;
  }[];
  readonly message?: {
    readonly role?: string;
    readonly content?: unknown;
  };
  readonly uuid?: string;
  readonly timestamp?: string;
  readonly isMeta?: boolean;
};

export type CompactContext = {
  readonly abortController?: AbortController;
  readonly provider?: LLMProvider;
  /** Live owner used to admit every provider-backed compaction pass. */
  readonly admissionSession?: Session;
  readonly setStreamMode?: (mode: "requesting" | "responding" | null) => void;
  readonly setResponseLength?: (updater: (length: number) => number) => void;
  readonly onCompactProgress?: (event: CompactProgressEvent) => void;
  readonly setSDKStatus?: (status: "compacting" | null) => void;
  readonly options?: {
    readonly mainLoopModel?: string;
    readonly contextWindowTokens?: number;
    readonly maxOutputTokens?: number;
    readonly querySource?: string;
    readonly apiMicrocompact?: {
      readonly clearThinking?: boolean;
      readonly clearToolResults?: boolean;
      readonly clearToolUses?: boolean;
    };
  };
  readonly deps?: CompactRuntimeDeps;
};

export type CompactProgressEvent =
  | {
      readonly type: "hooks_start";
      readonly hookType: "pre_compact" | "post_compact" | "session_start";
    }
  | { readonly type: "compact_start" }
  | { readonly type: "compact_end" };

export type CompactCleanupDeps = {
  readonly clearReadFileState?: () => void;
  readonly clearProviderResponseId?: () => void;
  readonly clearSearchIndexes?: () => void;
  readonly clearToolIndexes?: () => void;
  readonly resetMicrocompactState?: () => void;
};

export type CompactRuntimeDeps = {
  readonly createAttachments?: (
    messages: readonly RuntimeMessage[],
    context: CompactContext,
  ) => RuntimeMessage[] | Promise<RuntimeMessage[]>;
  readonly createHookResults?: (
    summary: string,
    context: CompactContext,
  ) => RuntimeMessage[] | Promise<RuntimeMessage[]>;
  readonly cleanup?: CompactCleanupDeps;
  readonly sessionMemory?: {
    readonly getContent?: () => string | null | Promise<string | null>;
    readonly isEmpty?: () => boolean | Promise<boolean>;
  };
};

export type CompactionResult = {
  readonly boundaryMarker: RuntimeMessage;
  readonly summaryMessages: readonly RuntimeMessage[];
  readonly attachments: readonly RuntimeMessage[];
  readonly hookResults: readonly RuntimeMessage[];
  readonly messagesToKeep?: readonly RuntimeMessage[];
  readonly userDisplayMessage?: string;
  readonly preCompactTokenCount?: number;
  readonly postCompactTokenCount?: number;
  readonly truePostCompactTokenCount?: number;
};
