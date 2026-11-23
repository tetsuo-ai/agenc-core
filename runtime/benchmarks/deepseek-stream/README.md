# DeepSeek stream replay benchmark

Deterministic replay benchmark for long DeepSeek token streams, through
the real entry point `DeepSeekProvider.chatStream`
(`deepseek/index.ts` → OpenAI adapter `streamChatCompletions` →
`readSseEvents` → `parseSSEFrames` in `src/llm/_deps/sse.ts`).
No network, no HTTP connection reuse: a fake `fetchImpl` returns a
`Response` whose body is a `ReadableStream` replaying committed fixture
SSE bytes in pre-sliced chunks.

## Run

```sh
cd runtime
~/workspace/.toolchain/node-v26.12.1-linux-x64/bin/node --import tsx \
  benchmarks/deepseek-stream/run.mts --out results/base.json
```

(`tsx` is hoisted to the repository-root `node_modules`; `--import tsx`
resolves it from there. The equivalent tsx-CLI form is
`node ../node_modules/tsx/dist/cli.mjs benchmarks/deepseek-stream/run.mts`.)

Protocol: 5 warmup iterations (discarded), then 30 measured samples per
fixture. Override with `BENCH_WARMUP` / `BENCH_SAMPLES`; the results JSON
records the counts used. Setup (provider construction, fixture
load/encode/slicing) happens before the timed region; timing is
`performance.now()` around the `chatStream` call only.
TTFVT = time to the first `onChunk` carrying `content.length > 0`.

Each run also builds a canonical serialization of everything the
consumer saw (ordered `onChunk` payloads + final response
content/reasoning/toolCalls/usage/finishReason) and its sha256 — the
output-identity golden. The harness throws if any warmup or measured
sample diverges from the golden hash.

## Fixtures

Generated deterministically (seeded mulberry32, no bench-time
randomness) by `generate-fixtures.mts`; regenerate with:

```sh
cd runtime
~/workspace/.toolchain/node-v26.12.1-linux-x64/bin/node --import tsx \
  benchmarks/deepseek-stream/generate-fixtures.mts
```

Regeneration is byte-identical (fixture sha256 values are in
`fixtures/manifest.json`).

| fixture | bytes | delta frames | reasoning | content | tool init | tool-arg fragments | finish | usage | [DONE] |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| short | 11,838 | 48 | 16 | 26 | 1 | 5 | 1 | 1 | 1 |
| long | 984,432 | 4,101 | 2,000 | 1,400 | 1 | 700 | 1 | 1 | 1 |

Frames are standard chat-completions SSE (`data: {json}\n\n`, model
`deepseek-flash`). The long fixture's single `system.echo` tool call has
its 6,251-byte arguments JSON fragmented across 700 small deltas. The
terminal usage frame is DeepSeek-shaped (`prompt_tokens`,
`completion_tokens`, `total_tokens`, `prompt_cache_hit_tokens`,
`prompt_cache_miss_tokens`,
`completion_tokens_details.reasoning_tokens`).

## Chunking

Fixture bytes are sliced by the fixed pattern in `lib.mts`
(`CHUNK_PATTERN = [7, 1024, 13, 4096, 3, 251, 8192, 61, 997, 17, 2048, 5]`,
cycled), identical across runs and revisions. Tiny chunks guarantee
boundaries land mid-frame / mid-line / mid-JSON-token; large chunks
carry many frames at once. Long fixture: 707 chunks. Short fixture:
7 chunks.

## Profiling

```sh
cd runtime
mkdir -p benchmarks/deepseek-stream/results/cpu-prof
PROFILE_ITERATIONS=400 \
~/workspace/.toolchain/node-v26.12.1-linux-x64/bin/node \
  --cpu-prof --cpu-prof-dir=benchmarks/deepseek-stream/results/cpu-prof \
  --cpu-prof-name=long.cpuprofile \
  --import tsx benchmarks/deepseek-stream/profile-loop.mts
```

See `results/profile-summary.md` for the measured findings and
`results/profile-top.txt` for the raw self/inclusive table.

## Files

- `generate-fixtures.mts` — deterministic fixture generator.
- `fixtures/{short,long}.sse`, `fixtures/manifest.json` — fixtures + stats.
- `lib.mts` — chunk slicing, replay fetch, recording run, canonical
  serialization, statistics. Shared by `run.mts` and `profile-loop.mts`.
- `run.mts` — the benchmark.
- `profile-loop.mts` — long-fixture loop for `--cpu-prof`.
- `results/base.json` — base-revision results (see commit).
- `results/cpu-prof/long.cpuprofile` — V8 CPU profile of the long loop.
