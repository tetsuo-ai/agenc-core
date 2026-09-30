# Local companion source-graph build — 2026-09-30

The root-reviewed build-only recipe completed successfully: process 94267,
output cf60a2, exit 0. It ran with an empty environment and a Darwin OS sandbox
denying network access. No emitted module was imported or client launched.

Before the build, `seal-build-inputs.mjs` verified **6,166 Git blobs** against
the exact selected Core commit `403da04398b55e51d1f4e8814f9a70957b0db5ef` and
sealed **37,028** canonical input files, including the previously installed
clean dependency tree, selected toolchain and reviewed companion files. The
manifest is `companion-build-inputs-v1.json`, SHA-256
`a61a4d689b87713ec8867e559b3412a88c664f9ad7441ca3c1a14f71bce388c9`.
It was accepted before compilation, not derived from the successful output.
Builder SHA-256 is `df0e3361ac53c4b2f0721dbce440220507bca87cad77d125278f7e96d04f1e91`.

The build verified every inventoried input before and after compilation, accepted
3,472 actual graph inputs, and found exactly one canonical current-session
module, plus real daemon, Session and OpenAI adapter modules. No test source or
stub resolver was substituted. Output directory: `/private/tmp/light-companion-build-v1`.

| Output | Bytes | SHA-256 |
| --- | ---: | --- |
| `owner-companion.mjs` | 33,748,648 | `546d77ab22e1598144929307c103a3647dff61343afff43c0cceb431f1ffa89e` |
| `owner-companion.mjs.map` | 63,505,600 | `787f3d25640356eb69d4b9116d8870a45f6b74dbfa46fb51c15d07d71aa3fc61` |

The build retains `selection.json`, transformed config, `metafile.json` and
`build-result.json`. Source maps and the generated bundle remain local,
hash-recorded rebuildable outputs, not additional source committed into Core.

Four resolve-only CommonJS probes were unresolved: `@alcalzone/ansi-tokenize`,
`@ant/agenc-for-chrome-mcp`, `@aws-sdk/client-bedrock`, and `source-map-support`.
An unresolved CommonJS probe is not by itself proof of a missing ESM dependency;
these entries require source/package review. They are not replaced with stubs.

This is source-graph compilation, **not a portable deployment, actual runtime
execution, Linux result or speed comparison**. `artifactImported`,
`executionApproved` and `deploymentClosureComplete` remain false. Callback,
preflight, normal CLI/assets/native dependencies and ESM external closure are
separate pending gates. No paid API call, model selection expansion or benchmark
rerun occurred. No running arm was modified. This build overlapped no timing run.
