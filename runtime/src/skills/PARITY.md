# Skills Parity

Donor references are local-only parity metadata for SK-01 and ZC-31.

Primary source anchor:
- `/home/tetsuo/git/codex` at `c8c30d9d75556ecbe94991af22380d2a4e9d6589` // branding-scan: allow local parity citation

Source files inspected end-to-end:
- `codex-rs/core-skills/src/injection.rs` // branding-scan: allow local parity citation
- `codex-rs/core-skills/src/env_var_dependencies.rs` // branding-scan: allow local parity citation
- `codex-rs/core-skills/src/invocation_utils.rs` // branding-scan: allow local parity citation
- `codex-rs/core-skills/src/loader.rs` // branding-scan: allow local parity citation
- `codex-rs/core-skills/src/manager.rs` // branding-scan: allow local parity citation
- `codex-rs/core-skills/src/mention_counts.rs` // branding-scan: allow local parity citation
- `codex-rs/core-skills/src/model.rs` // branding-scan: allow local parity citation
- `codex-rs/core-skills/src/remote.rs` // branding-scan: allow local parity citation
- `codex-rs/core-skills/src/render.rs` // branding-scan: allow local parity citation
- `codex-rs/core-skills/src/system.rs` // branding-scan: allow local parity citation

SK-01 and ZC-31 scope carried into AgenC:
- `local-loader.ts` owns local skill root discovery for project `.agents/skills`, project `.agenc/skills`, user `$AGENC_HOME/skills`, default user `.agenc/skills`, managed-home skills, and enabled plugin skill roots.
- `local-loader.ts` owns recursive `SKILL.md` discovery, symlink loop avoidance, scan-depth/file-count bounds, frontmatter parsing, nested name derivation, local command Markdown loading, realpath dedupe, conditional `paths` activation, skill rendering with base directory and AgenC placeholders, argument substitution, invocation records, cache clearing, best-effort filesystem watchers, plugin-skill cache invalidation, and bundled AgenC skill definitions.
- `prompts/attachments/skill-listing.ts` owns model-visible skill listing attachment production and duplicate-list suppression.
- `bin/model-facing-tools.ts` owns the model-facing `Skill` tool, skill resolution, rendered content formatting, permission integration, disabled model-invocation rejection, and invocation recording.
- `commands/skills.ts` owns user-visible `/skills` listing behavior through the shared skills manager.
- `local-loader.test.ts`, `commands/skills.test.ts`, and `bin/model-facing-tools.test.ts` cover root discovery, metadata parsing, path activation, rendering, listing budgets, plugin skills, cache invalidation, user listings, model invocation, and invocation records.

Intentional ZC-31 scope reductions:
- Sidecar `agents/openai.yaml` metadata is not carried. AgenC uses `SKILL.md` frontmatter and plugin manifests as the supported metadata surface, so interface icon/color/default-prompt fields and env-var dependency declarations are documented but not parsed into live skill state.
- Automatic text mention injection is not carried. AgenC exposes skills through the model-facing `Skill` tool and the slash/user command surfaces; it records explicit invocations after the tool renders the selected skill.
- Implicit shell-script and skill-doc command detection is not carried. The system shell/runtime layers remain tool-execution surfaces; they do not silently convert script runs or file reads into skill invocations.
- Product-surface filtering is not carried because this runtime ships a single AgenC product surface.
- Remote skill listing/export is not carried in `runtime/src/skills`. Remote bundle download and marketplace reconciliation are owned by the plugin marketplace and resolver subsystems, where transport, archive, and signature policy are already guarded.
- Disk-installed system skill cache management is not carried. AgenC bundles system skills as in-process definitions and materializes auxiliary files only when a bundled skill needs a temporary base directory.
- Rich root-alias rendering from the donor renderer is reduced to AgenC's current listing budget helper. The prompt attachment keeps all bundled skills visible first and truncates descriptions for the remaining listing instead of emitting a separate root alias table.

ZC-31 coverage lock:
- `scripts/goal/verify.mjs` checks these source anchors, the folded AgenC counterpart files, the carried-scope text, and each intentional reduction before ZC-31 can complete.
