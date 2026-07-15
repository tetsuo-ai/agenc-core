# Hosted required gates

**Decision record:** 2026-07-15
**Protected check:** `agenc-m0-required`
**Scope:** every pull request, every merge-queue candidate, and both release
artifact pipelines

The hosted gate is a source-bound execution contract, not a second definition
of release quality. One repository command owns the ordered inventory:

```bash
npm run check:required-gates
```

It requires Linux, Node.js 25.9.0, npm 11.17.0, a clean checkout, and an exact
40-character source commit when run by GitHub Actions. The workflow validates
the event SHA before `npm ci`; the runner validates it again before and after
all gates. Candidate code therefore cannot be tested from one revision and
reported against another.

## Required contract

| Order | Gate | Bound |
| ---: | --- | ---: |
| 1 | SDK build | 5 min |
| 2 | SDK typecheck | 5 min |
| 3 | Runtime typecheck | 5 min |
| 4 | Hermetic stable Vitest suite | 20 min |
| 5 | Runtime build and declarations | 10 min |
| 6 | Agent-surface contract | 20 min |
| 7 | Deterministic SPDX SBOM check | 5 min |
| 8 | PTY/TUI runtime startup smoke | 10 min |

The SDK build is first because runtime type resolution consumes the generated
SDK protocol package in a fresh checkout. TUI startup runs for every pull
request. This is a safe superset of path relevance and avoids a transitive-path
classifier that could silently skip daemon, launcher, build, or generated-code
changes.

The outer GitHub job has a 100-minute bound: the 80-minute sum of individual
fail-closed budgets plus 20 minutes for checkout, the frozen install, image
provisioning, process cleanup, and runner variance. Contract tests enforce that
the outer bound cannot become shorter than the gate inventory plus setup
allowance.

Each gate gets a closed-world environment: private home, AgenC state, npm
cache, Docker config, XDG roots, and temporary directories; offline npm
execution; fixed locale/timezone; and no ambient credentials, agent sockets,
Node loaders, Git routing, or package-manager control variables. Commands run
in a dedicated POSIX process group. Success, failure, timeout, and cancellation
all reconcile descendants; timeout and cancellation use TERM, a bounded grace
period, then KILL. A detached daemon is stopped only after its PID, process
start identity, executable, exact argv, session/process group, private
`AGENC_HOME`, private config root, and repository cwd prove ownership.

## Hosted workflows

[`required-gates.yml`](../.github/workflows/required-gates.yml) has no path or
branch filters and runs on:

- `pull_request`; and
- `merge_group` with `checks_requested`, so merge queue candidates emit the
  same required context.

It contains one job with the stable display name `agenc-m0-required`. That name
is reserved for this workflow. The two dispatch-only release jobs deliberately
use distinct names, `agenc-runtime-release-gates` and
`agenc-npm-release-gates`, so a skipped or unrelated release job cannot satisfy
the protected context.

Both [`release-runtime.yml`](../.github/workflows/release-runtime.yml) and
[`publish-npm.yml`](../.github/workflows/publish-npm.yml) first bind the run to
the matching immutable `agenc-v<version>` tag, exact commit, and `main`
ancestry. They then invoke the same local composite action and root gate before
any artifact-producing job can start. Release concurrency never cancels an
in-progress run, and `queue: max` retains up to 100 pending runs instead of
silently replacing an older dispatch. Runtime artifacts serialize per tag;
npm publication uses one repository-global production group so two versions
cannot race the shared registry dist-tag. GitHub processes each queue by the
time a run begins waiting, so dispatch order is not claimed.

All external actions use full commit SHAs. GitHub documents a full-length SHA
as the only immutable action reference; repository Actions policy also requires
SHA pinning. Dependency caching is intentionally disabled for this trust gate.

## Local reproduction

Provision the exact test image outside the no-network test boundary, then use
the frozen install and the same gate runner:

```bash
image="$(node -p 'require("./release-toolchain.json").docker.buildImage')"
docker pull "$image"
npm ci --no-audit --no-fund
npm run check:required-gates
```

Run only the runner/workflow regression contract with:

```bash
npm run test:required-gates
```

The full command refuses a dirty source tree. It does not pull the Docker image
itself, because the stable suite's authoritative no-egress boundary must not
silently acquire dependencies.

## `main` ruleset

The required repository ruleset is named `agenc-main-required`, targets only
the default branch, is active, and has no bypass actors. Its exact rules are:

- reject deletion and non-fast-forward updates;
- require linear history;
- require a pull request with squash as the only merge method and all review
  threads resolved;
- require `agenc-m0-required` from the GitHub Actions app (integration ID
  `15368`); and
- require the branch to be current with `main` before merging.

Bootstrap ordering matters. First obtain a green `pull_request` run from the
workflow PR. While that PR remains open, activate the no-bypass ruleset and
verify the observed check source. Merge the workflow under that protection.
The workflow is merge-queue-ready, but queue enforcement is not part of this M0
checkbox. If it is enabled later, do so only after the workflow exists on the
default branch and verify a real merge-group run; otherwise GitHub cannot emit
the required check and all merges deadlock.

Verification is behavioral, not configuration-only. A temporary PR containing
a guaranteed TypeScript error must produce a failed `agenc-m0-required`, show a
blocked merge state, leave `main` unchanged, and then be closed without any
merge attempt. The ruleset, Actions SHA-pinning policy, and negative proof are
re-read through the GitHub API after configuration.

The npm publication workflow also requires an `npm-production` environment
with self-review prevented, an independent required reviewer, and a custom
deployment policy matching only `agenc-v*` tags. A missing environment is a
release blocker; GitHub otherwise creates an unprotected environment on first
use.

## Threat boundary and rollback

A repository-level required status check can bind a context to the GitHub
Actions app, but it cannot cryptographically bind that context to one workflow
file. GitHub's stronger ruleset workflow feature is configured at organization
or enterprise level. Until that independently managed policy root is available,
changes to the workflow, composite action, gate runner, or command-routing
package scripts require independent review, and this limitation remains an
explicit trust residual rather than an “unskippable workflow” claim.

npm staged publishing became available after the current immutable-publish
contract was designed. Moving to it is intentionally a separate publication
state-machine change: stage approval requires an interactive maintainer, OIDC
cannot approve a stage, and final registry receipt verification must resume
after that approval. The current path remains source-bound OIDC publishing
behind a protected environment; adopting stage-only trusted publishing needs a
dedicated reviewed migration rather than an untested flag change in this CI PR.

Normal merges have no bypass. If a gate definition on `main` is itself broken,
an administrator must preserve the failed-run evidence, temporarily disable
the ruleset out of band, land only a reviewed repair, re-enable the identical
ruleset, and repeat the failing-PR proof. Editing protection is the audited
break-glass rollback; weakening a check, using an admin merge, or leaving the
ruleset disabled is not.

## Alternatives and primary sources

Research was refreshed on 2026-07-15:

- [GitHub secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use)
  requires full-length action SHAs for immutable references.
- [GitHub required-check troubleshooting](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)
  documents skipped-job success behavior and the required `merge_group`
  trigger.
- [GitHub ruleset rules](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
  define app-bound checks, merge queue, and organization-managed required
  workflows.
- [GitHub concurrency controls](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
  define bounded multi-run queues and the default pending-run replacement
  behavior avoided by release workflows.
- [npm 11 `npm ci`](https://docs.npmjs.com/cli/v11/commands/npm-ci/) defines the
  frozen, lockfile-consistent install used by hosted and release jobs.
- [npm staged publishing](https://docs.npmjs.com/staged-publishing/) defines the
  separately reviewed stage/approve state machine and its interactive approval
  boundary.
- [SLSA build requirements](https://slsa.dev/spec/v1.2/build-requirements)
  motivate exact source identity, isolated build state, and explicit external
  parameters.

A matrix with a final aggregator was rejected for the initial gate because it
adds skipped-dependency semantics and multiple mutable context names without
reducing the dominant hermetic-suite runtime. Path filters were rejected
because GitHub leaves a skipped required workflow pending and the repository's
TUI/daemon/build transitive paths are not yet represented by one proven
classifier. Caches were rejected because this gate favors a clean dependency
and state boundary over a currently unmeasured speedup.
