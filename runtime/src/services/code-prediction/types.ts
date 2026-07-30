import type { LLMProvider, LLMUsage } from "../../llm/types.js";

export const CODE_PREDICTION_PROTOCOL_MAX_BYTES = 96 * 1024;
export const CODE_PREDICTION_MODEL_CONTEXT_MAX_BYTES = 54 * 1024;
export const CODE_PREDICTION_MAX_FILE_BYTES = 1024 * 1024;

export interface CodePredictionCursor {
  /** Zero-based line. */
  readonly line: number;
  /** Zero-based UTF-8 byte column, matching Neovim's cursor protocol. */
  readonly byteColumn: number;
}

export interface CodePredictionDiagnostic {
  readonly message: string;
  readonly severity?: "error" | "warning" | "information" | "hint";
}

export interface CodePredictionRelatedBuffer {
  readonly path: string;
  readonly language?: string;
  readonly content: string;
}

/**
 * Exact editor snapshot used for one speculative prediction.
 *
 * The caller owns debounce and UI suppression. The daemon re-checks byte
 * bounds, workspace containment, sensitive paths, and stale request identity
 * before any provider call.
 */
export interface CodePredictionRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly editorInstanceId: string;
  readonly bufferHandle: number;
  readonly generation: number;
  readonly changedtick: number;
  readonly path: string;
  /**
   * Exact UTF-8 buffer size reported by the editor before the bounded
   * prefix/suffix window is captured. This preserves the whole-file privacy
   * limit without copying the whole buffer over RPC.
   */
  readonly fileBytes: number;
  readonly language?: string;
  readonly cursor: CodePredictionCursor;
  readonly prefix: string;
  readonly suffix: string;
  readonly header?: string;
  readonly diagnostics?: readonly CodePredictionDiagnostic[];
  readonly latestIntent?: string;
  readonly relatedBuffers?: readonly CodePredictionRelatedBuffer[];
}

export type CodePredictionSuppressionReason =
  | "cancelled"
  | "consent_required"
  | "disabled"
  | "outside_workspace"
  | "sensitive_path"
  | "binary_content"
  | "file_too_large"
  | "payload_too_large"
  | "output_too_large"
  | "rate_limited"
  | "admission_timeout"
  | "stale"
  | "empty";

export interface CodePredictionCompletion {
  readonly status: "completed";
  readonly requestId: string;
  readonly generation: number;
  readonly changedtick: number;
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly cached: boolean;
  readonly usage?: LLMUsage;
}

export interface CodePredictionSuppressed {
  readonly status: "suppressed";
  readonly requestId: string;
  readonly generation: number;
  readonly changedtick: number;
  readonly reason: CodePredictionSuppressionReason;
}

export type CodePredictionResult =
  CodePredictionCompletion | CodePredictionSuppressed;

export type CodePredictionFeedbackKind =
  "displayed" | "accepted" | "partially_accepted" | "dismissed";

export interface CodePredictionFeedback {
  readonly sessionId: string;
  readonly editorInstanceId: string;
  readonly requestId: string;
  readonly kind: CodePredictionFeedbackKind;
  readonly acceptedCharacters?: number;
  readonly latencyMs?: number;
}

export interface CodePredictionSource {
  /** Current live session provider. It is inspected but never called. */
  readonly provider: LLMProvider;
  readonly workspaceRoot: string;
}

export interface OwnedCodePredictionProvider {
  readonly provider: LLMProvider;
  readonly providerName: string;
  readonly model: string;
  readonly routeKey: string;
  dispose(): Promise<void>;
}

export type CodePredictionSourceResolver = (
  sessionId: string,
) => Promise<CodePredictionSource> | CodePredictionSource;

export type CodePredictionMetric =
  | {
      readonly type: "request";
      readonly sessionId: string;
      readonly outcome:
        "completed" | "cached" | CodePredictionSuppressionReason | "error";
      readonly latencyMs: number;
    }
  | {
      readonly type: "feedback";
      readonly sessionId: string;
      readonly kind: CodePredictionFeedbackKind;
      readonly acceptedCharacters?: number;
      readonly latencyMs?: number;
    };
