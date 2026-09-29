# Child provider selection policy replay

This is a held-out synthetic policy evaluation. Its outcome matrix is a deterministic mock, not measured provider quality, latency or spend. It verifies that task-aware routing can avoid simulated costly failures and obey constraints. It does not prove that AgenC outperforms a commercial router or that one real model outperforms another.

The fixture prompts and expected outcomes are separate from the selector's profile source. Do not tune profile scores against these fixture rows. Live DeepSeek results must be reported separately. A future measured multi-provider matrix can use the same replay format and must identify its provenance.

Run on the Linux test host after building the branch:

```sh
node_modules/.bin/tsx runtime/scripts/eval-child-provider-selection.ts
```

The report compares completed tasks, actual fixture outcome cost (including failed attempts), completed tasks per dollar and total latency. Baselines are always strongest, always cheapest and fixed parent. A selected route that lacks an outcome is an uncovered task, not a success.
