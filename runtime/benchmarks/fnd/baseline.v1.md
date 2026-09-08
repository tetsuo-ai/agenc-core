# FND algorithm baseline v1

This artifact records bounded current and historical-reference observations.
Every row is informational: no result is a performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `43e1fe22f22ee7669a6fbfe3d61472c142ee68299fec39b13f23fc1a86eb8702`
- Source revision: `87bbfcf13c2a5cc4bc5431ea2762e6389ec613c5`
- Production tree: `runtime/src` at Git object `ff3829b500404e249a54dd59a6109cfa40f22e90`
- Loaded production closure: `100` module bindings across `2` cases
- Plan SHA-256: `672538014498283c935efce76c0a5244abd280aadaeb5a03a9d835f041db2ebe`
- Node/npm: `v26.5.0` / `11.17.0`
- OS/CPU: `linux 7.0.0-30-generic x64` / `AMD Ryzen Threadripper PRO 9975WX 32-Cores` (64 logical)
- RAM: `1081089343488` bytes
- Source filesystem: type `61267`, block `4096` bytes
- Fixture filesystem: type `16914836`, block `4096` bytes
- SQLite/ripgrep: `3.53.3` / `ripgrep 15.0.0 (rev 3a612f88b8)`

| Case | Input | Status | Median ms | MAD ms | Worker peak RSS bytes | RSS lower-bound bytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 82.302 | 1.243 | 209743872 | 209743872 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 166.370 | 3.763 | 202723328 | 198258688 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 334.101 | 9.928 | 222973952 | 222416896 |
| `patch_delete_parser_historical_comparison` | `hunkCount=8000` | `completed` | 2.892 | 0.369 | 90693632 | 90693632 |
| `patch_delete_parser_historical_comparison` | `hunkCount=16000` | `completed` | 5.528 | 0.299 | 105881600 | 105881600 |
| `patch_delete_parser_historical_comparison` | `hunkCount=32000` | `completed` | 10.938 | 0.826 | 127500288 | 127500288 |

## Assessment notes

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_historical_comparison`: Historical comparison only: artifact commit 3431a40ea, bound to source revision 925f3ec2860abf48e0c6c0830d135da2587a4d69 (JSON SHA-256 8c72fc88fd10dfde2f91bd7cc3ce8028af552781b7b699db9931529cac0abd07), recorded a 355.764281 ms median for 32,000 delete hunks while the old parser repeatedly sliced the unconsumed suffix. Current production advances line indices without suffix slicing; this case replays the same generated workload and is not a performance threshold.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision 87bbfcf13c2a5cc4bc5431ea2762e6389ec613c5 --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
