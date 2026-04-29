# Compiled Job Phase 1 Operator Live Drill Checklist

This is the production-only live drill for `Phase 1 / L0 only`.

Use it after:

- `L0` runtime work is merged
- devnet validation is complete
- the launch scope is explicitly limited to `L0`

Use this together with:

- `runtime/docs/compiled-job-phase1-launch-readiness.md`
- `runtime/docs/observability-incident-runbook.md`
- `runtime/docs/MARKETPLACE_OPERATOR_SURFACE.md`

## Goal

Prove that the production environment is operable, not just correct in code.

The drill is successful only if we verify:

- launch controls work
- alert routing works
- operator response works
- rollback/version controls work
- dependency failures fail closed

## Roles

Minimum participants:

- drill lead
- operator on keyboard
- alert receiver / on-call observer
- scribe

Recommended:

- platform owner
- marketplace owner

## Evidence To Capture

Create one shared drill note and capture:

- UTC start/end time
- environment name
- current deployed runtime version
- current `compilerVersion`
- current `policyVersion`
- enabled `jobType` list
- screenshots or logs for every control toggle
- alert receipt timestamps
- acknowledge timestamps
- rollback timestamps
- final pass/fail per section

## Preflight

Do not start the drill until all of these are true:

- [ ] production RPC endpoint is healthy
- [ ] production runtime is deployed and reachable
- [ ] `L0` job types are explicitly listed and enabled
- [ ] non-`L0` job types are disabled
- [ ] blocked-run telemetry is visible
- [ ] policy-failure telemetry is visible
- [ ] domain-denial telemetry is visible
- [ ] alert destinations are configured
- [ ] kill switch / pause controls are reachable by operators
- [ ] quota and rate-limit configuration is visible to operators
- [ ] compiler/policy version controls are visible to operators
- [ ] audit retention posture is confirmed as `archive`

## Drill 1: Global Pause

Purpose:

- prove we can stop compiled job execution globally without redeploying

Steps:

1. Record current launch-control state.
2. Trigger the global compiled-job pause.
3. Attempt one known-good `L0` job submission.
4. Confirm the run is denied before model execution.
5. Confirm blocked-run telemetry is emitted with the correct deny reason.
6. Remove the global pause.
7. Re-run the same known-good `L0` job.
8. Confirm it is accepted again.

Pass criteria:

- [ ] paused run is denied
- [ ] deny reason is visible in telemetry/logs
- [ ] resumed run is accepted

## Drill 2: Per-Job-Type Disable

Purpose:

- prove we can isolate one `jobType` without stopping all `L0` traffic

Steps:

1. Choose one enabled `L0` job type.
2. Disable only that `jobType`.
3. Attempt a run of the disabled `jobType`.
4. Attempt a run of a different enabled `L0` job type.
5. Re-enable the disabled `jobType`.

Pass criteria:

- [ ] disabled `jobType` is blocked
- [ ] other enabled `L0` job types still work
- [ ] telemetry identifies the blocked `jobType`

## Drill 3: Quota And Rate-Limit Response

Purpose:

- prove saturation controls stop excess traffic cleanly

Steps:

1. Lower one safe non-production threshold for the drill window.
2. Drive enough test traffic to exceed the configured threshold.
3. Confirm new runs are denied before execution starts.
4. Confirm the deny reason is attributed to the execution governor.
5. Restore the normal threshold.
6. Confirm new runs can start again.

Pass criteria:

- [ ] excess traffic is denied
- [ ] denial is visible in telemetry
- [ ] restored thresholds allow traffic again

## Drill 4: Compiler / Policy Version Rollback

Purpose:

- prove operators can stop a bad rollout by version, not just by full pause

Steps:

1. Record the currently allowed `compilerVersion` and `policyVersion`.
2. Temporarily deny one test version or narrow the allowlist for the drill.
3. Attempt a run using the denied version.
4. Confirm the run is blocked with the correct version-control reason.
5. Restore the previous allowed versions.

Pass criteria:

- [ ] denied version is blocked
- [ ] version-control deny reason is visible
- [ ] restored versions allow traffic again

## Drill 5: Dependency Fail-Closed

Purpose:

- prove runtime dependencies fail closed rather than degrading into unsafe execution

Run at least one of the following, whichever is safest in the target environment:

- review-broker unavailable
- network-broker unavailable
- sandbox dependency unavailable

Steps:

1. Choose one dependency path and document the blast radius.
2. Make the dependency unavailable in a controlled way.
3. Attempt a known-good `L0` run that requires that path.
4. Confirm the run is denied before model execution.
5. Confirm dependency-failure telemetry is emitted.
6. Restore the dependency.
7. Confirm the same run can proceed again.

Pass criteria:

- [ ] dependency outage causes fail-closed denial
- [ ] no unsafe degraded execution occurs
- [ ] recovery restores normal behavior

## Drill 6: Alert Routing And Acknowledge

Purpose:

- prove alerts reach humans, not just dashboards

Steps:

1. Trigger one known alert-producing condition during the drill.
2. Record when the alert is emitted.
3. Record when the on-call or alert receiver sees it.
4. Record when it is acknowledged.
5. Confirm the receiver knows the first response step from the runbook.

Suggested helper:

```bash
npm run drill:compiled-job:operator-live -- \
  --alert-primary-url "$DRILL_ALERT_PRIMARY_URL" \
  --alert-backup-url "$DRILL_ALERT_BACKUP_URL"
```

After the alert lands, rerun with the prior artifact and the recorded human
timestamps:

```bash
npm run drill:compiled-job:operator-live -- \
  --resume-artifact runtime/artifacts/phase1-closeout/host/operator-live-drill-host.json \
  --alert-receiver-seen-at "<utc timestamp>" \
  --alert-acknowledged-at "<utc timestamp>" \
  --alert-first-response-step "Pause the affected L0 job type and inspect compiled-job telemetry before restore."
```

Pass criteria:

- [ ] alert is delivered
- [ ] human acknowledgement is recorded
- [ ] responder can state the correct first containment step

## Drill 7: Incident Response Walkthrough

Purpose:

- prove the team can operate the system under stress, not just toggle flags

Scenario:

- blocked-run spike
- or policy-failure spike
- or domain-denial spike

Steps:

1. Declare the incident scenario.
2. Identify blast radius.
3. Choose the containment action.
4. Execute the containment action.
5. Gather required evidence:
   - `jobType`
   - `taskPda` or equivalent run id
   - `compiledPlanHash`
   - `compilerVersion`
   - `policyVersion`
   - deny reason
6. State the rollback decision.
7. State the reopen criteria.

Pass criteria:

- [ ] containment choice is correct
- [ ] evidence is captured
- [ ] rollback or restore decision is explicit

## Post-Drill Signoff

All of these must be completed:

- [ ] drill note is stored
- [ ] evidence links are stored
- [ ] any missed alert or unclear step is turned into an issue
- [ ] temporary drill config changes are reverted
- [ ] production config is re-verified after the drill
- [ ] final operator signoff is recorded

## Go / No-Go Rule

`Phase 1 / L0` is ready for mainnet only if:

- [ ] every section above passed
- [ ] any failures were fixed and re-drilled
- [ ] no unresolved operator-gap issue remains open for launch-critical controls

If any launch-critical section fails, the result is:

- `NO-GO for mainnet until re-drilled`
