// Cherry-picked from openclaude src/utils/messages.ts.
// Only stripPromptXMLTags is consumed by the wholesale-ported markdown
// pipeline — the rest of openclaude's messages.ts pulls Anthropic SDK +
// OpenClaude tooling that don't apply to AgenC. This file is the AgenC
// boundary for that specific function so the markdown port resolves
// without dragging the rest of OpenClaude's runtime in.

const STRIPPED_TAGS_RE =
  /<(?:user-prompt|user-memory|user-system-reminder|system-reminder)[^>]*>[\s\S]*?<\/(?:user-prompt|user-memory|user-system-reminder|system-reminder)>/g;

export function stripPromptXMLTags(content: string): string {
  return content.replace(STRIPPED_TAGS_RE, "").trim();
}
