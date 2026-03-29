## PR #69: test(eval): add missing phase 8 incident fixtures
- **Date:** 2026-03-29
- **Files changed:** Phase 8 orchestration incident fixture pairs under `runtime/benchmarks/v1/incidents/`
- **What worked:** the follow-up branch isolated the ten missing fixture files cleanly, and rerunning the orchestration baseline immediately confirmed the incident corpus and manifest were back in sync after the larger cleanup sweep merged
- **What didn't:** those files were left untracked during the original Phase 8 merge, so they missed PR #68 and had to be shipped as a small corrective follow-up instead of landing with the rest of the regression rebuild
- **Rule added to CLAUDE.md:** no

## PR #68: refactor(runtime): complete orchestration cleanup sweep
- **Date:** 2026-03-29
- **Files changed:** runtime workflow/planner/verifier/gateway semantics, eval replay/gate suites, orchestration incident fixtures, regression coverage, runtime architecture docs, cleanup prompts
- **What worked:** carrying the canonical workflow contract and completion lattice all the way through planner, delegation, verifier, provider routing, replay, and gate evaluation closed the recurring reviewer/writer, fallback, and tool-contract regressions, and the rebuilt incident corpus plus end-to-end reviewer-heavy workflow tests now describe the same system the runtime executes
- **What didn't:** the cleanup still had one late compile mismatch in `background-run-replay.ts` because the canonical replay mapping initially used a stale `queued` branch instead of the real background-run state union, so the build had to be corrected before final push and merge
- **Rule added to CLAUDE.md:** no

## PR #66: fix(runtime): require explicit subagent verification
- **Date:** 2026-03-29
- **Files changed:** runtime planner verifier admission/execution loop, required subagent orchestration selection, runtime verifier coverage, orchestration regression coverage, architectural cleanup TODO
- **What worked:** making required reviewer child verification explicit in the planner verifier loop closes the gap where mandatory reviewer outputs could be skipped when the model-based verifier path was disabled, and the new `TODO.MD` captures the full cross-layer cleanup instead of papering over more local symptoms
- **What didn't:** the branch still sits on top of a broader stack of runtime changes because the real problem spans planner typing, delegation economics, execution-kernel semantics, verifier semantics, and xAI capability routing, so this PR is only one step in the cleanup rather than the final architectural fix
- **Rule added to CLAUDE.md:** no

## PR #31: refactor(runtime): remove daemon marketplace layer
- **Date:** 2026-03-23
- **Files changed:** runtime gateway/config/routing surfaces, onboarding, runtime index/types, runtime marketplace module tree, runtime marketplace tool tree, related docs, generated runtime API baseline
- **What worked:** removing the daemon-local marketplace as a single subsystem was clean once the protocol-backed operator surfaces were kept scoped to `marketplace/serialization.ts`, the CLI/TUI, and `market.*` handlers
- **What didn't:** the generated runtime baseline and several daemon/routing tests still assumed the deleted exports and needed an explicit follow-up cleanup pass
- **Rule added to CLAUDE.md:** no

## PR #49: fix(runtime): enforce request-level completion semantics
- **Date:** 2026-03-27
- **Files changed:** runtime workflow completion state/progress/contracts, planner verifier/execution/admission surfaces, planner tests, background-run progress persistence, generated runtime package metadata, public runtime artifact
- **What worked:** layering request-level milestone debt on top of the existing local verifier prevented false global completion claims without replacing the current verifier stack, and the explicit-delegation admission correction preserved planner-owned synthesis fallback
- **What didn't:** the first delegation-admission pass was too aggressive for explicitly requested read-only research, so the planner dropped out to the direct loop until the explicit-delegation signals were widened and the local-first vetoes were conditioned on them
- **Rule added to CLAUDE.md:** no

## PR #52: feat(runtime): add xAI capability surface and native tools
- **Date:** 2026-03-27
- **Files changed:** runtime LLM shared capability types, Grok provider config/adapter/tool registry, gateway config/provider-manager validation surfaces, adapter/provider-native tests, xAI API gotcha notes, generated runtime/public artifact metadata
- **What worked:** replacing the one-off `web_search` path with a documented provider-native tool catalog made the Grok adapter align cleanly with xAI MCP specs, and wiring server-side tool telemetry into provider evidence preserved observability without weakening the existing client-side function path
- **What didn't:** the first adapter pass only patched the request builder; typecheck caught missing local option-shape plumbing and over-constrained readonly evidence arrays before merge, which had to be corrected before the capability layer was actually complete
- **Rule added to CLAUDE.md:** no

## PR #63: fix(runtime): handle structured Grok planner requests on grok-code-fast-1
- **Date:** 2026-03-28
- **Files changed:** Grok runtime adapter request shaping, Grok trace tool-choice summarization, Grok adapter regression coverage
- **What worked:** aligning forced `tool_choice` with xAI's nested `function.name` shape fixed the Responses request contract, and downgrading the non-Grok-4 structured-output-plus-tools path from a hard failure to tool suppression kept `grok-code-fast-1` planner calls viable
- **What didn't:** the first rebuild claim was incomplete because the installed daemon snapshot still had the stale compiled runtime, so the live process had to be rebuilt, re-synced, and restarted before the fix was actually in effect
- **Rule added to CLAUDE.md:** yes, xAI capability checks must be verified by exact model family rather than assuming all Grok-branded models share Grok 4 features

## PR #64: fix(runtime): harden planner artifact grounding
- **Date:** 2026-03-28
- **Files changed:** runtime planner validation and prompt guidance, delegated tool scoping, Grok adapter tool-choice handling, verifier ownership/completion routing, workspace-grounded artifact evidence helpers, runtime verification/delegation regression coverage
- **What worked:** moving plan-document audits onto a first-class workspace-grounded documentation contract fixed the repeated planner/verifier failure chain without special-casing `PLAN.md`, and preserving xAI `tool_choice: required` for single-tool requests stopped the child Grok 422s
- **What didn't:** the first workspace-grounding detector was too broad and treated plain “current guide / no changes needed” reviews as repo audits, so the classifier had to be tightened to require actual repo/layout/state cues before the stronger evidence contract applies
- **Rule added to CLAUDE.md:** no

## PR #65: fix(planner): harden multi-agent artifact orchestration
- **Date:** 2026-03-28
- **Files changed:** runtime planner orchestration requirement extraction, delegation admission, subagent orchestration/prompting/synthesis handoffs, delegated verification obligations, planner execution fallback handling, multi-agent/documentation regression coverage
- **What worked:** promoting natural-language “create N agents” requests into a typed orchestration contract prevented single-child collapse, and materializing synthesis outputs plus inherited workspace-inspection evidence let the final documentation writer satisfy the contract without redundant repo crawls
- **What didn't:** manually restarting the raw `daemon.js` entrypoint made the runtime look worse by bypassing the supported detached log lifecycle, so the daemon had to be relaunched through `agenc-runtime start` before the live logs were trustworthy again
- **Rule added to CLAUDE.md:** yes, restart the daemon through the supported CLI instead of hand-launching the raw daemon entrypoint
