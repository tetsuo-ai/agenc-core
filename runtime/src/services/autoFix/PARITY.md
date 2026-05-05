# Auto Fix Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`. <!-- branding-scan: allow upstream source path -->

Primary source anchors:
- `src/services/autoFix/autoFixRunner.ts`
- `src/services/autoFix/autoFixHook.ts`
- `src/services/autoFix/autoFixConfig.ts`
- `src/services/autoFix/autoFixRunner.test.ts`
- `src/services/autoFix/autoFixHook.test.ts`
- `src/services/autoFix/autoFixConfig.test.ts`
- `src/services/autoFix/autoFixIntegration.test.ts`

This directory owns the AgenC port of post-edit auto-fix feedback:
- `autoFixConfig.ts` parses the top-level `autoFix` config block.
- `autoFixRunner.ts` runs configured lint/test commands with timeout and abort handling.
- `autoFixHook.ts` installs the lint/test result as post-tool additional context with retry caps.
