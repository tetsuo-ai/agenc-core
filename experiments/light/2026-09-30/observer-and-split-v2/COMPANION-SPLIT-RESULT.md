# Split companion build and disabled-entry smoke — 2026-09-30

The v2 recipe corrects the v1 companion's import-hoisting defect with split ESM,
without stubs, installation, product changes or selection/permission overrides.
Root reviewed the delta before independently sealing a new input manifest and
building to a new directory. The v1 artifact remains intact and must not be used.

Build48788/28f95f passed under OS network deny: **3,472 accepted graph inputs /
280 output files**. The manifest again covers 37,028 input files after matching
6,166 source Git blobs to403da. Manifest SHA-256:
`c603d313de6290573c693707b3f31fc2edbd2f73798c2737f8aaf5f1e1126b94`.
Builder SHA-256:
`27dc35b0950eb81265b90d402f24230f93a5ea84b3d97cfdcc280465c5f37410`.

The entry's static closure is only `owner-companion.mjs` and
`chunks/chunk-KHT67E7S.mjs`. The absent optional Chrome integration stays in
`chunks/mcpServer-RXZ7YOA2.mjs`, outside that static closure. The canonical
current-session source contributes bytes to exactly one output,
`chunks/chunk-JZWUQEUY.mjs`; it is not duplicated between validator and daemon.

Root read the complete emitted entry and its static chunk, then executed a
separate offline smoke (446cb7): the entry imports, exports `runOwnedForeground`,
and rejects immediately with `cli_fixture_selection_not_accepted` while selection
remains disabled. Fetch was unchanged; no dynamic Core graph, observer, daemon,
client or provider was started. All built output hashes and the three original
external helper hashes were checked before and after this smoke.

Output: `/private/tmp/light-companion-build-v2`. Entry: 3,601 bytes, SHA-256
`2d61db9e11d024f0182a42aad935a45ffd5e3abf4ed2792148b5c2b4cea1dfc5`.
This entry size is **not** a comparison to the old total bundle or a measured
runtime/latency improvement: most code resides in the split chunks.

`build-result.json` truthfully records artifactImported=false at build time;
`disabled-entry-smoke.json` records the later limited static import. Full
deployment closure remains unproven. In particular, this does not establish
that the daemon's later dynamic graph can load all selected ESM/native/assets,
nor that Linux containment, independent preflight, normal CLI execution or a
current matched model benchmark passes. Those execution selections remain false.
