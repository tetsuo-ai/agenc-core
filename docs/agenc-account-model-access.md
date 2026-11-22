# AgenC account sign-in (retired)

The AgenC account sign-in is retired. Core has no AgenC account: no
`agenc login`, `agenc logout`, `agenc whoami` or `agenc account-access`, no
`/login`, `/logout`, `/whoami` or `/subscription`, and no `auth.*` daemon
methods. Phone remote control (`agenc remote`, `/remote`) went with it, since
pairing needed that sign-in.

AgenC runs on your own model provider: an API key, your sign-in with OpenAI
(ChatGPT) or X / xAI (Grok), or a local server. OpenRouter free models need
your own OpenRouter key and keep their model IDs and defaults. See
[provider setup](reference/providers.md) and [OpenRouter setup](managed-openrouter.md).

## What happens to an existing sign-in

At its first start after the update, the daemon removes what the sign-in
stored on this computer: `auth.json` in `AGENC_HOME` and the session token in
native secure storage. A phone pairing (`remote/pair.json`) is removed too.
Nothing is printed unless a step fails; a failed step is tried again at the
next start. Saved provider keys and provider sign-ins are kept.

## Old configuration

Configuration from before still loads:

- `[auth]` (including the older `[auth.managed_keys]`) and `[remote_control]`
  are ignored. `agenc config unset auth` and `agenc config unset remote_control`
  remove them; `agenc config set` refuses them.
- `model_provider = "agenc"`, `model = "agenc"` and `[providers.agenc]` are
  dropped, so the next configuration layer or the default provider applies.
  Loading then shows one notice.
- `AGENC_AUTH_BACKEND`, `AGENC_REMOTE_AUTH_*` and `AGENC_BACKEND_URL` are no
  longer read.
