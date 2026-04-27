/**
 * Re-exports the AgenC implementation shims that the session subsystem needs
 * for compact-adjacent calls. These were previously local stubs that
 * silently dropped state; both surfaces now have canonical
 * implementations elsewhere in the gut runtime:
 *
 * - `notifyCompaction`: prompt-cache break-detection signal. The gut
 *   runtime does not own the AgenC prompt-cache subsystem, so the
 *   canonical version remains a no-op, but it lives alongside the rest
 *   of the AgenC implementation no-op surface in
 *   `src/llm/compact/_deps/no-op.ts`.
 *
 * - `setLastSummarizedMessageId`: SessionMemory anchor for the next
 *   compact pass. The canonical version in
 *   `src/llm/compact/_deps/session-memory.ts` is a real implementation
 *   with persistence under `${AGENC_HOME}/memory/last-summarized.json`.
 *   The previous local stub silently dropped writes, which broke the
 *   manual-compact path's cleanup contract.
 */

export { notifyCompaction } from "../../llm/compact/_deps/no-op.js";
export { setLastSummarizedMessageId } from "../../llm/compact/_deps/session-memory.js";
