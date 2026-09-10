# AgenC models after account login

Core resolves hosted models from the authenticated account rather than a static
subscription-tier or private-pilot default. `agenc account-access --json` reads
the native credential store, checks account usage/authority, and intersects the
active `pilotAccess.models` with the backend's AgenC catalog. It returns only
public allowance, model and access-expiry fields. It does not vend an upstream
key or run inference. Usage lookup can idempotently enroll an eligible campaign
account; a signed-out lookup does not request enrollment.

Successful CLI/TUI/onboarding login selects an eligible model for future
conversations. Canonical provider/model defaults are saved atomically, and an
incompatible reasoning preference is replaced by the reviewed model default.
An explicit BYOK provider remains selected. Existing conversations and their
permission policies are not rewritten. Expired, exhausted, paused or unavailable
access supplies no selectable models and cannot revive a retired Qwen default.

Desktop must call the public CLI contract instead of reading `auth.json` or
copying a bearer into the renderer. An empty catalog means no eligible models;
the hidden registry supplies capabilities, never authorization. Old clients
without this CLI require an update. The explicit legacy usage-helper seam is
retained for private integrations.

## Sponsored DeepSeek route, September 10, 2026

The backend currently authorizes `deepseek/deepseek-v4-flash-0731`, displayed as
DeepSeek V4 Flash 0731 under AgenC. The internal adapter is OpenRouter; its
name is not the user-facing provider. The reviewed DeepInfra FP8 endpoint has
a 1,048,576-token context, an 8,192-token default output budget and a
384,000-token provider output limit. These are endpoint-specific values.

Only `medium` is reviewed for this managed route. The managed adapter omits
unsupported `parallel_tool_calls`, accepts the reviewed effort, preserves
reasoning for tool continuation, and uses a stable idempotency key for retries.
It supports text/function calling; this is not vision or batch transport.
The direct DeepSeek provider is a separate generic Chat Completions adapter;
this change does not implement its full new-model thinking/effort contract.
It also does not expose every model in OpenRouter's upstream catalog.

The real Linux Desktop smoke completed file reading and a final streamed reply
at 14:34:43 UTC. Recorded usage was USD 0.001452. Streamed and non-streamed
synthetic tests exercise tool-call/result continuation. This verifies those
paths, not every agent tool, model, effort level or long-context workload.

An earlier upstream failure retains a pending reservation in the backend. A
hold is not a confirmed charge; never clear it without authoritative recovery
evidence. For an active single promotional grant, the public allowance projects
confirmed spend from the integer grant/balance and exposes pending reserves
separately. It does not infer spend from expired funds or a recent-history page.

The access `expiresAt` can be shorter than the grant because it is limited by
the policy/session authority. It must not be labelled as the monthly credit
expiry. The account portal's credit page is authoritative for full history and
the grant deadline. Backend handoff: `docs/operations/account-login-clients-20260910.md`
in `tetsuo-ai/agenc-backend`.

## Verification

Run `npm run test:fast` and the focused account-access, promotion-allowance and
AgenC DeepSeek tests. The login tests cover fresh/retired defaults, retained
BYOK preferences, expired access, malformed catalogs and public-only output.
The wire tests instantiate the actual managed provider with a synthetic
transport; no production credential is needed. Live tests must remain bounded
and use synthetic content. Source validation is not an installer release.
