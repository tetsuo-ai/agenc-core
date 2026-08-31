# Sign in with X — Grok subscription access (no API key)

The first-run model-access step can sign you into xAI directly; choose
**Sign in with X / xAI** without entering a slash command. The same flow is
available later through `/grok-login` or the headless CLI
`agenc grok-login`. It uses an eligible **SuperGrok or X Premium
subscription** for Grok inference, including `grok-4.6`, instead of a
metered `XAI_API_KEY`.

## Usage

Headless CLI (desktop Sign in with Grok, scripts, SSH):

```text
agenc grok-login [device] [--json]
agenc grok-logout [--json]
agenc grok-auth-status [--json]
```

`--json` emits one NDJSON progress record per OAuth stage, then a result
record and exit code. Tokens never appear in the output. Stages:

| Stage | When |
| --- | --- |
| `authorize` | Browser PKCE URL opened |
| `callback_received` | Loopback callback accepted |
| `exchanging_code` | Authorization code → tokens |
| `device_fallback` | Browser callback flow failed; switching to device code |
| `device_authorize` | Device-code URL + user code shown |

Aliases: `xai-login`, `xai-logout`, `xai-auth-status`. Other arguments
are rejected. `-h` / `--help` prints usage without changing credentials.

Inside the TUI:

```text
/grok-login          # browser sign-in (primary)
/grok-login device   # headless: shows a code + URL to open on another device
/grok-logout         # delete the stored tokens
```

The browser flow opens `auth.x.ai` and returns through a loopback callback
on `127.0.0.1:56121`. On headless/SSH hosts (or when that port is taken,
e.g. by the Grok CLI) the device-code flow is used automatically.

The consent page may be labeled **"Grok Build"** — xAI serves this flow
through their shared CLI OAuth client; that is expected. The authorize
request carries `referrer=agenc` so xAI can attribute usage (their request).

## How it interacts with API keys

- `/grok-login` OAuth **always wins** over `XAI_API_KEY` / `GROK_API_KEY`.
  While a stored OAuth token is present, leftover env
  API keys are **ignored** for Grok inference.
- Env BYOK applies only when no OAuth token is available (never signed in, or
  after `/grok-logout`). Credential order is then:
  explicit session key → `XAI_API_KEY` → `GROK_API_KEY`.
- Tokens are stored in native secure storage (macOS Keychain, Linux Secret
  Service, or a DPAPI-protected file under `AGENC_HOME` on Windows; no
  plaintext fallback). Tokens refresh automatically (~6 h access tokens with
  rotating refresh tokens). xAI expired bearers are often **403**; refresh
  runs on 401 and 403 (two attempts). Admitted turns do not in-band retry:
  they pre-flight refresh if the stored token is near expiry. Transient
  refresh failure does not force `/grok-login`.
- The OAuth bearer is only ever sent to `api.x.ai` / `*.grok.com`. A custom
  grok base-URL override refuses to start in OAuth mode — set a real API
  key (and no OAuth token) to use gateways.

## Troubleshooting

- **403 "no active Grok subscription"** right after a successful login:
  xAI enforces entitlement at request time, keyed by account email. Make
  sure your X account and grok.com account use the **same email**, or fall
  back to `XAI_API_KEY` billing.
- **Refresh loops / signed out unexpectedly**: a dead refresh token is
  quarantined rather than retried (xAI rotates refresh tokens). Run
  `/grok-login` again.

## Composer models (ACP)

Per xAI, `grok-composer-*` models are only served through ACP — the Grok
Build CLI (`grok agent stdio`) — never by direct inference calls. AgenC
honors that: selecting `grok-composer-2.5-fast` (e.g. `/model
grok:grok-composer-2.5-fast`) spawns the Grok CLI as an ACP subprocess
instead of calling `api.x.ai`.

Requirements and behavior:

- The **Grok Build CLI must be on PATH** (override with `AGENC_GROK_CLI`)
  with a completed `grok` login (its own cached OAuth token), or
  `XAI_API_KEY` set. The spawn env carries `GROK_OAUTH2_REFERRER=agenc`
  for xAI usage attribution.
- Composer runs the CLI's own agent loop; agenc tools are not offered to
  it (`supportsToolUse: false`). Agent permission requests (file writes,
  terminal) are **rejected by default** so agenc keeps workspace
  authority; set `AGENC_GROK_ACP_PERMISSIONS=allow` to let the CLI use its
  own tools.
