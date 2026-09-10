import { createHash } from "node:crypto";

const MAX_AUDITED_TEMPLATE_BYTES = 64 * 1024;

// Ollama v0.32.5 infers native tool support from the substrings "tools" or
// "tool_call", including history-only references:
// https://github.com/ollama/ollama/blob/v0.32.5/server/images.go#L194-L195
// This exact active template was independently checked with /api/chat's
// _debug_render_only: the advertised probe schema/name were both absent.
// Provenance and the licensed fixture live in tests/llm/providers/ollama/fixtures.
// Do not generalize this to model names, substring/grammar guesses, or modified
// templates: unknown templates retain the server's native capability decision.
const VERIFIED_MISSING_TOOL_CATALOG_SHA256 = new Set([
  "b6835114b7303ddd78919a82e4d9f7d8c26ed0d7dfc36beeb12d524f6144eab1",
]);

/** Recognizes only exact, audited templates that omit incoming tool schemas. */
export function ollamaTemplateRequiresTextTools(template: unknown): boolean {
  if (typeof template !== "string" || template.length === 0 ||
    template.length > MAX_AUDITED_TEMPLATE_BYTES ||
    Buffer.byteLength(template, "utf8") > MAX_AUDITED_TEMPLATE_BYTES) {
    return false;
  }
  return VERIFIED_MISSING_TOOL_CATALOG_SHA256.has(
    createHash("sha256").update(template, "utf8").digest("hex"),
  );
}
