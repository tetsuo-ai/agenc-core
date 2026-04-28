# OpenClaude Skills Parity Plan

This plan implements the OpenClaude skills system in the AgenC runtime while
keeping AgenC product names, paths, and runtime ownership. The source of truth
for behavior is `/home/tetsuo/git/openclaude/src/skills`,
`/home/tetsuo/git/openclaude/src/tools/SkillTool`,
`/home/tetsuo/git/openclaude/src/commands/skills`,
`/home/tetsuo/git/openclaude/src/components/skills`,
`/home/tetsuo/git/openclaude/src/hooks/useSkillsChange.ts`, and the related
slash-command, prompt, bootstrap-state, and compaction call sites.

## Goals

- Load skill instructions from AgenC skill roots with OpenClaude-compatible
  directory, frontmatter, argument, and invocation semantics.
- Expose skills to the model through the `Skill` tool with OpenClaude-style
  discovery, safety checks, permission rules, and prompt rendering.
- Expose user-invocable skills through slash-command dispatch.
- Preserve invoked skill content across compaction.
- Watch skill directories and clear skill caches after local changes.
- Include bundled AgenC-branded skill definitions for OpenClaude's portable
  built-in workflows.
- Keep runtime implementation inside `agenc-core/runtime`; do not move runtime
  code into the umbrella root or sibling repos.
- Commit the work on the feature worktree, merge it into local `main`, and
  clean up the temporary worktree and branch.

## Non-Goals

- Recreate OpenClaude's private/internal feature-flagged remote skill search.
- Add Anthropic-specific Claude API helper skills unless they have an AgenC
  equivalent runtime surface.
- Add new cloud services, marketplace services, or telemetry backends.
- Change provider selection, model routing, or the delegated agent runtime
  except where a skill carries metadata for later use.

## Compatibility Policy

AgenC uses AgenC paths first:

- project skills: `.agenc/skills`, `.agents/skills`
- project legacy commands: `.agenc/commands`, `.agents/commands`
- user/global skills: `$AGENC_HOME/skills`, `~/.agenc/skills`
- plugin skills: `$AGENC_HOME/plugins/*/skills`, `.agents/plugins/*/skills`

For migration compatibility, the loader also understands Claude-style local
roots when present:

- `.claude/skills`
- `.claude/commands`
- `~/.claude/skills`

OpenClaude environment placeholders are accepted as compatibility aliases:

- `${CLAUDE_SKILL_DIR}` maps to the selected skill directory.
- `${CLAUDE_SESSION_ID}` maps to the AgenC session id.

AgenC-native placeholders are preferred in docs and bundled skills:

- `${AGENC_SKILL_DIR}`
- `${AGENC_SESSION_ID}`

## Impact Map

### Runtime Skill Core

- Replace the minimal `runtime/src/skills/local-loader.ts` with an
  OpenClaude-compatible loader and manager.
- Add small focused modules for frontmatter parsing, argument interpolation,
  bundled skills, listing budgets, and watcher behavior as needed.
- Keep a single public `skillsManager` service so existing callers continue to
  use one skill facade.

### Model-Facing Skill Tool

- Update the `Skill` tool in `runtime/src/bin/model-facing-tools.ts`.
- Validate missing, empty, and unknown skill names.
- Strip a leading slash from skill names.
- Block model invocation when `disable-model-invocation` is set.
- Apply deny, allow, exact, and namespace-prefix permission rules for
  `Skill(<name>)`.
- Auto-allow only skills whose metadata is safe to expose without approval.
- Render the complete skill prompt and return it to the model.
- Record successfully invoked skill content for compaction.

### Slash Commands

- Extend `runtime/src/commands/dispatcher.ts` so unknown slash commands can
  resolve user-invocable skills.
- Keep ordinary built-in slash commands ahead of skill commands.
- Keep `/skills` as the user-visible listing command, backed by the same
  loader.

### Prompt Attachments

- Add a skill listing attachment that advertises available model-invocable
  skills to the model within a bounded context budget.
- Update prompt attachment types and rendering for skill listings and invoked
  skill restoration.
- Wire the producer into the existing attachment orchestrator.

### Compaction

- Replace the current no-op skill compaction stub with real invoked-skill
  attachment restoration.
- Preserve skill name, path, rendered content, invocation time, and agent id.

### Watcher

- Implement a lightweight local watcher for known skill roots.
- On change, clear skill caches and update the in-memory skill version.
- Avoid adding a new dependency unless runtime validation proves `fs.watch`
  is insufficient for the existing test and runtime surface.

### Tests

- Expand `runtime/src/skills/local-loader.test.ts`.
- Expand `runtime/src/bin/model-facing-tools.test.ts`.
- Expand `runtime/src/commands/skills.test.ts`.
- Add or update prompt attachment and compaction tests if the attachment
  surfaces are covered by focused test files.

## Phases

1. Implement skill metadata parsing and prompt rendering.
2. Implement source discovery, nested `SKILL.md` resolution, legacy command
   compatibility, plugin roots, dynamic path discovery, and cache invalidation.
3. Implement bundled AgenC-branded skills.
4. Update the `Skill` model-facing tool and permission checks.
5. Wire slash command skill invocation and `/skills` output.
6. Wire prompt attachment listing and compaction restoration.
7. Add watcher behavior and tests.
8. Run focused tests and type checks.
9. Commit on `feat/openclaude-skills-parity`, merge locally into `main`, then
   remove the worktree and delete the branch.

## Edge Cases

- Root-level `skills/SKILL.md` is ignored for normal skill roots, matching
  OpenClaude's nested-skill convention.
- Nested skills use colon names: `frontend/react/form/SKILL.md` becomes
  `frontend:react:form`.
- Duplicate real paths are loaded once.
- Conditional `paths` skills are hidden from the default listing until a
  matching file path activates them.
- Frontmatter `name` is display text only; the invocable command name comes
  from the directory path.
- Malformed frontmatter falls back to markdown-derived descriptions instead of
  crashing the session.
- Missing arguments leave placeholders visible only where OpenClaude would not
  be able to infer a replacement.
- Legacy command markdown remains user-invocable by default.
- Skill names that collide with built-in slash commands do not replace the
  built-in command.

## Validation

Run the narrowest useful checks first:

- `npm --workspace @tetsuo-ai/runtime exec vitest -- --run src/skills/local-loader.test.ts`
- `npm --workspace @tetsuo-ai/runtime exec vitest -- --run src/bin/model-facing-tools.test.ts`
- `npm --workspace @tetsuo-ai/runtime exec vitest -- --run src/commands/skills.test.ts`
- any new prompt attachment or compaction focused tests

Then run runtime type and test validation:

- `npm --workspace @tetsuo-ai/runtime exec tsc -- --noEmit`
- `npm --workspace @tetsuo-ai/runtime run test`

If broader validation is blocked by unrelated existing failures, record the
exact failing command and error class before merging locally.

## Rollback

Rollback is a normal local git revert before or after the local merge:

- before merge: reset or delete the feature branch and worktree
- after merge: revert the merge commit on local `main`

No database migrations, remote services, or external deployment steps are part
of this change.

