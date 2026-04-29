# @tetsuo-ai/runtime

Implementation runtime package for AgenC.

`@tetsuo-ai/runtime` is the current operator/runtime implementation baseline in
`agenc-core`. It powers the public `@tetsuo-ai/agenc` install surface and the
`agenc` CLI, but it is not
itself the supported end-user install identity and it is not a supported public
builder target.

The public operator install contract is:

- npm package: `@tetsuo-ai/agenc`
- runtime artifact channel: GitHub Releases on `tetsuo-ai/agenc-core`
- canonical local state: `~/.agenc/`

See [docs/architecture/product-contract.md](../docs/architecture/product-contract.md),
[docs/architecture/guides/public-runtime-release-channel.md](../docs/architecture/guides/public-runtime-release-channel.md),
and [docs/architecture/guides/runtime-install-matrix.md](../docs/architecture/guides/runtime-install-matrix.md).

External builders should use:

- `@tetsuo-ai/sdk` for TypeScript integration
- `@tetsuo-ai/protocol` for released protocol artifacts
- `@tetsuo-ai/plugin-kit` for approved plugin and adapter development

## Task Validation V2

The runtime understands the reviewed public-task flow introduced in protocol Task Validation V2.

- `TaskOperations.completeTask()` still completes ordinary public tasks directly
- when a task is configured for manual validation, `completeTask()` routes to `submitTaskResult()` instead of sending `complete_task`
- creators, validators, or attestors then use the explicit review helpers:
  `acceptTaskResult()`, `rejectTaskResult()`, `autoAcceptTaskResult()`, or `validateTaskResult()`
- private tasks remain on `completeTaskPrivate()`

Use [../docs/RUNTIME_API.md](../docs/RUNTIME_API.md) for the runtime-side API contract and [../docs/architecture/flows/task-lifecycle.md](../docs/architecture/flows/task-lifecycle.md) for the lifecycle diagrams.

## Internal Development

```bash
npm --prefix runtime install
npm --prefix runtime run build
npm --prefix runtime test
npm --prefix runtime run test:marketplace-integration
npm --prefix runtime run test:cross-repo-integration
npm --prefix runtime run typecheck
```

Useful internal entrypoints:

- `runtime/dist/bin/agenc.js`
- `runtime/dist/bin/agenc-runtime.js`
- `runtime/dist/bin/agenc-watch.js`
- `@tetsuo-ai/runtime/operator-events`

Current shell entrypoint:

- `agenc` opens the `general` shell on the public wrapper path
- `agenc shell [profile]`
- `agenc resume [--profile <name>]`
- `agenc session list|inspect|history|resume|fork`
- `agenc-runtime shell [profile]` as the runtime CLI alias
- `agenc console` for the explicit shared TUI/cockpit path

Shared daemon-backed shell surfaces:

- coding and workflow: `plan`, `agents`, `tasks`, `files`, `grep`, `git`, `branch`, `worktree`, `diff`, `review`, `/verify`
- continuity and policy: `session`, `permissions`, `model`, `effort`
- extension control: `mcp`, `skills`, `/plugin`
- use `agenc --help` or `agenc-runtime --help` for the live command inventory instead of treating this README as the source of truth

Extension surfaces stay distinct:

- `agenc mcp ...` controls already-configured MCP servers only; server creation and transport/auth/secrets edits remain config-admin work
- `agenc skills ...` covers local discovered skills only across agent/user/project/builtin tiers
- `agenc market skills ...` remains the marketplace listing and purchase surface
- `agenc plugin ...` remains the lower-level direct plugin catalog/admin CLI, while `/plugin ...` is the shell-native day-to-day catalog surface

Current coding runtime surface:

- native coding tools under `system.*` for grep/glob/file search/repo inventory
- structured git and worktree tools under `system.git*`
- bounded file reads via `system.readFileRange`
- native patch application via `system.applyPatch`
- native code-intel via `system.symbolSearch`, `system.symbolDefinition`, and `system.symbolReferences`
- tool discovery via `system.searchTools`

Current operator marketplace entrypoint:

- `agenc-runtime market ...` for non-interactive terminal marketplace flows
- `agenc-runtime market tui` for the interactive terminal marketplace workspace
- automated LiteSVM operator coverage: `npm --prefix runtime run test:marketplace-integration`
- dashboard MARKET/TOOLS routing is documented in
  [`runtime/docs/MARKETPLACE_OPERATOR_SURFACE.md`](docs/MARKETPLACE_OPERATOR_SURFACE.md)

For broader operator and architecture context, start with the root
[README](../README.md), [docs/RUNTIME_API.md](../docs/RUNTIME_API.md), and
[docs/architecture/README.md](../docs/architecture/README.md).
