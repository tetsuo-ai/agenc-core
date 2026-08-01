/**
 * Per-dir tool-shape surface for `runtime/src/agents/**`.
 *
 * The agent runtime only needs a duck-typed `Tool` shape and the
 * bigint-safe stringify helper to wrap tools / forward dispatch results
 * back to the parent registry. Carved as a local `_deps/` to cut the
 * gut→AgenC crossing.
 */

export type JSONSchema = Record<string, unknown>;

export interface ToolEffectDispositionEvidence {
  readonly disposition:
    | "confirmed_committed"
    | "confirmed_no_effect"
    | "remains_unknown";
  readonly evidenceKind:
    | "provider_receipt"
    | "idempotency_lookup"
    | "boundary_not_crossed";
  readonly evidenceRef: string;
  readonly evidenceSha256: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
  admissionUsage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
  };
  effectDisposition?: ToolEffectDispositionEvidence;
}

export type ToolRecoveryCategory =
  | "idempotent"
  | "side-effecting"
  | "interactive";

// Permissive Tool shape. Any extra metadata fields the parent registry
// attaches (concurrency class, approval flags, etc.) are forwarded
// through `Record<string, any>` without coupling to upstream types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
} & Record<string, any>;

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function safeStringify(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}
