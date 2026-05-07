# Conversation Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/query/tokenBudget.ts` <!-- branding-scan: allow source citation path -->
- `src/utils/tokenBudget.ts` <!-- branding-scan: allow source citation path -->
- `src/constants/prompts.ts` (`token_budget` dynamic section) <!-- branding-scan: allow source citation path -->

This directory owns the PR-05 context-size budgeting port:
- `token-budget.ts` parses user token targets, tracks continuation progress, detects diminishing returns, formats continuation nudges, and provides the shared token-budget system-prompt section text.

Intentional AgenC differences:
- The canonical AgenC module is `runtime/src/conversation/token-budget.ts`; the previous `query`, `utils`, and `llm` copies were deleted instead of kept as compatibility paths.
- `runtime/src/prompts/system-prompt.ts` carries the token-budget section behind the existing `TOKEN_BUDGET` feature gate and places it after the dynamic boundary.
- `runtime/src/session/_deps/system-prompt.ts` intentionally does not add token-budget guidance. That compact summarizer prompt is a summarization-specific path, and the continuation nudge text tells the model not to summarize.
