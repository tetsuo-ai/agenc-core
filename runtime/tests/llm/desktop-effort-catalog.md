# Desktop effort contract fixture

`desktop-effort-catalog.json` is the evaluated `MODEL_CATALOG` export from
`tetsuo-ai/agenc-desktop` origin/main at
`7849e260c0468a20e0946ad2d17bcf7396b993ad` (2026-09-21).
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
