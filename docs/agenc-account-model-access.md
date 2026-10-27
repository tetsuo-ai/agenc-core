# Account sign-in and model access

AgenC accounts no longer provide models, provider credentials, sponsored model
credits, or model proxies. Sign-in remains available for account identity,
marketplace features, remote access, and desktop synchronization.

Use your own model-provider key, sign in directly with that provider where
supported, or connect a local server. OpenRouter free models require your own
OpenRouter key and retain their existing model IDs and defaults.

`agenc account-access --json` remains a compatibility response. It reports
account authentication, `managedModelsEnabled: false`, and an empty `models`
array. It does not request model catalogs, usage, enrollment, or credentials.
Login does not change the selected provider or model.

Old `[auth.managed_keys]` and `[auth.managedKeys]` configuration sections are
accepted and ignored with one notice per configuration load. See
[provider setup](reference/providers.md) and [OpenRouter setup](managed-openrouter.md).
