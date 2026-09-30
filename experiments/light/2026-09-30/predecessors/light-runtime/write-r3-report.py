import json,pathlib
root=pathlib.Path('/private/tmp/light-runtime'); bench=root/'core/runtime/benchmarks/runtime-overhead'
before=json.loads((root/'evidence/r3-paired-before-summary.json').read_text());after=json.loads((root/'evidence/r3-paired-after-summary.json').read_text())
measured={'before_commit':'025d23295d8fa32fe8fb8b5ec183c55e490fbb8f','after_validation_commit':'e6d260717','after_src_tree':'18bd634c6f8109b60892cf72c1eda530a50c378e','after_admission_blob':'940a47292e33de21e83af64cb6e4d2cb42b4790d','note':'After replay metadata records base 025d23295 plus r3-source.patch. The sole production edit has the same Git blob on both machines and in the validated commit.','before':before,'after':after}
(bench/'round3-evidence.json').write_text(json.dumps(measured,indent=2)+'\n')
rows=[('Task wall','wall'),('Runtime outside tools','runtime_outside_tools'),('Session create','daemon.session_create'),('First request assembly','first_request_assembly'),('All prompt assembly','prompt.assembly'),('Response end to tool start','response_to_tool'),('Gaps between tools','between_tools'),('Last tool end to next request','tool_to_request'),('Model admission','admission.model'),('Tool admission','admission.tool'),('Receipt commit/projection','receipts.commit'),('History sync','persistence.history'),('Rollout flush','persistence.flush'),('Explicit rollout fsync','persistence.fsync'),('SQLite immediate transaction','persistence.sqlite_immediate'),('SQLite deferred transaction','persistence.sqlite_transaction'),('SQLite immediate count','persistence.sqlite_immediate.count'),('SQLite deferred count','persistence.sqlite_transaction.count'),('Explicit rollout fsync count','fsync_count'),('Session teardown','daemon.session_teardown'),('Mean inter-call overhead','gap'),('p95 inter-call overhead','p95')]
def value(g,k):
 if k=='daemon.session_create' and k not in g['spans_per_task']: k='lifecycle.session_create'
 if k=='daemon.session_teardown' and k not in g['spans_per_task']: k='lifecycle.teardown'
 return g['wall_ms'] if k=='wall' else g['boundary_mean_ms'] if k=='gap' else g['boundary_p95_ms'] if k=='p95' else g['spans_per_task'].get(k,0)
def table(rows):
 s='| Metric | SDK before | SDK after | Cold before | Cold after | CLI warm before | CLI warm after |\n|---|---:|---:|---:|---:|---:|---:|\n'
 for label,k in rows:
  vals=[value(d['groups'][mode],k) for mode in ['daemon','cold','warm'] for d in [before,after]]
  s+='| '+label+' | '+' | '.join(f'{v:,.1f}' for v in vals)+' |\n'
 return s
b=before['groups']['daemon'];a=after['groups']['daemon'];bs=b['spans_per_task'];aa=a['spans_per_task']
text=f'''# Runtime fast path, Round 3

Draft PR: https://github.com/tetsuo-ai/agenc-core/pull/2821

Round 3 retains the durability barriers and removes unnecessary writer transactions from read-only admission queries. Warm SDK runtime outside tools is **{bs['runtime_outside_tools']/1000:.2f} -> {aa['runtime_outside_tools']/1000:.2f} s/task**; inter-call overhead is **{b['boundary_mean_ms']:.1f} -> {a['boundary_mean_ms']:.1f} ms** in this matched run. The 1.0 s/task and 40 ms targets remain unmet. No model spend.

## What changed

- `state/execution-admission.ts`: `get` and `list` retain consistent multi-query snapshots using deferred read transactions. Four single-statement read APIs use SQLite's statement snapshot directly. None reserves the WAL writer slot. All mutation, reservation, dispatch, deadline/cancellation and accounting checks remain inside their existing immediate transactions with FULL sync.
- `tests/state/execution-admission.test.ts`: a second connection holds an uncommitted write while all six changed read APIs return committed data without blocking. The next read observes that write only after commit.
- `tests/session/admission-group-commit.test.ts`: new provider-wire and tool-effect cases inject canonical fsync failure, prove zero publication and zero physical dispatch, and retry with a durable tail repair and exactly one dispatch record.
- `benchmarks/runtime-overhead/summarize.py` and its tests: immediate/deferred transaction counts and per-call rates; exclusive pre-tool attribution; actual fsync counts classified by the innermost flush boundary. Empty and append-only flush attempts are not misreported as durable flushes.

## Boundary limit and stopped work

The exact retained guarantee is **a durable admission grant or effect acknowledgement cannot become observable before its canonical record is fsynced; physical dispatch additionally requires the final cancellation/deadline check and dispatch record to commit**.

The current contracts contain more acknowledgement boundaries than just model requests and effect batches:

1. `acquire()` durably grants a reservation and publishes it before returning. A tool's permission/sandbox work can then await before physical dispatch.
2. Effect intent commits and is published before invoking the adapter. `markDispatched()` later linearizes the final cancellation/deadline check under the authoritative SQLite writer lock, commits the dispatch evidence, and synchronously flushes the canonical projection before crossing the physical boundary.
3. Effect results commit before publication or caller continuation. Admission reconciliation also commits and publishes its journal/usage before returning. Checkpoint events have their own durable-before-publication contract.

Buffering all those records until just the next request or effect would publish acknowledged evidence before durability, or acknowledge/release accounting capacity before settlement is committed. Marking dispatch at reservation time would misclassify cancellation during permission/sandbox awaits and weaken the final dispatch check. Moving effect and in-flight state off-path would weaken the unknown-outcome gate. Those deferrals were not made. Reaching two flushes would require a new cross-owner prepare/commit/publication protocol, with explicit rollback and recovery semantics, not simply a flush timer. This round stops at those guarantees; it does not claim the performance targets are fundamentally impossible under a future protocol.

No durable flushes were removed in Round 3, so the existing SIGKILL matrix continues to test the same boundaries. The new failure/retry case at each dispatch boundary adds coverage for the exact fail-closed rule. No derived table was moved off-path, and prompt assembly was not changed. This is a partial improvement and boundary audit, not completion of the requested batching redesign.

## Measurement

Same zero-cost replay and four recorded tasks 03/07/09/12, one repeat, alternating before/after order; cold, resident-daemon CLI and existing SDK connection. All 24 runs preserve recorded call counts, have no replay mapping errors, and pass coding checks. All task results and trace hashes are retained in `round3-evidence.json`. Existing SDK session priming and CLI startup are excluded from the primary number, as in Round 2. Real tools run locally; tool.invoke interval unions are subtracted. Shared-host storage variation remains, and a single repeat is not a confidence interval. Fsync durations fell despite identical counts, and the unchanged receipt path also became faster; the full observed timing difference cannot be attributed to the read-lock change. The reliable structural result is the reduction in read-side writer transactions. Do not compare this run causally with Round 2's older 1.57 s / 89 ms window.

Before is Round 2 `025d23295`. After replay records that base plus `r3-source.patch`; its only production edit matches Git blob `940a47292e33de21e83af64cb6e4d2cb42b4790d` on both machines. Linux validation uses `e6d260717`, with production tree `18bd634c6f8109b60892cf72c1eda530a50c378e`. Final documentation/evidence amendment leaves that source unchanged. STATUS.md names the final integration commit. The original main comparison is retained in ROUND1.md, and Round 2 in ROUND2.md.

## Span table

Milliseconds per task unless labelled count. Inclusive rows overlap. Cold/CLI creation and teardown are instrumented session spans; SDK uses RPC timings. Transaction counts count instrumented top-level calls, not SQLite fsync syscalls. Removing read transactions must not be described as eliminating durable commits.

'''
# Session spans use daemon.session_create/teardown in all modes in existing summaries.
text+=table(rows)
text+='\n## Immediate transactions and explicit fsyncs per call\n\n'
text+='| Mode | Immediate before | Immediate after | Fsync before | Fsync after |\n|---|---:|---:|---:|---:|\n'
for mode in ['daemon','cold','warm']:
 vals=[d['groups'][mode]['spans_per_task'][key]*d['groups'][mode]['n']/d['groups'][mode]['calls'] for key in ['persistence.sqlite_immediate.count','fsync_count'] for d in [before,after]]
 text+='| '+mode+' | '+' | '.join(f'{v:.2f}' for v in vals)+' |\n'
for prefix,title in [('post_tool.','Exclusive last-tool to request breakdown'),('pre_tool.','Exclusive response to first-tool breakdown')]:
 text+=f'\n## {title}\n\nMilliseconds per task; rows sum to the corresponding interval. Inner fsync/SQLite takes precedence over receipts and admission.\n\n'
 text+=table([(x,prefix+x) for x in ['fsync','sqlite','derived_index','receipts','prompt_assembly','persistence_other','admission','other']])
text+='\n## Actual explicit fsyncs by boundary\n\nWarm SDK mean counts per task, counting only actual fsync spans. Admission groups whose last record is usage are labelled `session_usage`.\n\n| Boundary | Before | After |\n|---|---:|---:|\n'
for k in sorted(set(bs)|set(aa)):
 if k.startswith('fsync_boundary.'):
  text+=f'| {k.split(".",1)[1]} | {bs.get(k,0):.2f} | {aa.get(k,0):.2f} |\n'
text+='\n## Individual SDK samples\n\nThe aggregate gain is concentrated in task03, whose baseline storage spans were slower. Tasks07 and09 are essentially unchanged; this limits the causal timing claim.\n\n| Task | Calls | Runtime before, ms | Runtime after, ms | Gap before, ms | Gap after, ms |\n|---|---:|---:|---:|---:|---:|\n'
for br in before['runs']:
 if br['mode']!='daemon':continue
 ar=next(r for r in after['runs'] if r['mode']=='daemon' and r['task']==br['task'])
 text+=f"| {br['task']} | {br['calls']} | {br['totals']['runtime_outside_tools']:.1f} | {ar['totals']['runtime_outside_tools']:.1f} | {sum(br['boundary_gaps_ms'])/len(br['boundary_gaps_ms']):.1f} | {sum(ar['boundary_gaps_ms'])/len(ar['boundary_gaps_ms']):.1f} |\n"
text+='\n## Tests\n\nTEST_RESULTS_PENDING\n\nNo permissions, sandbox, effect receipts, recovery policy, provider requests, prompts or tool presentation changed. No edits to light/converged, no real provider calls, no deployment or merge.\n'
(root/'REPORT.md').write_text(text);(bench/'REPORT.md').write_text(text)
print('report generated')
