# @tetsuo-ai/web

Private dashboard/client surface for AgenC operators.

This workspace owns the web dashboard build under `src/`, static assets under
`public/`, and browser-facing tests under `tests/`.

Current shell split:

- `MARKET` is the operator marketplace workspace for tasks, skills, governance,
  disputes, and reputation
- `TOOLS` is the internal runtime tool registry surface

The marketplace workspace lives under `src/components/marketplace/` and is
split into domain panes instead of one monolithic view file.

Local commands:

```bash
npm --prefix web run dev
npm --prefix web run build
npm --prefix web run typecheck
npm --prefix web run test
npm --prefix web run test:e2e
```

This is a product surface inside `agenc-core`, not a public builder package.
