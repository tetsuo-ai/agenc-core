# Plugin Kit

`@tetsuo-ai/plugin-kit` is now owned by the standalone public repository:

- Repo: `https://github.com/tetsuo-ai/agenc-plugin-kit`
- npm: `@tetsuo-ai/plugin-kit`

This local document exists so AgenC internal docs tooling and search still have
an indexed pointer after the package left monorepo-local authority.

Canonical public docs:

- README: `https://github.com/tetsuo-ai/agenc-plugin-kit/blob/main/README.md`
- CHANGELOG: `https://github.com/tetsuo-ai/agenc-plugin-kit/blob/main/CHANGELOG.md`
- API baseline: `https://github.com/tetsuo-ai/agenc-plugin-kit/blob/main/docs/api-baseline/plugin-kit.json`

The private runtime host implementation for plugin-backed channels remains in
the AgenC runtime.

Runtime host ABI contract:

- `plugin_api_version`: `1.0.0`
- `host_api_version`: `1.0.0`

Channel adapter manifests use the snake-case fields above. AgenC connector
status payloads expose the same pair under `abi` for both built-in V1
connectors such as Telegram and hosted channel plugins, so operators can verify
compatibility through `agenc connector status` and the daemon-backed dashboard.
