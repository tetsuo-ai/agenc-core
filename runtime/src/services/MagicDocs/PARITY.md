# MagicDocs Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`. <!-- branding-scan: allow donor source path citation for S-06 -->

Primary source anchors:
- `src/services/MagicDocs/magicDocs.ts`
- `src/services/MagicDocs/prompts.ts`

This directory owns the TypeScript port of background Magic Doc maintenance:
- `magicDocs.ts` tracks tagged markdown reads, queues idle post-sampling updates, and runs an Edit-only background subagent.
- `prompts.ts` builds the maintenance prompt and loads AgenC-local prompt overrides.
- `magicDocs.test.ts` covers header detection, prompt substitution, read listener registration, idle update gating, inaccessible-file eviction, and Edit-only policy.
