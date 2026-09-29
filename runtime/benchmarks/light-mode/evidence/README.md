# Evidence publication

Final study measurements are still in progress. This directory intentionally contains no selected results yet.

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
