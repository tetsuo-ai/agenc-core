# @tetsuo-ai/runtime

Implementation runtime package for AgenC.

`@tetsuo-ai/runtime` is the current operator/runtime implementation baseline in
`agenc-core`. It powers the public `agenc` install surface, but it is not
itself the supported end-user install identity and it is not a supported public
builder target.

The public operator install contract is:

- npm package: `agenc`
- runtime artifact channel: GitHub Releases on `tetsuo-ai/agenc-core`
- canonical local state: `~/.agenc/`

See [docs/architecture/product-contract.md](../docs/architecture/product-contract.md),
[docs/architecture/guides/public-runtime-release-channel.md](../docs/architecture/guides/public-runtime-release-channel.md),
and [docs/architecture/guides/runtime-install-matrix.md](../docs/architecture/guides/runtime-install-matrix.md).

External builders should use:

- `@tetsuo-ai/sdk` for TypeScript integration
- `@tetsuo-ai/protocol` for released protocol artifacts
- `@tetsuo-ai/plugin-kit` for approved plugin and adapter development

## Internal Development

```bash
npm --prefix runtime install
npm --prefix runtime run build
npm --prefix runtime test
npm --prefix runtime run typecheck
```

Useful internal entrypoints:

- `runtime/dist/bin/agenc.js`
- `runtime/dist/bin/agenc-runtime.js`
- `runtime/dist/bin/agenc-watch.js`
- `@tetsuo-ai/runtime/operator-events`

For broader operator and architecture context, start with the root [README](../README.md), [docs/RUNTIME_API.md](../docs/RUNTIME_API.md), and [REFACTOR.MD](../REFACTOR.MD).
