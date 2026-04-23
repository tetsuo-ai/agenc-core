/**
 * Per-dir message-type stubs for `runtime/src/session/**`.
 *
 * Mirrors the openclaude `runtime/src/types/message.ts` stub so the
 * session tree stays decoupled from the openclaude-port path tree
 * once the umbrella `src/types/` directory is removed.
 *
 * Session callers use these as type-only references; permissive
 * `any`-typed aliases are sufficient.
 */

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
