# Shell Profiles

Shell profiles define how a daemon client should bias the shared AgenC runtime
for a session without creating a second product or a second execution stack.

## Profiles

- `general`
- `coding`
- `research`
- `validation`
- `documentation`
- `operator`

## Contract

- Profiles are persisted session identity.
- `general` is the default when no profile is supplied.
- Profiles bias prompt rules, tool advertisement, and delegation posture.
- Profiles do not bypass approvals, policy allowlists, trusted-root checks, or
  runtime economics controls.

## Precedence

From strongest to weakest:

1. Hard runtime safety and policy controls
2. Existing delegated scope and allowed-tool constraints
3. Shell-profile defaults
4. Session-level explicit overrides
5. Child/run-level explicit overrides

## Shared runtime authority

Bare `agenc`, `agenc shell`, the explicit `agenc console` compatibility path,
the dashboard, and other daemon clients all attach to the same runtime
authority:

- one daemon
- one policy engine
- one approvals layer
- one session/memory substrate
- one tool and connector surface

The coding shell is therefore a mode of AgenC, not a separate runtime product.

## Phase 1 Surface Inventory

Phase 1 reuses the existing daemon surfaces instead of introducing a parallel
stack:

- `agenc` and `agenc shell [profile]` for shell-first terminal sessions
- `agenc console` for the explicit operator-console compatibility surface
- `agenc ui` for the dashboard client
- `agenc-runtime sessions list|kill` for control-plane session inspection
- the existing watch/operator runtime surfaces for deeper observability and
  lifecycle work

Later phases should extend these surfaces rather than fork a second coding-only
runtime path.

## Phase 2 Coding Tool Surface

The `coding` profile now defaults to a native coding bundle on the shared
runtime rather than prompt-only shell advice.

That bundle includes:

- repo inventory and file-discovery tools
- structured git status/diff/show/branch/change-summary tools
- user-visible git worktree tools on top of the existing runtime
- bounded file-context reads and native patch application
- native code-intelligence lookups for symbol search, definitions, and references
- tool discovery via `system.searchTools`

Mixed-mode work is still allowed. Browser, research, remote, sandbox, and
operator tools remain reachable through profile-aware expansion and explicit
tool discovery instead of forcing coding sessions onto a second runtime.
