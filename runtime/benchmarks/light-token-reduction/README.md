# Light request presentation audit

`export-presentation.mjs` executes candidate source presentation functions and hashes their source files. Supply a JSON object mapping `deepseek` and `luna` to tk's first recorded main request bodies. Run with Node/TypeScript installed in the pinned candidate source:

```
node export-presentation.mjs /candidate initial-fixtures.json presentation.json
```

`project.py` applies those presentation changes to all six frozen main Light trajectories under tk's capture root. Its reviewed `audit.py` dependency is explicit and content-hashed. Use tk's DeepSeek tokenizer asset and `o200k_base` cache. Example:

```
python3 project.py --auditor /tk/runtime/benchmarks/token-audit/audit.py \
  --capture-root /round3/jobs/tk --presentation presentation.json \
  --deepseek-tokenizer /tokenizer/deepseek_v4_tokenizer/tokenizer.json \
  --candidate-sha FULL_SHA --out projection.json
```

The JSON includes every request, component counts, source provider counters, fixed-response output tokens and call counts, plus independent head-only/result-only projections. Inputs, calls, results and response reasoning remain trace-selected. The transformation refuses unfamiliar runtime context rather than deleting broadly. The source report and projection are not end-to-end success evidence. In particular, `candidate_cached_tokens` and `provider_usage_candidate` are null: replay cannot establish new provider cache or billing behavior.

Run `python3 -m unittest discover -s runtime/benchmarks/light-token-reduction -p 'test_*.py'` for projector negative controls. Product behavior is covered by the prompt, memory, schema parity, sparse-read, exec-result and framing/execute-tools regression tests.

For actual CLI replay, freeze mh's `benchmarks/light-vs-pi` harness by commit and use `--mode replay --arms light,light --build-sha MAIN_SHA --candidate-build-sha CANDIDATE_SHA`. Map each development task to the same recorded Light response stream for both arms. Its exclusive timing/load guard, fresh repos, sandbox, failure accounting and usage provenance remain authoritative. Keep replay failures; never count source response usage as candidate provider usage. Mh must run the separate live dev A/B before task-success or performance claims.
