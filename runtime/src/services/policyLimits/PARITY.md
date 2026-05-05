# Policy Limits Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`. <!-- branding-scan: allow donor source path citation for S-08 -->

Primary source anchors:
- `src/services/policyLimits/index.ts`
- `src/services/policyLimits/types.ts`

This directory owns the AgenC port of organization policy restrictions:
- `index.ts` fetches, caches, polls, and evaluates policy-limit restrictions through AgenC auth/bootstrap primitives.
- `types.ts` defines the response contracts and parser used by fetch and cache reads.
- `policyLimits.test.ts` covers response validation, API-key and remote-auth eligibility, ETag cache reuse, 404 cache clearing, retry behavior, fail-open behavior, essential-traffic misses, and background polling startup.
- `../../components/FeedbackSurvey/useMemorySurvey.tsx` uses the policy result to suppress product-feedback prompts when organization policy denies them.
