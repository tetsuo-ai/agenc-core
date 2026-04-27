/**
 * Per-dir message-type stubs for `runtime/src/llm/compact/**`.
 *
 * Mirrors the AgenC `runtime/src/types/message.ts` stub so the
 * compact tree stays decoupled from the AgenC implementation path tree
 * once the umbrella `src/types/` directory is removed.
 *
 * The compact path uses these as type-only references; permissive
 * `any`-typed aliases are sufficient.
 */

// Use an intersection of `any` and a no-op branded type so that narrowing
// type guards like `isCompactBoundaryMessage(m): m is SystemCompactBoundaryMessage`
// do not collapse the remainder to `never`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Message = any & { readonly __message_stub?: unique symbol };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AssistantMessage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UserMessage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SystemMessage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AttachmentMessage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HookResultMessage = any;
export interface SystemCompactBoundaryMessage {
  readonly __kind: "compact_boundary";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SystemMicrocompactBoundaryMessage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PartialCompactDirection = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NormalizedMessage = any;
