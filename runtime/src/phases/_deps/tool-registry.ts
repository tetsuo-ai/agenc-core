/**
 * Per-dir tool-registry shape for `runtime/src/phases/**`.
 *
 * The phases path only references `ToolDispatchResult` from the root
 * `runtime/src/tool-registry.ts`. Carved as a local `_deps/` so the
 * gut phase tree stays decoupled from the AgenC umbrella when
 * the root tool-registry is removed.
 */

import type { FunctionCallOutputContentItem } from "../../tools/context.js";

export interface ToolDispatchResult {
  readonly content: string;
  readonly isError?: boolean;
  readonly codeModeResult?: unknown;
  readonly contentItems?: readonly FunctionCallOutputContentItem[];
  readonly metadata?: Record<string, unknown>;
}
