# Desktop effort contract fixture

`desktop-effort-catalog.json` is the evaluated `MODEL_CATALOG` export from
`tetsuo-ai/agenc-desktop` origin/main at
`231273663c3e6db36506673a4c5afd526ec40531` (2026-09-22; it reproduces the
126 rows taken at `7849e260`)
plus the `gpt-6-sol` and `gpt-6-luna` rows that the Desktop
`feat/openai-gpt-6-sol-luna` change generates from this Core registry
(levels none through max; `none` is sent on the wire for these two models).
Core lands first, so the contract covers them before Desktop offers them;
refresh from Desktop main once that change is merged.
The source is `src/renderer/src/modelCatalog.ts`, including its shared catalog imports.

To refresh, fetch that repository, bundle the source with esbuild for Node (ESM),
import `MODEL_CATALOG`, and project every row to `{ provider, model, levels:
row.efforts ?? [], defaultLevel: row.defaultEffort }`, omitting absent defaults.
Do not derive the fixture from Core's catalog: it is the independent Desktop
contract used by both the resolver tests and the real background-runner contract.

The runner tests exercise every advertised level, an out-of-set runtime level,
active-turn rejection, durable snapshots, and unchanged global configuration.
Rows without effort controls still participate in provider/model selection checks.
No live provider calls or credentials are required.
