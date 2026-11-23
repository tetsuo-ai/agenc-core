# CPU profile — long fixture, base revision

Method: `profile-loop.mts`, 400 iterations of the long fixture
(4,101 delta frames / 984,432 bytes / 707 chunks per iteration) under
`node --cpu-prof` (see README). 6,213 samples over 7,130.8 ms.
Raw table: `profile-top.txt`. Profile: `cpu-prof/long.cpuprofile`.
Percentages are share of all samples (including ~4.7% one-time module
loading and ~3.2% harness recording-callback self-time, both noted).

## Top self-time

| % self | function | where |
| ---: | --- | --- |
| 33.83 | `parseProviderJson` (a thin `JSON.parse` wrapper) | `src/llm/wire/parse-json.ts` |
| 10.38 | `parseSSEFrames` | `src/llm/_deps/sse.ts` |
| 6.89 | `streamChatCompletions` (adapter event loop body) | `src/llm/providers/openai/adapter.ts` |
| 6.02 | `(program)` — idle, waiting on the stream | — |
| 5.92 | `readSseEvents` (generator body: decode + buffer concat + yield) | `src/llm/providers/openai/adapter.ts` |
| 4.46 | `RegExp: \n\n\|\r\n\r\n` — the separator regex created per `parseSSEFrames` call | `src/llm/_deps/sse.ts` |
| 4.25 | `(garbage collector)` | — |
| 3.19 | harness recording `onChunk` (benchmark's own callback) | `benchmarks/deepseek-stream/lib.mts` |

Inclusive: `readSseEvents` 57.44%, `decodeOpenAISseEventBatch` 34.65%,
`decodeOpenAISseEvent` 34.06%, `parseSSEFrames` 14.84%,
`streamChatCompletions` loop 18.80%.

## Suspects checked by measurement

- **JSON.parse — CONFIRMED, largest single cost.** `parseProviderJson`
  is literally `JSON.parse` in a try/catch. It is called once per SSE
  frame from `decodeOpenAISseEvent` (inside `readSseEvents`), i.e.
  4,103 parses per long stream: 33.8% self / 34.1% inclusive.
- **parseSSEFrames — CONFIRMED, second cost, and the largest
  chunk-processing-specific cost.** 10.4% self plus its separator
  RegExp at 4.5% = 14.8% inclusive. Per incoming chunk it: allocates a
  fresh global RegExp, slices every frame out of the buffer
  (`buffer.slice(position, separator)`), runs `replace(/\r/g, "")` over
  the whole frame, `split("\n")`, and slices every line twice
  (field + value). `readSseEvents` additionally re-concatenates
  `buffer += decoder.decode(...)` per chunk and hands the whole
  accumulated buffer in each time.
- **TextDecoder in readSseEvents — EXONERATED.** `decode` 0.84% +
  native `decodeUTF8` 1.03% ≈ 1.9% combined.
- **ThinkTagStreamFilter — EXONERATED.** Its `push` does not appear in
  the top 30 self-time functions (< 0.24%). (`splitLeadingThinkBlock`
  at 0.40% is the one-shot final-response split, not the stream filter.)
- **ToolArgumentProgress — EXONERATED.** `push` = 0.31% self despite
  700 argument fragments per stream.
- **Async-generator yield overhead — SMALL.** No distinct yield/next
  machinery appears in the top functions; the generator's own body
  (`readSseEvents` self, 5.9%) bundles decode, buffer concatenation
  and yielding together.
- **Per-event object churn in the adapter loop — PRESENT but second
  order.** `streamChatCompletions` self is 6.9% and GC is 4.25%,
  consistent with per-event allocation (event objects, choice/delta
  records, chunk objects), but it is well behind JSON.parse and
  framing combined.

## Bottleneck conclusion

The single most promising client-side bottleneck in
incoming-stream-chunk processing is the **per-chunk framing +
per-frame decode pipeline in `readSseEvents`: `parseSSEFrames`
(14.8% inclusive, incl. 4.5% for a separator RegExp re-created on
every call) feeding `decodeOpenAISseEventBatch` → `JSON.parse`
(34.1% inclusive)**. Together they are ~49% of all samples. Of the
two, `parseSSEFrames` is the part with clearly redundant work per
chunk (fresh regex, whole-frame slice + `\r` replace + line splits,
on top of `readSseEvents`' `buffer +=` copy), while `JSON.parse` is
the largest single function and sets the floor for any per-frame
object-materializing design. Any optimization phase should target
this pipeline first, and must keep the golden output hash
(`results/base.json`) identical.
