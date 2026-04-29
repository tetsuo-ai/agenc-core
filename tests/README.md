# Core Test Suites

This directory holds root-level integration and protocol-adjacent test suites
for `agenc-core`.

Important areas:

- `tests/*.ts` - TypeScript integration, security, lifecycle, and protocol coverage
- `tests/fixtures/` - shared fixture data
- `tests/mock-router/` - local mock-router crate and support assets

These suites complement the workspace-local tests in `runtime/`, `mcp/`,
`tools/proof-harness/`, and other packages.

