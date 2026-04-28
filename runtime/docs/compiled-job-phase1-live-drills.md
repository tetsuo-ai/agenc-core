# Compiled Job Phase 1 Live Drills

This document covers the remaining Phase 1 validation work that is not fully
closed by unit tests, CI gates, or a single devnet smoke.

Use this together with:

- `runtime/docs/compiled-job-phase1-launch-readiness.md`
- `runtime/docs/marketplace-mainnet-v1-readiness.md`
- `runtime/docs/observability-incident-runbook.md`
- `docs/DEPLOYMENT_CHECKLIST.md`

## Scope Split

We should be explicit about what each environment can prove.

### Devnet-proveable

- production RPC/provider behavior under sustained load, approximated against the launch RPC path
- repeated multi-run soak testing over longer periods
- marketplace flow stability across repeated dispute lifecycles

### Runtime-host proveable

- sandbox fleet behavior under real concurrent load

### Production-only live drills

- alert routing in the real production environment
- on-call response in the real production environment
- final operator runbook execution as a live drill

### Out of launch scope

- broader non-`L0` autonomous behaviors

Phase 1 launch does not require non-`L0` autonomous behavior coverage. Those
flows remain intentionally out of scope until a later launch tier.

## Devnet Soak Drill

Use the marketplace soak harness for repeated runs against the deployed devnet
program and the currently selected RPC provider.

Baseline command:

```bash
npm run smoke:marketplace:mainnet-v1:devnet -- \
  --mode soak \
  --iterations 3 \
  --child-max-wait-seconds 300
```

Full launch-scope run:

```bash
npm run smoke:marketplace:mainnet-v1:devnet -- \
  --mode all \
  --iterations 3 \
  --child-max-wait-seconds 300
```

Acceptance:

- repeated `tui` runs complete end to end
- no unclassified failures occur
- `429` noise is recorded in the soak artifact and stays within an operator-reviewed baseline
- any deferred plain-flow dispute artifacts are captured with exact resume paths

Evidence:

- readiness artifact JSON written by `scripts/marketplace-mainnet-v1-devnet.ts`
- referenced child smoke artifact paths for any deferred resumes

## Sandbox Fleet Concurrency Drill

Use the sandbox fleet drill on a runtime host with Docker available.

Baseline command:

```bash
npm run drill:sandbox:fleet -- --sandboxes 4 --jobs-per-sandbox 2 --waves 2
```

Higher-pressure command:

```bash
npm run drill:sandbox:fleet -- \
  --sandboxes 8 \
  --jobs-per-sandbox 3 \
  --waves 3 \
  --job-duration-ms 3000 \
  --max-tracked-jobs 96
```

If the host class hits the default tracked-job ceiling during the pressure run,
raise it explicitly with `--max-tracked-jobs` (or
`AGENC_SYSTEM_SANDBOX_MAX_TRACKED_JOBS`) and record the chosen launch ceiling in
the artifact note.

Acceptance:

- all requested sandboxes start successfully
- all requested sandbox jobs exit cleanly
- cleanup succeeds without orphaned containers
- no unexpected `system_sandbox.*` failures appear in the drill artifact

Evidence:

- sandbox artifact JSON written by `scripts/sandbox-fleet-drill.ts`
- Docker/container logs captured separately if a wave fails

## Alert Routing Live Drill

This must be run in the real launch environment. Devnet alone cannot prove that
production alert routing pages the correct people.

Checklist:

1. Trigger one synthetic `compiled_job.blocked_runs_spike` condition.
2. Confirm the alert reaches the real destination:
   - pager
   - Slack/incident room
   - dashboard annotation if configured
3. Confirm the alert payload includes:
   - `jobType`
   - deny reason
   - compiler/policy version context
4. Record delivery latency and destination evidence.

Operator drill helper:

```bash
npm run drill:compiled-job:operator-live -- \
  --alert-primary-url "$DRILL_ALERT_PRIMARY_URL" \
  --alert-primary-label "primary drill alert" \
  --alert-backup-url "$DRILL_ALERT_BACKUP_URL" \
  --alert-backup-label "backup drill alert"
```

To complete the human acknowledgement leg after the alert has been observed,
rerun the operator drill with the previous artifact as the resume source:

```bash
npm run drill:compiled-job:operator-live -- \
  --resume-artifact runtime/artifacts/phase1-closeout/host/operator-live-drill-host.json \
  --alert-receiver-seen-at "2026-04-23T18:12:07Z" \
  --alert-acknowledged-at "2026-04-23T18:13:10Z" \
  --alert-first-response-step "Pause the affected L0 job type and inspect compiled-job telemetry before restore."
```

Acceptance:

- primary alert destination receives the page
- backup destination receives the same incident context
- no silent drop occurs

## On-Call Response Live Drill

This must also be run in the real launch environment.

Checklist:

1. Use the routed synthetic alert from the alert-routing drill.
2. Confirm the on-call responder acknowledges within the agreed response window.
3. Confirm the responder can:
   - identify the affected `jobType`
   - locate the relevant telemetry
   - pause the affected launch surface or job type
4. Record the exact acknowledge and mitigation timestamps.

Acceptance:

- acknowledgement occurs inside the response target
- the responder reaches the correct control surface without escalation confusion
- evidence is attached to the launch record

## Final Operator Runbook Live Drill

Run this after alert routing and on-call response are confirmed.

Checklist:

1. Walk the incident/abuse path in `compiled-job-phase1-launch-readiness.md`.
2. Exercise:
   - per-job-type disable
   - global pause
   - compiler/policy version rollback control lookup
   - audit-retention confirmation
3. Confirm the operator can gather:
   - `jobType`
   - `taskPda`
   - `compiledPlanHash`
   - `compilerVersion`
   - `policyVersion`
   - deny reason / denied host
4. Record a written go/no-go note at the end of the drill.

Acceptance:

- the runbook is executable without improvisation
- no missing link, dashboard, or ownership handoff blocks containment
- the launch owner signs off on the evidence pack

## Phase 1 Closeout Rule

Phase 1 should only be called mainnet-ready when:

- the devnet soak artifact is green for the chosen launch scope
- the sandbox fleet drill is green on the runtime host class that will serve launch traffic
- alert routing and on-call response have been exercised in the real launch environment
- the final operator runbook drill has been completed and recorded
