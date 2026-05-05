# Tool Use Summary Parity

Upstream reference: OC source checkout at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/services/toolUseSummary/toolUseSummaryGenerator.ts`

This directory owns the AgenC port of the completed-tool batch summary generator:
- `toolUseSummaryGenerator.ts` builds the fixed prompt, calls a Haiku-class model through AgenC provider primitives, and logs structured non-fatal generation failures.
- `toolUseSummaryGenerator.test.ts` covers prompt construction, JSON truncation, provider options, blank output, and failure logging.
