# Split v2 deployment closure audit (read-only, 403da)

Inspected immutable Core `/private/tmp/light-clean-cli-validator-v2-GANyA9/source`
and `/private/tmp/light-companion-build-v2`. No runtime import, build, installation,
remote connection, selection change or provider invocation was performed.

The existing disabled-entry smoke says `dynamicRuntimeImported: false`. It proves
the refusal entry imports, not that foreground initialization or Linux works.
Static traversal of the actual daemon-cli output reaches 70 output modules and
42 distinct non-builtin external specifiers. The owner entry alone reaches only
two modules; using that smaller closure as deployment proof would miss Core.

## Concrete blockers and required assets

| Boundary | Current artifact evidence | Required next deployment input |
|---|---|---|
| Canonical runtime identity | `daemon-cli.ts:638` calls `resolveRuntimePackageRootFromUrl(import.meta.url)`. Its resolver (`daemon-runtime-info.ts:41`) checks module ancestors and cwd. Emitted module lives in `chunks/`; neither output root nor its parent has the runtime package manifest. Foreground enters the private daemon home first (`daemon-cli.ts:343`), so cwd is not a reliable fallback. Without a selected package layout, build fields fall back to `development`/`unknown` (`daemon-cli.ts:664`). | An independently inventoried deployment with the actual selected runtime package manifest and `dist/VERSION` in the canonical geometry. Do not inject a host build-identity override or invent a manifest to bless this bundle. |
| Classifier prompt assets | `src/build/feature.ts:19` has `TRANSCRIPT_CLASSIFIER: true`. `utils/permissions/yoloClassifier.ts:72,78` uses `createRequire(import.meta.url)` for two text assets. Emitted `chunks/chunk-TSXQNFOF.mjs:122983–122984` still requires `./yolo-classifier-prompts/{auto_mode_system_prompt,permissions_external}.txt`. Those paths are absent from the companion output. | Exact selected text assets at the emitting module's relative location. Default permission mode does not justify suppressing enabled module initialization or replacing text with blanks. This is a real asset gap, independent of the optional Chrome issue. |
| Native SQLite | Foreground static graph imports `better-sqlite3`; its actual addon is `node_modules/better-sqlite3/build/Release/better_sqlite3.node`. The selected install's addon is **Mach-O arm64**. The companion node_modules link points to that Darwin tree. | Exact Linux Node/architecture-compatible installed native package, lock/install provenance and ELF/shared-library closure. A JavaScript package entry hash or successful Darwin install is not Linux ABI proof. |
| Linux sandbox startup | Canonical background runner sets `requireSandboxReadyAtStartup: true` (`background-agent-runner.ts:469,563`); bootstrap calls `sandboxExecutionBroker.assertReady("startup")` (`bootstrap.ts:1213`). The broker resolves `bin/agenc-linux-sandbox` from runtime root (`execution-broker.ts:1940`). That launcher imports `dist/sandbox/linux-launcher/main.js`. None is supplied by the companion build. | Selected launcher plus its built graph outside writable workspace; trusted system bubblewrap with descriptor-bind/namespace support, or the canonical fully enforced Landlock fallback. Preserve the real readiness check and its per-policy limits. |
| Linux process ownership | `utils/supervisedProcess.ts:978` seeks sibling `agenc-process-broker`, then native source relative to the module. The fresh companion chunks have neither binary nor source. Canonical fallback may compile using a trusted compiler. | Preselected Linux broker at canonical asset location (and attested build) or separately authorized canonical compiler/header preparation. Do not let measured/client startup silently become a build phase. |
| Landlock fallback | `sandbox/landlock-run.ts:106` searches sibling, parent and grandparent `agenc-landlock-run`; then relative native source. Darwin dist has no Linux binary. | Linux-built launcher and host full-enforcement probe if this fallback is selected. Do not call missing bubblewrap harmless unless canonical Landlock readiness actually passes. |
| Native peer authentication | `daemon-control.ts:804–826` uses root-owned `/usr/lib/agenc` marker/addon when present. Otherwise `transport/peer-credentials.ts:123` can compile a cached addon, requiring compiler and Node headers. `unix-socket.ts:175` calls this during listen. | Inventory the actual selected system addon/marker or separately prepared canonical private cache/compiler/header path. Absence is not universally fatal: cookie/private-socket authentication has its own contract. Do not fabricate peer-proof or silently require/disable a different auth mode. |

## Path-sensitive conditional assets (retain normal semantics)

- `utils/secureStorage/nativeHelper.ts:19` requires an executable **beside its
  emitted chunk**: on Linux `agenc-secret-service-helper`. Darwin dist contains
  `agenc-keychain-helper`, not the Linux helper. Whether native storage is used
  in the explicit synthetic-key path must be observed; absence can affect
  credential/storage features, not be called a proved foreground blocker yet.
- `memory/memory-query-pool.ts:132` resolves `memory-query-helper.js` based on
  `dist` geometry. This separate entry is absent from the companion bundle; the
  selected Core dist has `memory/memory-query-helper.js`. Empty-resource scope
  may never spawn it, but normal memory support cannot be claimed without it.
- Linux hardening/peer helpers, system binaries, procfs boot ID and PID start
  reads are runtime inputs, not captured by the JS metafile. Process identity
  uses `/proc/<pid>/stat` and `/proc/sys/kernel/random/boot_id`
  (`daemon-instance-identity.ts:184–185`). No Darwin process override is valid.

## External package classification

The 70-module foreground static closure includes installed package families
`@alcalzone/ansi-tokenize`, `@anthropic-ai/{sandbox-runtime,sdk}`,
`@modelcontextprotocol/sdk`, axios, better-sqlite3, chalk, chokidar, cross-spawn,
diff, env-paths, execa, figures, https-proxy-agent, ignore, lodash-es, lru-cache,
marked, React/reconciler/compiler-runtime, shell-quote, strip-ansi, usehooks-ts,
ws and zod. Thus even a Luna-only turn requires these **module-link dependencies**
for this actual graph; that does not authorize their optional network features.
Keep their transitive package/conditional-export files, not only the listed entry.
The existing report records require-resolution; ESM imports can select different
files (for example MCP ESM versus CJS exports). Resolve-only evidence must match
the deployed ESM caller and package conditions before any foreground import.

The four unresolved-require cases are distinct:

- `@alcalzone/ansi-tokenize@0.3.0` exists and exports an `import` condition only:
  `./build/index.js`. This is a require-resolver mismatch, not missing installation.
- `@ant/agenc-for-chrome-mcp` is absent but isolated in dynamic Chrome chunks in
  v2. It is outside the owner entry's static closure; the foreground static
  closure traversal also excludes it. Chrome remains unsupported, not stubbed.
- `@aws-sdk/client-bedrock` is absent and all output references are dynamic.
  `utils/model/modelStrings.ts:120–157` returns on non-Bedrock configuration;
  Bedrock profile discovery needs the missing package. No Luna install needed.
- `source-map-support` is an absent optional TypeScript helper under a caught
  require (`node_modules/typescript/lib/typescript.js:8384`). It is not a required
  foreground package and must not be confused with missing source maps.

Observer/selection modules are still external **absolute Darwin paths**. Their
Python bridge, shared binding, policy/finance/capture imports and selected Python
executable need the future Linux inventory/path selection. The current JS build
does not relocate these or attest a full observer deployment. Similarly, the
ordinary sibling CLI must retain its own exact built entry/dist/native closure;
the companion is not a replacement task client.

## Smallest safe next validation

1. Review a fresh **package-layout** build/staging proposal, not a live selection
   flip. Prefer canonical dist-root chunk placement inside a separately owned
   package tree with the exact selected package manifest/VERSION and explicit
   copied immutable asset hashes. This can be done without modifying immutable
   source, but needs separate authority to create the layout and copy assets.
   Flattening chunk placement to canonical dist-root avoids proliferating extra
   copies of sibling-relative helpers/prompts. Retain ESM splitting and one ALS.
2. Before execution, statically enumerate the foreground and preflight entry
   closures, actual ESM external targets, helper/text/native paths and expected
   Linux native formats. Keep unresolved optional capabilities explicit. No
   source callbacks, feature flags or sandbox checks need to be weakened.
3. Only after a genuine Linux deployment is available and independently pinned,
   root can authorize one no-network canonical startup/readiness/shutdown check
   with owned children, before any provider fixture or measured task. Canonical
   native caches/builds must be prepared or separately authorized, not hidden
   inside this check. Current local disabled-entry smoke is not that gate.

The next two-entry v3 recipe can be drafted independently, but adding a preflight
entry alone will not repair these asset/native/layout gaps. No installation,
Linux availability, runtime closure or paid readiness is inferred here.

## Inspected artifact pins

- build-result.json: `ed7a83caa3a33b024cf6700e4883cfeefd2387f8b47ded1b6b1a88b5c1a80f98`
- metafile.json: `59fae9971874a9b91b56d774ab6b353209a76a4e64aaf9805376d36000f8286d`
- disabled-entry-smoke.json: `09669a29b21b287624856d211078b295701a210fd183162c970253ecf6bdc395`
- owner-companion.mjs: `2d61db9e11d024f0182a42aad935a45ffd5e3abf4ed2792148b5c2b4cea1dfc5`

All relative source references above are inside the exact immutable 403da
`runtime/`, except explicitly named node_modules. This report contains no raw
provider content, credential values or newly executed runtime evidence.
