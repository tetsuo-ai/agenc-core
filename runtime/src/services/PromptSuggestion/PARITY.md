# Prompt Suggestion Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`. <!-- branding-scan: allow upstream source path -->

Primary source anchors:
- `src/services/PromptSuggestion/promptSuggestion.ts`
- `src/services/PromptSuggestion/speculation.ts`
- `src/hooks/usePromptSuggestion.ts`

This directory owns the AgenC port of prompt-followup suggestions:
- `promptSuggestion.ts` gates, generates, filters, and logs suggestions.
- `speculation.ts` runs speculative follow-up turns and injects accepted work.
- `runtime.ts` carries the local helper slices needed by the live service.
- `limits.ts` provides the local rate-limit view used by the service.
