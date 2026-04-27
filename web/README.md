# @tetsuo-ai/web

Daemon-backed dashboard surface for AgenC operators.

This workspace owns the web dashboard build under `src/`, static assets under
`public/`, and browser-facing tests under `tests/`.

The dashboard is the public `agenc ui` product surface. It is always a client
of the local daemon/gateway mounted at `/ui/`; it must not create a second
runtime, independent session store, connector service, or marketplace authority.
`agenc ui` opens the loopback daemon URL (`http://127.0.0.1:<port>/ui/`) and
`agenc ui --no-open` prints the same URL for SSH and automation handoff.

Access rules:

- WebSocket state/actions must come from the daemon control plane.
- The browser connects back to the same daemon origin unless an explicit test
  URL is provided.
- If `auth.secret` is configured, local dashboard access requires
  `auth.localBypass=true`; otherwise `agenc ui` fails before opening a browser.
- TUI, CLI, shell, and web sessions all share the same daemon session and policy
  authority.

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
