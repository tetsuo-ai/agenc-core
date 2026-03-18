# agenc

Public CLI and launcher for the AgenC framework.

This package owns the user-facing global install surface:

```bash
npm install -g agenc
agenc onboard
agenc start
agenc
```

It does not expose the runtime source tree directly. Instead, it installs and
launches the matching AgenC runtime artifact for the current supported
platform.

Current public support is intentionally narrow:

- Linux `x64`
- Node `>=18.0.0`

Production release channel:

- npm package: `agenc`
- runtime artifact host: GitHub Releases on `tetsuo-ai/agenc-core`
- trust: embedded signed manifest + embedded public key + embedded trust policy

After the matching runtime artifact is installed, `agenc` can continue to run
offline against the local install.

## Wrapper-local runtime management

```bash
agenc runtime where
agenc runtime install
agenc runtime update
agenc runtime uninstall
```

## Development

The embedded runtime manifest in `generated/` is produced by the `agenc-core`
artifact preparation scripts. Local smoke tests use the same packaged manifest
flow as publish/release preparation.
