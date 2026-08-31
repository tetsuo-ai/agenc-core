# FND algorithm baseline v1

This artifact records bounded current and historical-reference observations.
Every row is informational: no result is a performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `f9a1048a8624941986761246a3aaed70d4b571c81b40d6af50a7560be6a84bcd`
- Source revision: `e9ce0f5b84e690f711e8f89f9e18cf4ca37ffd5f`
- Production tree: `runtime/src` at Git object `42ebd99369b550a19efad028ede3627396b9cf33`
- Loaded production closure: `92` module bindings across `2` cases
- Plan SHA-256: `672538014498283c935efce76c0a5244abd280aadaeb5a03a9d835f041db2ebe`
- Node/npm: `v26.5.0` / `11.17.0`
- OS/CPU: `linux 7.0.0-30-generic x64` / `AMD Ryzen Threadripper PRO 9975WX 32-Cores` (64 logical)
- RAM: `1081089343488` bytes
- Source filesystem: type `61267`, block `4096` bytes
- Fixture filesystem: type `16914836`, block `4096` bytes
- SQLite/ripgrep: `3.53.3` / `ripgrep 15.0.0 (rev 3a612f88b8)`

| Case | Input | Status | Median ms | MAD ms | Worker peak RSS bytes | RSS lower-bound bytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 81.419 | 1.056 | 209448960 | 209448960 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 161.308 | 2.228 | 203055104 | 199495680 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 328.514 | 5.804 | 216551424 | 215089152 |
| `patch_delete_parser_historical_comparison` | `hunkCount=8000` | `completed` | 2.828 | 0.317 | 90038272 | 90038272 |
| `patch_delete_parser_historical_comparison` | `hunkCount=16000` | `completed` | 5.537 | 0.412 | 105865216 | 105865216 |
| `patch_delete_parser_historical_comparison` | `hunkCount=32000` | `completed` | 11.083 | 0.778 | 127729664 | 127729664 |

## Assessment notes

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_historical_comparison`: Historical comparison only: artifact commit 3431a40ea, bound to source revision 925f3ec2860abf48e0c6c0830d135da2587a4d69 (JSON SHA-256 8c72fc88fd10dfde2f91bd7cc3ce8028af552781b7b699db9931529cac0abd07), recorded a 355.764281 ms median for 32,000 delete hunks while the old parser repeatedly sliced the unconsumed suffix. Current production advances line indices without suffix slicing; this case replays the same generated workload and is not a performance threshold.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision e9ce0f5b84e690f711e8f89f9e18cf4ca37ffd5f --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
