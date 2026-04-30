/**
 * Per-dir CacheSafeParams shim for `runtime/src/session/**`.
 *
 * Mirrors the shape `runtime/src/utils/forkedAgent.ts` exposes for
 * compact cache-safe forking. Carved as a local `_deps/` so the
 * session tree stays resolvable after the AgenC umbrella
 * `src/utils/forkedAgent.ts` is removed.
 *
 * The AgenC adapter only constructs/consumes `CacheSafeParams`;
 * it never invokes `runForkedAgent`. The shape here mirrors the public
 * surface using permissive types where the lean rebuild has not yet
 * settled the system-prompt/tool-use-context shape.
 */

import type { SystemPrompt } from "./system-prompt.js";
import type { Message } from "./types-message.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolUseContext = any;

export type CacheSafeParams = {
  systemPrompt: SystemPrompt;
  userContext: { [k: string]: string };
  systemContext: { [k: string]: string };
  toolUseContext: ToolUseContext;
  forkContextMessages: Message[];
};
