# FND algorithm baseline v1

This artifact records bounded current and historical-reference observations.
Every row is informational: no result is a performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `6a149406ffa196c77855fab2642921fd4d1ac273f1592b62e7d845eb8c97d803`
- Source revision: `f44e4a27c637e8a76f5d006a3ef17cbc312d218d`
- Production tree: `runtime/src` at Git object `cbc65d1692a84045c467d8e5e84770d6d7a2bf3b`
- Loaded production closure: `91` module bindings across `2` cases
- Plan SHA-256: `672538014498283c935efce76c0a5244abd280aadaeb5a03a9d835f041db2ebe`
- Node/npm: `v26.5.0` / `11.17.0`
- OS/CPU: `linux 7.0.0-34-generic x64` / `AMD Ryzen 9 9900X 12-Core Processor` (24 logical)
- RAM: `32214446080` bytes
- Source filesystem: type `61267`, block `4096` bytes
- Fixture filesystem: type `2035054128`, block `4096` bytes
- SQLite/ripgrep: `3.53.3` / `ripgrep 15.0.0 (rev 3a612f88b8)`

| Case | Input | Status | Median ms | MAD ms | Worker peak RSS bytes | RSS lower-bound bytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 75.572 | 1.611 | 185208832 | 184750080 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 152.205 | 4.229 | 203923456 | 201060352 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 311.617 | 9.369 | 212971520 | 208056320 |
| `patch_delete_parser_historical_comparison` | `hunkCount=8000` | `completed` | 2.367 | 0.226 | 93798400 | 93798400 |
| `patch_delete_parser_historical_comparison` | `hunkCount=16000` | `completed` | 4.876 | 0.293 | 109154304 | 108957696 |
| `patch_delete_parser_historical_comparison` | `hunkCount=32000` | `completed` | 10.065 | 0.620 | 129720320 | 129720320 |

## Assessment notes

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_historical_comparison`: Historical comparison only: artifact commit 3431a40ea, bound to source revision 925f3ec2860abf48e0c6c0830d135da2587a4d69 (JSON SHA-256 8c72fc88fd10dfde2f91bd7cc3ce8028af552781b7b699db9931529cac0abd07), recorded a 355.764281 ms median for 32,000 delete hunks while the old parser repeatedly sliced the unconsumed suffix. Current production advances line indices without suffix slicing; this case replays the same generated workload and is not a performance threshold.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision f44e4a27c637e8a76f5d006a3ef17cbc312d218d --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
