# FND algorithm baseline v1

This artifact records bounded current and historical-reference observations.
Every row is informational: no result is a performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `643cc4fff54776dbe071bfcc2bbc4d49834a8746c6dbe18ea23c1b7ebb21b8b7`
- Source revision: `1b2c09ab31d42950c58bfff7c310a87bdcd8c216`
- Production tree: `runtime/src` at Git object `c35847bc328424b6e1b09e105fc695533a851c18`
- Loaded production closure: `92` module bindings across `2` cases
- Plan SHA-256: `672538014498283c935efce76c0a5244abd280aadaeb5a03a9d835f041db2ebe`
- Node/npm: `v26.5.0` / `11.17.0`
- OS/CPU: `linux 6.12.94+ x64` / `Intel(R) Xeon(R) Processor` (4 logical)
- RAM: `16791945216` bytes
- Source filesystem: type `2035054128`, block `4096` bytes
- Fixture filesystem: type `2035054128`, block `4096` bytes
- SQLite/ripgrep: `3.53.3` / `ripgrep 15.0.0 (rev 3a612f88b8)`

| Case | Input | Status | Median ms | MAD ms | Worker peak RSS bytes | RSS lower-bound bytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 119.399 | 2.561 | 191254528 | 191254528 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 234.476 | 2.705 | 228077568 | 224858112 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 470.393 | 13.948 | 225214464 | 222490624 |
| `patch_delete_parser_historical_comparison` | `hunkCount=8000` | `completed` | 4.117 | 0.600 | 96325632 | 96325632 |
| `patch_delete_parser_historical_comparison` | `hunkCount=16000` | `completed` | 8.670 | 0.512 | 110850048 | 110718976 |
| `patch_delete_parser_historical_comparison` | `hunkCount=32000` | `completed` | 17.729 | 1.359 | 132071424 | 132071424 |

## Assessment notes

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_historical_comparison`: Historical comparison only: artifact commit 3431a40ea, bound to source revision 925f3ec2860abf48e0c6c0830d135da2587a4d69 (JSON SHA-256 8c72fc88fd10dfde2f91bd7cc3ce8028af552781b7b699db9931529cac0abd07), recorded a 355.764281 ms median for 32,000 delete hunks while the old parser repeatedly sliced the unconsumed suffix. Current production advances line indices without suffix slicing; this case replays the same generated workload and is not a performance threshold.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision 1b2c09ab31d42950c58bfff7c310a87bdcd8c216 --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
