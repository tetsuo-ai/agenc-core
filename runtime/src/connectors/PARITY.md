# Connectors Parity

Donor references are local-only parity metadata for C-06.

Primary source anchor:
- `/home/tetsuo/git/codex` at `c8c30d9d75556ecbe94991af22380d2a4e9d6589` // branding-scan: allow local parity citation

Source files inspected end-to-end:
- `codex-rs/connectors/src/accessible.rs` // branding-scan: allow local parity citation
- `codex-rs/connectors/src/filter.rs` // branding-scan: allow local parity citation
- `codex-rs/connectors/src/merge.rs` // branding-scan: allow local parity citation
- `codex-rs/connectors/src/metadata.rs` // branding-scan: allow local parity citation
- `codex-rs/connectors/src/lib.rs` // branding-scan: allow local parity citation
- `codex-rs/core/src/connectors.rs` // branding-scan: allow local parity citation

C-06 scope carried into AgenC:
- `types.ts` owns the app/connector catalog, tool annotation, and app policy data model.
- `metadata.ts` owns connector display labels, mention slugs, install identifiers, value normalization, and deterministic sorting.
- `accessible.ts` owns accessible connector aggregation from tool metadata, including name/description upgrades and plugin-display-name de-duplication.
- `filter.ts` owns disallowed connector filtering, first-party originator handling, and tool-suggest discoverable connector filtering.
- `merge.ts` owns directory/accessibility merge semantics and plugin connector placeholders.
- `connectors.ts` owns app enabled-state overlays, app tool policy evaluation, requirement constraints, app plugin-source overlays, and pure accessible-tool conversion.

Intentional C-06 scope reductions:
- Network-backed directory fetching, cache eviction timers, auth headers, daemon/MCP manager construction, and environment-manager wiring remain outside C-06. This item lands the pure catalog and policy primitives that those later integrations can call.
- AgenC does not carry donor-hosted install URLs. `metadata.ts` emits stable `urn:agenc:connector:*` identifiers because no network request is made by this catalog layer.
- `core/src/connectors.rs` spans live daemon/auth/MCP wiring. C-06 ports its pure policy, enabled-state, accessible-tool, and plugin-source behaviors into `connectors.ts`; runtime fetch/manager wiring is deferred.
