# FND algorithm baseline v1

This artifact records bounded observations of known failures. Every row is
informational: no current result is a passing performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `7eaf6651240af4b3cbfa82cee0372cb26c1882e8d4d08ea4edefdc7d9d2da29a`
- Source revision: `861acbf233f3d2e75c63659daafc1c73654dc25e`
- Production tree: `runtime/src` at Git object `08b469162bbac1ed021a6ae08a15e1a9b635d72e`
- Loaded production closure: `33` module bindings across `2` cases
- Plan SHA-256: `f845a0595da15849f819d413b42f995107befacfc67ef78a2bf96338fda92025`
- Node/npm: `v26.5.0` / `11.17.0`
- OS/CPU: `linux 7.0.0-28-generic x64` / `AMD Ryzen Threadripper PRO 9975WX 32-Cores` (64 logical)
- RAM: `1081089331200` bytes
- Source filesystem: type `61267`, block `4096` bytes
- Fixture filesystem: type `16914836`, block `4096` bytes
- SQLite/ripgrep: `3.53.3` / `ripgrep 15.0.0 (rev 3a612f88b8)`

| Case | Input | Status | Median ms | MAD ms | Worker peak RSS bytes | RSS lower-bound bytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 83.132 | 2.900 | 175169536 | 175169536 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 158.786 | 3.181 | 197218304 | 194965504 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 320.705 | 8.423 | 205377536 | 200933376 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=8000` | `completed` | 2.853 | 0.432 | 91267072 | 91267072 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=16000` | `completed` | 5.671 | 0.232 | 105320448 | 105320448 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=32000` | `completed` | 12.320 | 1.147 | 126685184 | 126685184 |

## Known-failure policy

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_suffix_slicing`: Delete-only parsing repeatedly slices the unconsumed suffix; the prior audit observed about 28 ms/238 ms/2.98 s at 16k/32k/64k lines.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision 861acbf233f3d2e75c63659daafc1c73654dc25e --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
