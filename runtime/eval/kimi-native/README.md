# Native Kimi CLI sweep

This suite drives the built `runtime/bin/agenc` in Light mode with structured
JSON output. This activates the CLI's existing exact-output contract and
leaves task acceptance to the independent grader, avoiding a conflicting
prose completion checklist. It does not
implement an alternative agent loop. Its six fixtures cover file read-back,
a multi-file rename with tests, a failing-test debugging task, six sequential
pipeline stages, an attached image, and a tokenizer-calibrated 96k to 101k
input prompt. Native models come from authenticated Moonshot discovery.

Use only an isolated sweep root containing `home-zdr` and the six exact
`slot-zdr-1` through `slot-zdr-6` directories. Both `HOME` and `AGENC_HOME`
are set to `home-zdr`. Trust these folders through AgenC's normal prompt
before running with bypass approvals. The suite never writes trust records.
It preserves previous slot contents under each run's `prior-slot` directory.

Supply `MOONSHOT_API_KEY` in the calling environment, sourced inside a
subshell with tracing disabled. Never put credentials in arguments, fixtures,
reports, or configuration files. Only that provider credential is forwarded
to the CLI. Stop any existing daemon for this isolated home before starting,
so its process loads `wire.mjs` and uses the same evidence control file.

```sh
python3 runtime/eval/kimi-native/run.py \
  --sweep /absolute/isolated/sweep \
  --evidence /absolute/private/evidence \
  --model kimi-k3.1-pro --task file --phase before --repeat 1
```

Run sequentially, newest models first. Use a new repeat number for independent
samples and `--phase after` for confirmation after a fix. The task determines
its slot. `--quota-probe` permits an unfunded refusal diagnostic. It does not
turn a refused request into a solve. If token estimation is also refused,
this mode records an unmeasured long-prompt probe explicitly. Normal funded
runs require successful calibration.

The owner ledger starts at $0.191416725 spent and has a $24 cumulative cap
and a $1 remaining-balance floor. The owner requested at least $20 of native
testing. Existing ledgers keep their original limits unless explicitly
reconciled against renewed owner authorization.
It records cash plus vouchers, including debt hidden by available balance.
Deposits never erase previously recorded spend. Each completion checks the
balance and reserves a conservative admission envelope of $12 per million
request bytes plus $40 per million allowed output tokens, with a separate
image allowance. Large requests use the provider tokenizer, adding tool
definition bytes, framing and a token margin. These are admission bounds,
not model prices. Actual usage is priced from the official native table
read on 2026-10-23, including K3.1. When balance settlement lags, admission
uses the higher of observed spend and priced usage with a 10% margin.
Reports distinguish priced usage from balance deductions. Requests have
a 4,096 output cap.
Outstanding reservations prevent another request after uncertain transport
or capture failures. Do not reset the ledger to resume a budget-limited run.

Evidence includes per-request usage and timing, balance changes, tool calls,
and reasoning hashes. Headers and keys are never recorded. The artifact
grader also requires observable tool behavior. A matching output file alone
does not prove read-back, debugging, test execution, or reasoning replay.
Completion warnings are failures even if the artifact is correct.

After completing the base matrix, `--seed N` generates shuffled archives
with 24 fresh retrieval values for long-context stress runs. Use
`--target-tokens N` to calibrate longer prompts; the runner requires room
for another 32,768 tokens within the discovered model's context window.
Use unique repeat numbers and the same ledger. The seed, target, tokenizer
estimates and actual request usage are recorded for reproducibility.

Local checks, with an isolated home:

```sh
node --test runtime/eval/kimi-native/wire.test.mjs
python3 -m unittest discover -s runtime/eval/kimi-native -p 'test_*.py'
node runtime/scripts/run-hermetic-vitest.mjs run \
  tests/llm/kimi-funds.test.ts tests/llm/kimi-harness.test.ts \
  tests/llm/providers/kimi/provider.test.ts tests/llm/wire/kimi-contract.test.ts
```

## Context caching

Native Kimi caches prefixes automatically with a five-minute TTL. AgenC sends
its stable session `prompt_cache_key` and keeps stable system instructions
before the changing session tail. No explicit cache objects, IDs, breakpoints,
or special message roles are required. Moonshot documents block-based writes
but does not publish a numeric minimum block size.

For K3-family sessions whose turns may be more than five minutes apart, set
`AGENC_KIMI_CACHE_TTL=1h` in the client environment. `5m` is also accepted;
omitting the variable retains Moonshot's default. API callers can override it
with `LLMChatOptions.promptCacheTtl`. K2 requests omit this unsupported control.
Hits renew the original TTL at no extra write charge. The first write locks the
TTL until the entry expires, so changing the setting does not convert an
existing entry. AgenC uses the response's five-minute and one-hour write counts
for billing, rather than guessing from the requested TTL. Writes and hits are
subsets of total input, and reasoning is part of output, not additional usage.

See the [complete caching guide](https://platform.kimi.ai/docs/guide/context-caching),
[Chat API](https://platform.kimi.ai/docs/api/chat), and
[pricing](https://platform.kimi.ai/docs/pricing/chat). The wire evidence records
only the two numeric cache billing headers, prefix/tool hashes and a hash of
the routing key. It never records authentication headers.

Run the complete matrix and the explicitly authorized native spend target:

```sh
python3 runtime/eval/kimi-native/suite.py \
  --sweep /absolute/isolated/sweep --evidence /absolute/private/evidence \
  --first-repeat 20 --target-spend 20
```

The suite stops on any failed or incomplete run. Investigate, add the general
fix and its regression test, then use new repeat numbers for confirmation.
It preserves solved runs and the cumulative ledger when resumed. Larger
seeded retrieval tasks exercise 200k-token K2 and up to 500k-token K3 contexts
within the same per-request budget guard.

Large requests are calibrated with Moonshot's tokenizer. Subsequent turns reuse
that calibration only while the model and complete message prefix match exactly.
Each appended UTF-8 byte counts as a token in the conservative reservation;
changed prefixes or image tails require fresh calibration. Free diagnostic
requests retry one transient failure, with a fresh timeout. Paid inference is
not retried by this guard. After separately confirming a failed stress seed
under a new repeat number, resume with `--stress-only --first-stress-repeat N`.
