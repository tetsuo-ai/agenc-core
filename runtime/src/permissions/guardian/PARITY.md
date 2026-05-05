# Guardian Approval Engine Parity

PE-11 maps the inspected guardian approval sources into AgenC-owned
permission modules:

- `core/src/guardian/mod.rs` -> `rejection-circuit-breaker.ts`, `reviewer.ts`
- `core/src/guardian/approval_request.rs` -> `approval-request.ts`
- `core/src/guardian/prompt.rs` -> `prompt.ts`
- `core/src/guardian/review.rs` -> `reviewer.ts`, `arbiter.ts`
- `core/src/guardian/review_session.rs` -> existing `session/review.ts` and
  `session/agenc-delegate.ts` delegate path used by `reviewer.ts`, including
  a guardian reuse key plus bounded transcript/context seeded as review
  `initialHistory`
- `core/src/guardian/policy.md` -> AgenC-branded policy text in `prompt.ts`

Scoped deviations:

- AgenC reuses its existing `ReviewManager` and delegate one-shot review
  service instead of duplicating a second child-session manager under
  `permissions/guardian`. The exact donor delta-cursor type is represented by
  a bounded recent-context snapshot rather than a Rust cursor struct.
- Standalone network approval resolution remains in
  `permissions/network-approval.ts`; PE-11 only normalizes network-shaped
  approval requests when they already enter the tool approval context.
- `tools/orchestrator.ts` remains a substantial tool lifecycle module and
  re-exports the canonical approval types for current callers, while the
  implementation lives in `permissions/guardian/arbiter.ts`.
