# Optional first-party plugin distribution

## Decision

IoT Builder, Zero-day Hunter, and Wallet CLI Harness are first-party plugins,
not core runtime features. Their source lives under `plugins/`, while the root
`marketplace.json` is the remotely servable catalog. A clean runtime build does
not copy, register, enable, or install any of them.

The authoritative implementation is `runtime/src/plugins/**`. The older
`runtime/src/utils/plugins/**` compatibility stack is not part of this
distribution contract.

## CLI contract

```text
agenc plugin marketplace catalog [--product <id>] [--json]
agenc plugin marketplace install <name@marketplace> [--product <id>]
                                  [--scope user|project|local]
                                  [--force] [--json]
agenc plugin update <id> [--scope user|project|local] [--source <source>]
agenc plugin uninstall <id> [--scope user|project|local] [--keep-data]
```

Catalog JSON uses schema version `1` and canonical IDs in
`name@marketplace` form. Product filtering follows `policy.products`; an entry
with no product restriction is available to every product, while a restricted
entry requires a matching `--product`.

Marketplace install preserves structured Git `path`, `ref`, and `sha` in the
resolver cache identity and `.agenc-plugin/agenc-install.json`. The same
coordinates are reused by `plugin update`. Installed rows carry explicit
`id`, `scope`, and `operationId` (`plugin:<scope>:<id>`); callers must not infer
identity from a source URL.

`--json` returns one JSON document for both successful and failed catalog and
marketplace-install operations. The catalog does not imply installation.
Remote catalog entries carry normalized inline `interface` metadata plus
`version`, `description`, and component kinds. Desktop can therefore render
plugin and skill cards before installation without fetching or executing the
plugin source.

## Package boundaries

- `iot-builder`: the former bundled skill plus its board, toolchain, workflow,
  and electrical-safety references.
- `zeroday-hunter`: plugin manifest, UI metadata, and skill content. Runtime
  build sync and built-in publication paths are removed.
- `ledger-wallet-cli`: Wallet CLI Harness skill, strict Python wrappers, and a
  stdio MCP adapter. Core slash commands, branded status UI, download manager,
  model-facing installer/status tools, public gateway promotion, and ordinary
  prompt routing are removed. The obsolete Ledger Nano UI assets and generator
  are removed with the UI.

## Zero core exceptions

All Ledger-specific behavior lives in the optional `ledger-wallet-cli` plugin.
Core has no branded prompt token, model-facing transfer tool, session authority
claim, client action or receipt type, capability route, recovery schema, UI,
command, installer, or status surface. A clean runtime therefore cannot route
or execute a Ledger operation unless the user explicitly installs and invokes
the plugin.

Generic accounting/evidence ledgers and search exclusions for directories
named `ledger` are unrelated and remain core.

## Publication

The source catalog intentionally uses relative first-party repository
subdirectories and does not auto-install anything. This makes an explicitly
added local checkout usable for development. The same relative payloads remain
remote-origin content when the marketplace itself was added from Git or a
server, and the catalog/install command then requires the runtime's existing
remote-plugin signature verification.

Remote marketplace provenance is carried into installation even when an entry
points at a directory inside an already-downloaded marketplace. Such payloads
must contain `.agenc-plugin/signature.json`, and its Ed25519 publisher must be
present in the configured `plugin-publishers.json` keyring. Update reuses the
recorded signature requirement, so a signed install cannot silently downgrade
to an unsigned update.

### Current publication blocker

The repository does not contain a Tetsuo AI plugin signing private key (and it
must never do so), an official corresponding public-key/keyring entry, or
signed payload manifests for the three first-party plugins. Consequently, a
remote install is deliberately fail-closed until a
release owner performs all of the following outside the repository:

1. provision the official Ed25519 signing key in the release secret store;
2. publish its public key through the trusted publisher-keyring channel;
3. generate `.agenc-plugin/signature.json` for each final release payload using
   the runtime's `pluginSignaturePayloadBytes` contract; and
4. publish the marketplace at an immutable release ref/full commit SHA and
   document that pin for remote marketplace addition.

Tests use an ephemeral Ed25519 key solely to exercise a real
install-disable-enable-update-uninstall lifecycle. That fixture is not a
publisher identity and is never shipped. No runtime signature check is relaxed
while the production signing material is unavailable.
