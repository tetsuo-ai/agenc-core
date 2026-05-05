# Skills Parity

Upstream references:
- `/home/tetsuo/git/openclaude/src/skills/loadSkillsDir.ts` <!-- branding-scan: allow donor source path -->
- `/home/tetsuo/git/openclaude/src/skills/bundledSkills.ts` <!-- branding-scan: allow donor source path -->
- `/home/tetsuo/git/openclaude/src/utils/skills/skillChangeDetector.ts` <!-- branding-scan: allow donor source path -->
- `/home/tetsuo/git/openclaude/src/components/skills/SkillsMenu.tsx` <!-- branding-scan: allow donor source path -->
- `/home/tetsuo/git/codex/codex-rs/core-skills/src/{loader,manager,injection,render,remote,model,config_rules,env_var_dependencies,invocation_utils,mention_counts,system}.rs` <!-- branding-scan: allow donor source path -->

## ZC-29 breadth audit

Decision: `local-loader.ts` is the canonical AgenC local skills service. It intentionally combines
local directory discovery, command compatibility loading, bundled skill definitions, model-visible
listing, skill rendering, invocation tracking, plugin roots, dynamic path discovery, and watcher
cache invalidation behind one runtime service boundary.

Carried behavior:
- user, project, managed, plugin, and bundled skill roots
- nested `SKILL.md` discovery with symlink loop protection and duplicate-realpath suppression
- legacy command-directory loading for user-invocable markdown commands
- frontmatter parsing for descriptions, tools, arguments, path activation, shell, effort, agent,
  context, model, hooks, and user-invocable flags
- bundled skills with path-jailed reference-file extraction and base-directory prompt prefixing
- skill content rendering with argument substitution and per-session invocation tracking
- model-visible skill listing with a bounded context budget
- dynamic skill-directory discovery from active file paths and watcher-driven cache invalidation

Intentional reductions:
- The later ZC-31 row owns full coverage for the Rust core-skills split, including metadata TOML
  interface/dependencies/policy files, mention-count indexes, explicit linked-resource mention
  selection, remote skill export/import, and system-skill install/uninstall semantics. ZC-29 does
  not partially port those separate concerns into `local-loader.ts`.
- The donor skills menu is not duplicated under `runtime/src/skills/`; command and TUI presentation
  are owned by `runtime/src/commands/` and `runtime/src/tui/`.
- Remote skill download/listing is not implemented in this local loader. AgenC's remote package and
  marketplace flows live under the plugin/auth surfaces and should be reconciled by the dedicated
  remote skills/plugin coverage rows.
- MCP skill roots and builders are not loaded by `local-loader.ts`; runtime MCP integration owns those
  sources until a dedicated skills/MCP row wires a concrete loader into this service.

## ZC-31 coverage audit

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

Merge conflict note:
- The May 5, 2026 merge from `main` added the ZC-29 breadth audit in this file. ZC-31 kept that main-owned audit intact and appended the ZC-31 source-anchor closure and scope-reduction lock.
