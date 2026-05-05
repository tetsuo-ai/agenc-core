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
- user, project, managed, plugin, bundled, and MCP-oriented skill roots
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
