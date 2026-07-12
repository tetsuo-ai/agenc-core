# Browser automation

The LIVE **`Browser`** tool drives an **isolated Chromium** over a CDP pipe.
It is a coding-agent capability (not a gateway messaging channel). Related:
[tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md) ·
[config.md](reference/config.md) · [ARCHITECTURE.md](ARCHITECTURE.md).

## What it is

| Property | Value |
| --- | --- |
| Tool name | `Browser` |
| Driver | `runtime/src/browser/` + `runtime/src/tools/BrowserTool/` |
| Profile | Dedicated dir under `$AGENC_HOME/browser/profile` by default — **never** your personal Chrome profile |
| Default mode | Headless |
| Egress | All navigation routes through an **SSRF proxy** that blocks private / loopback / cloud-metadata addresses by default |

The tool uses **accessibility refs** (e.g. `e3` from the latest snapshot) for
click/type targets, not raw CSS selectors.

## Actions

From `BROWSER_ACTIONS` in `BrowserTool/tool.ts` (12):

`navigate`, `snapshot`, `click`, `type`, `press_key`, `scroll`, `screenshot`,
`get_text`, `new_tab`, `tabs`, `select_tab`, `close_tab`.

Read-only-ish actions are auto-approved where the permission rules allow;
navigation and acting actions surface a permission preview in default mode.

## Configuration

### TOML `[browser]`

Known top-level key (`KNOWN_CONFIG_KEYS` includes `browser`).

```toml
[browser]
# executable_path = "/usr/bin/chromium"
headless = true
allow_private_network = false
# profile_dir = "/path/to/dedicated/profile"
no_sandbox = false
navigation_timeout_ms = 30000
```

Whether the tool appears on the agent surface at all is governed by
`tools_config` enable/disable (tool name `Browser`), not only this block.

### Environment overrides

Precedence: **env > config.toml > built-in defaults** (`browser/config.ts`).

| Env | Default | Effect |
| --- | --- | --- |
| `AGENC_BROWSER_EXECUTABLE` | auto-detect | Absolute path to a Chromium-family binary |
| `AGENC_BROWSER_HEADLESS` | on | Headless Chromium |
| `AGENC_BROWSER_ALLOW_PRIVATE_NETWORK` | off | Permit private/loopback destinations (cloud-metadata stays blocked) |
| `AGENC_BROWSER_PROFILE_DIR` | `$AGENC_HOME/browser/profile` | Dedicated profile directory |
| `AGENC_BROWSER_NO_SANDBOX` | off | Pass Chromium `--no-sandbox` (some containers) |
| `AGENC_BROWSER_NAV_TIMEOUT_MS` | `30000` | Navigation timeout (clamped 1s–300s) |

## SSRF / security posture

- Default: **deny** private, loopback, and link-local destinations.
- Cloud metadata endpoints remain blocked even when private network is allowed.
- Only enable `allow_private_network` / `AGENC_BROWSER_ALLOW_PRIVATE_NETWORK=on`
  for intentional local-dev targets.
- Treat page content as **untrusted work data** (same discipline as channel
  payloads and MCP tool results).
- OS sandbox / permission modes still apply around the tool invocation path.

## Operator checklist

1. Install a Chromium-family browser (or set `AGENC_BROWSER_EXECUTABLE`).
2. Leave headless on unless you need a visible window for debugging.
3. Keep private-network off in production / untrusted workspaces.
4. Confirm the agent can call `Browser` under your permission mode
   (`agenc` default is on-request for acting actions).
5. For containers that require it, set `no_sandbox` carefully and prefer a
   constrained container runtime over blanket host privileges.

## Not this surface

| Surface | Status |
| --- | --- |
| Messaging channels (Telegram, Discord, …) | [gateway.md](gateway.md) — separate |
| Remote CDP attach / multi-host browser farms | Open / roadmap residual (not the local isolated driver) |
| Signal / WhatsApp / email channels | Not shipped |

## Validation

- Unit / integration tests under `runtime/tests/` for browser + SSRF helpers
- LIVE catalog row in [tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md)
- Schema validation: `validateBrowserConfig` in `runtime/src/config/schema.ts`
