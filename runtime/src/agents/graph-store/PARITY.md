# Agent Graph Store Parity

Source root: `/home/tetsuo/git/codex` at `c8c30d9d75556ecbe94991af22380d2a4e9d6589`. <!-- branding-scan: allow donor citation in local parity artifact -->

Primary source anchors:
- `codex-rs/agent-graph-store/src/lib.rs` <!-- branding-scan: allow donor citation in local parity artifact -->
- `codex-rs/agent-graph-store/src/error.rs` <!-- branding-scan: allow donor citation in local parity artifact -->
- `codex-rs/agent-graph-store/src/types.rs` <!-- branding-scan: allow donor citation in local parity artifact -->
- `codex-rs/agent-graph-store/src/store.rs` <!-- branding-scan: allow donor citation in local parity artifact -->
- `codex-rs/agent-graph-store/src/local.rs` <!-- branding-scan: allow donor citation in local parity artifact -->

This directory owns AgenC's storage-neutral parent/child graph API for
thread-spawned agents:
- `types.ts` defines the open/closed lifecycle status used by persisted edges.
- `errors.ts` provides the shared graph-store error shape.
- `store.ts` defines the storage-neutral interface.
- `local.ts` implements the interface over AgenC's existing SQLite
  `thread_spawn_edges` table.
- `local.test.ts` covers direct-child ordering, status filters, status updates,
  breadth-first descendants, and preservation of existing AgenC edge metadata.

ZC-34 coverage lock:
- The graph store uses the same durable table already consumed by
  `RolloutStore`, so hierarchical recovery reads one source of truth.
- Graph-only upserts preserve existing AgenC `parent_path` and `metadata_json`
  when a richer runtime edge already exists.
- Missing-child status updates are successful no-ops.
- Descendant listing is breadth-first by depth, then by child thread id, and a
  status filter prunes traversal at every edge.
