# Compiled Job Phase 1 Launch Readiness

This document is the Phase 1 launch-readiness pack for compiled marketplace
jobs in `agenc-core`. It covers the runtime operator workflow we need before an
`L0` launch can be called production-ready.

Use this together with:

- `runtime/docs/MARKETPLACE_OPERATOR_SURFACE.md`
- `runtime/docs/observability-incident-runbook.md`
- `docs/DEPLOYMENT_CHECKLIST.md`

## Scope

This pack applies to:

- compiled marketplace jobs only
- `L0` launch job types only
- read-only or drafting-only execution only

It does not authorize:

- `L1` internal writes
- `L2` manual-only job classes
- autonomous side effects

## Hostile-Content Red-Team Coverage

Before launch, the runtime must show passing coverage for:

- hostile user input in bounded job fields
- hostile webpage content that tries to escalate tool access
- hostile transcripts, docs, and extracted text
- hostile network targets, including localhost, RFC1918, metadata, and redirect chains
- policy-denied tool calls that try to bypass the compiled plan

Minimum acceptance for each launch job type:

- untrusted input stays in untrusted prompt sections
- the model only sees the tools exposed by the compiled plan
- attempts to call blocked tools fail closed
- attempts to reach denied domains emit telemetry
- the final deliverable can still complete without broadening scope

Required red-team fixtures for `web_research_brief`:

- prompt-injection prose in `topic`
- fetched body that asks for file writes or external posts
- localhost fetch attempt
- off-allowlist redirect target

## Trigger Conditions

Open an incident immediately when any of these fires in production:

- `agenc.task.compiled_job.blocked.count` spikes above expected launch baseline
- `compiled_job.blocked_runs_spike` alert fires
- `compiled_job.blocked_reason_spike` alert fires for a launch job type
- `compiled_job.policy_failure_spike` alert fires
- `compiled_job.domain_denied_spike` alert fires
- launch controls are tripped for a job type unexpectedly
- dependency-preflight failures persist for sandbox, network broker, or review broker paths

## Incident And Abuse Response Runbook

### 1. Stabilize

1. Check whether the issue is isolated to one `jobType` or all compiled jobs.
2. If only one launch job type is affected, disable that job type first.
3. If blast radius is unclear, pause compiled job execution globally.

Primary controls:

- global pause switch
- per-job-type disable switch
- compiler version controls
- policy version controls

### 2. Triage

Collect the following for the first failing window:

- `jobType`
- `taskPda`
- `compiledPlanHash`
- `compilerVersion`
- `policyVersion`
- blocked or deny reason
- tool name
- denied host if present

Check these telemetry families first:

- `agenc.task.compiled_job.blocked.count`
- `agenc.task.compiled_job.policy_failure.count`
- `agenc.task.compiled_job.domain_denied.count`

### 3. Classify

Use this quick classification:

- `blocked_reason_spike`: expected controls may be catching bad model behavior or rollout drift
- `policy_failure_spike`: policy engine is denying tool execution inside compiled jobs
- `domain_denied_spike`: hostile or misconfigured network targets are being attempted
- dependency failures: runtime prerequisites are unavailable and jobs are failing closed

### 4. Contain

If abuse or hostile-content traffic is suspected:

1. pause the affected job type
2. keep `L0` scope unchanged; do not widen tool or domain access as a hotfix
3. pin to the last known-good `compilerVersion` and `policyVersion` if current rollout introduced the issue
4. preserve evidence before changing retention or pruning settings

## Abuse Escalation

Escalate as an abuse incident when any of these are true:

- repeated denied attempts against localhost or metadata endpoints
- repeated attempts to invoke mutating tools from an `L0` job
- repeated policy denials on the same `compiledPlanHash`
- a single tenant or source creates sustained denied-domain traffic

Abuse-specific actions:

1. isolate the tenant or source if tenant-level throttles exist
2. disable the affected launch job type if abuse pattern is cross-tenant
3. capture the blocked-run and policy/domain-denial telemetry snapshot
4. attach the exact deny reasons to the abuse report

## Audit-Log Retention Policy

Compiled job launch operations rely on governance audit retention staying in a
forensic-safe posture.

Required policy:

- keep `policy.audit.retentionMs` explicitly configured
- use `retentionMode = archive` for launch production environments
- never downgrade from `archive` to `delete` during an active incident or abuse review
- preserve legal hold behavior for any incident under investigation

Minimum evidence to retain for compiled-job incidents:

- blocked-run records
- policy-failure records
- domain-denial records
- compiler and policy version decisions
- launch-control state at time of denial

Retention decision record for Phase 1:

- default launch posture: `archive`
- destructive pruning during an active investigation: not allowed
- retention changes require operator review and written incident note

## Phase 1 Release Checklist

Launch is blocked until every item here is true.

### Runtime gates

- [ ] all launch job types execute from a compiled plan
- [ ] every run stores `compilerVersion`, `policyVersion`, and `compiledPlanHash`
- [ ] `L0` jobs remain read-only or drafting-only
- [ ] blocked side effects remain fail-closed
- [ ] dependency preflight failures fail closed

### Observability gates

- [ ] blocked-run telemetry is live
- [ ] policy-failure telemetry is live
- [ ] domain-denial telemetry is live
- [ ] alerting is wired for blocked spikes, policy failures, and domain denials

### Validation gates

- [ ] hostile-content red-team suite passes for launch job types
- [ ] localhost and off-allowlist network attempts are denied
- [ ] hostile remote content cannot broaden tool access
- [ ] hostile job text stays in untrusted prompt sections

### Operator gates

- [ ] incident response steps are documented
- [ ] abuse escalation path is documented
- [ ] audit retention posture is documented and reviewed
- [ ] launch decision is recorded as `Phase 1 / L0 only`

## Final Launch Decision

Phase 1 is ready for launch only if:

- the red-team suite is green
- the operator checklist above is complete
- launch remains `L0` only
- no unresolved blocker remains on compiled-job policy, dependency, or domain telemetry
