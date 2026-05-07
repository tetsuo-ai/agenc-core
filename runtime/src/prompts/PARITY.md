# Prompt Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/utils/claudemd.ts` <!-- branding-scan: allow source citation path -->

This directory owns the OB-07 prompt-facing instruction file handling:
- `project-instructions.ts` discovers project instruction files from the project root down to cwd, preferring `AGENC.md` and falling back to `AGENTS.md` and `CLAUDE.md` for D-12 compatibility.
- `agenc-md.ts` assembles managed, user, project, and local tiers, expands `@include` directives, and surfaces dropped-include warnings.

Intentional AgenC differences:
- AgenC keeps `AGENC.md` as the primary instruction file name.
- AgenC uses `.agenc/rules/` for rule directories.
- Prompt includes use the explicit `@include <path>` syntax already enforced by the prompt contract instead of the reference loader's bare-at include syntax.
