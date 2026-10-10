# FND algorithm baseline v1

This artifact records bounded current and historical-reference observations.
Every row is informational: no result is a performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `3dafa7fb8ae7c3ce7c3ad22192d5257511f183b9c6a625f4163b47b6315fab36`
- Source revision: `d23e7d4a86e0b83285314f896cf1ab9d5c8ee35a`
- Production tree: `runtime/src` at Git object `236f88851517f0190a81813e56ed471290af8c90`
- Loaded production closure: `91` module bindings across `2` cases
- Plan SHA-256: `672538014498283c935efce76c0a5244abd280aadaeb5a03a9d835f041db2ebe`
- Node/npm: `v26.5.0` / `11.17.0`
- OS/CPU: `linux 7.0.0-34-generic x64` / `AMD Ryzen 9 9900X 12-Core Processor` (24 logical)
- RAM: `32214446080` bytes
- Source filesystem: type `61267`, block `4096` bytes
- Fixture filesystem: type `61267`, block `4096` bytes
- SQLite/ripgrep: `3.53.3` / `ripgrep 15.0.0 (rev 3a612f88b8)`

| Case | Input | Status | Median ms | MAD ms | Worker peak RSS bytes | RSS lower-bound bytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 74.678 | 0.970 | 217784320 | 217784320 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 153.001 | 2.934 | 242614272 | 242614272 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 309.089 | 3.323 | 211525632 | 210812928 |
| `patch_delete_parser_historical_comparison` | `hunkCount=8000` | `completed` | 2.372 | 0.201 | 91918336 | 91918336 |
| `patch_delete_parser_historical_comparison` | `hunkCount=16000` | `completed` | 4.972 | 0.254 | 107601920 | 107405312 |
| `patch_delete_parser_historical_comparison` | `hunkCount=32000` | `completed` | 9.800 | 0.540 | 128782336 | 128782336 |

## Assessment notes

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_historical_comparison`: Historical comparison only: artifact commit 3431a40ea, bound to source revision 925f3ec2860abf48e0c6c0830d135da2587a4d69 (JSON SHA-256 8c72fc88fd10dfde2f91bd7cc3ce8028af552781b7b699db9931529cac0abd07), recorded a 355.764281 ms median for 32,000 delete hunks while the old parser repeatedly sliced the unconsumed suffix. Current production advances line indices without suffix slicing; this case replays the same generated workload and is not a performance threshold.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision d23e7d4a86e0b83285314f896cf1ab9d5c8ee35a --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
