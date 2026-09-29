# Evidence publication

Final study measurements are still in progress. This directory intentionally contains no selected results yet.

The summary reports both complete three-way acceptance and `owner_target_accepted` for Pi versus Light. Missing normal-mode usage blocks complete three-way evidence but does not change a fully observed Pi/Light comparison. Recorded timeouts and other failed attempts remain in pass, token, cost and wall-time denominators. Every Light task completed by Pi must pass all Light repeats; each model must also meet the token, median and p90 gates. Unknown Pi/Light usage, unmatched sampling and other evidence defects still block the owner gate.

`test-results.json` records the completed Core/Desktop regression comparisons and SHA256 hashes of all retained study-labelled test logs. The final Core full run has four extra failed observations; matching-main or passing isolated checks support no reproducible Light-specific regression, not a green full suite. Desktop has zero new failures. Earlier interrupted and failed runs remain in the hash inventory and are not silently substituted for acceptance evidence.

`legacy-harness/*.py.txt` preserves the exact historical local runner source hashes for auditing, not as recommended launchers. The original baseline source SHA256 is `9f8287611438941866cdaee3728d30c54ca985b395cf0858323cf718a34d89ad`. The later local runner fixes outcome/usage accounting and rejects incomplete-attempt reuse; its DeepSeek request settings, agent commands and task protocol are unchanged. Completed results are never replaced. Use the maintained portable runner at the package root for new studies. The accounting reconciliation report identifies the immutable original ledger and every reserve-price adjustment.

After all selected runs and accounting files stop changing, export allowlisted metrics with `export_evidence.py` on Linux:

```sh
python3 "$HARNESS/export_evidence.py" --runs "$BENCH_ROOT/runs" \
  --ledger "$BENCH_ROOT/spend-deepseek.jsonl" \
  --ledger "$BENCH_ROOT/spend-openai.jsonl" \
  --phases baseline,candidate-FINAL --out "$BENCH_ROOT/public-evidence"
```

Supply only ledgers that exist. An older study may use different ledger filenames. The export keeps selected per-run metrics, all attempts including failures/incomplete runs, all supplied per-call spend accounting, and SHA256 hashes of retained raw artifacts. `CANCELLED-BEFORE-LAUNCH.json` marks a cancellation separately; it is not a failed coding attempt or a provider request. The export does not publish request bodies, responses, logs, homes, source trees, provider error bodies, credentials or absolute paths. Historical raw pass fields are retained beside conservative effective outcomes.

Review the exported files and scan them before copying them here. Add the final summary table, immutable study configuration, phase selection, source revisions, price/date and limitations. The raw hash inventory links each exported run to private retained artifacts; it does not make those raw sessions public. Task count, repeat count and missing/incomplete evidence remain visible.

Historical Luna ledger records sometimes stored a zero placeholder. Identifiable subscription/Luna records export `cost_usd: null` and `cost_basis: subscription-unpriced`; the old numeric value is retained only as `reported_cost_usd`. The raw ledger is never rewritten, and a zero budget charge is not presented as a priced provider charge.
