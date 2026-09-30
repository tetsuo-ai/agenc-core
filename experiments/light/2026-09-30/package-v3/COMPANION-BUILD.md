# Draft v3 owner/validator + preflight companion build — exact 403da

Not executed. No import smoke, client, provider, native build or installation has
been run by this revision. Root must review it before authorizing a build.
This is a local Darwin source-graph build, **not** the required Linux deployment
or an executable/approved benchmark. All existing selection gates stay false.

## Smallest next step

Root authors and independently accepts a JSON input inventory, outside immutable
Core, with this shape:

```json
{"schemaVersion":1,"productRevision":"403da04398b55e51d1f4e8814f9a70957b0db5ef","files":{"/absolute/canonical/file":"sha256"}}
```

The map must contain the build script itself, every hard-pinned `FIXED` input,
the selected canonical source graph and actual installed dependencies/metadata.
Use the accepted clean-archive provenance to select Core inputs; do not learn
an expected graph from a successful companion run and retroactively authorize it.
The script verifies all listed regular files before build and again afterward;
every metafile input must already be listed. It does not silently add missing
pins. Limit: 16 MiB manifest, 100,000 entries, 256 MiB per regular file, streamed
hashing. Symlinked package aliases must be represented by their canonical file
targets in this map; a full symlink/layout inventory remains a deployment input.

After review, the single proposed build-only command is:

```sh
env -i PATH=/usr/bin:/bin LANG=C TZ=UTC \
  /Users/tetsuoarena/claude-agenc/node/n/versions/node/26.8.1/bin/node \
  /private/tmp/light-takeover/fair-confirmation/current-cli-observer-v1/build-companion.mjs \
  /ABS/ROOT-ACCEPTED-INPUTS.json EXPECTED_MANIFEST_SHA256 /ABS/NEW-OUTPUT-DIRECTORY
```

The parent directory of the new output must exist and be canonical. The output
must not exist and cannot be inside immutable Core or this fair-confirmation
tree. Use a NEW v3 output; `/private/tmp/light-companion-build-v1`,
`/private/tmp/light-companion-build-v2` and the prior
sealed recipe/results remain historical evidence. Failure retains partial output
for diagnosis; there is no overwrite,
automatic retry, cleanup deletion, install or fetch. The builder never imports
the emitted companion. Capture stderr in a private build log: failures include
a static phase, explicit bounded assertion message (no actual/expected values),
and at most eight bounded esbuild messages/source locations (no source snippets
or environment dump). Once its output directory has been created, the same
diagnostic is retained as mode-0600 `build-failure.json`; a failure to write that
record does not hide the original stderr diagnostic. Completion remains scalar.

## Exact graph and preserved semantics

- Runtime source: `/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime`.
  VERSION is 403da, build time `2026-09-30T09:07:17.000Z`, runtime 0.18.0.
  Later public preservation/docs/test-only commits do not repin this artifact.
- Fixed Node 26.8.1 Darwin arm64, esbuild JS/package/native executable, lockfile,
  build config, feature module, tsconfigs, VERSION, owner and validator source
  hashes are embedded in the draft. No ambient loader/NODE_OPTIONS/NODE_PATH or
  build-time override is accepted. Root's manifest also binds this draft itself.
- Reuse canonical `build.config.ts` by the same esbuild TypeScript transform as
  `scripts/build-runtime.mjs`; importing that config only reads its source/config.
  Do **not** invoke the runtime build script: it cleans dist and builds assets.
- Retain canonical feature inlining, bare `src/` resolver, relocated/optional
  resolver, known optional externals, define values, JSX, markdown/text loaders
  and ESM require banner. Only `agenc-runtime-assets` is omitted, because its
  `onEnd` compiles/copies into immutable dist. No platform or sandbox override.
- Two guarded entries: `owner-entry.ts` and root-owned `preflight-entry.ts`,
  split ESM graph with `dist/owner-companion.mjs`, `dist/preflight-companion.mjs`
  and flat `dist/[name]-[hash].mjs` chunks. The exact preflight entry, implementation and
  selection bytes are pinned; no preflight source/selection edits.
  `agenc-selected/*`
  maps to the same selected `runtime/src` used by foreground and Session. Require
  exactly one metafile `src/session/current-session.ts` **and positive emitted
  byte contribution to exactly one output chunk**, plus actual foreground,
  Session and OpenAI adapter modules. No Vitest/test fixtures or fake aliases.
- Verify **both** emitted entries' complete static-import closures contain zero
  positive emitted bytes from canonical `runtime/src/` files. Only wrappers and
  their external selection/helpers may load before their explicit guards.
  This checks emitted bytes, not merely source dynamic-import syntax.
- Verify both emitted static-import closures exclude every
  chunk statically importing absent `@ant/agenc-for-chrome-mcp`. Source-level
  dynamic syntax alone is insufficient: v1 single-bundle flattening hoisted that
  optional external into the entry. V2 uses canonical ESM splitting, no stub,
  feature suppression, new package or rewritten source import. A failed graph
  check blocks successful publication rather than relabeling a required import
  as optional. This static graph check does not authorize activating Chrome.
- `selection.mjs`, `preflight-selection.mjs`, `compatibility-selection.mjs`, `empty-resources.mjs` and the
  shared observer remain external at their pinned **original absolute paths**.
  This preserves their import-meta-relative source/pin lookups; relocation would
  otherwise change behavior. A fresh output-only node_modules symlink points to
  the immutable installed dependency tree for future resolution. It does not
  mutate the target or constitute a portable deployment.
- Output itself is a separately owned runtime package root. Copy **byte-identical**
  pinned `runtime/package.json`, `runtime/dist/VERSION` and the two selected
  `dist/yolo-classifier-prompts/*.txt` assets to matching relative paths. Require
  every copied byte hash in the independently sealed manifest and fixed pins.
  Flat dist-root chunks use canonical sibling-relative prompt paths and the
  canonical package-root resolver; no runtime identity override or environment
  substitution. Record all four copies in `packageAssets`. Do not invoke the
  canonical assets plugin, copy native binaries, compile native helpers or
  write anything into the original runtime tree.

## What the output does and does not prove

Retain `selection.json`, transformed reviewed build config, `metafile.json`,
entry/chunks/source maps and `build-result.json`. The latter records input/output hashes,
canonical plugins/defines, source-graph singleton and resolve-only external entry
results plus `recipeVersion: 3` and `splitGraph` (both entry static closures,
zero eager Core bytes, single ALS
output, optional Chrome chunks). Unresolved require entries are explicit, not substituted. CJS resolution
does not attest ESM conditional exports. `deploymentClosureComplete` and
`executionApproved` remain false even when compilation succeeds.

This is **not** full transitive/runtime closure: native libraries, assets,
nonliteral dynamic loads, ESM resolution, source-location-sensitive runtime paths,
the ordinary sibling CLI and Linux build identity remain separate gates. The
existing 60-file binding map is narrower than this graph and must not be renamed
as a full executable attestation. No callback, preflight or observer is executed.
`owner-entry` does not currently import `fixture-callbacks.ts`; those trusted
callbacks must be wired by a separately reviewed owner caller. Their successful
unit/type gates do not make this a runnable launcher.

Linux use needs a separately reviewed exact input/toolchain/path selection and
Linux-built dependencies/assets; do not change `process.platform` or merely
replace the hardcoded Node path. Retain normal CLI/sandbox/permissions and actual
owned parent shutdown/quiescence. The local recipe deliberately cannot clear
those gates, approve paid activity, or assert performance equivalence.

V3 addresses only the two observed package-identity/prompt-path defects by the
approved exact package/dist-root geometry and four data-file copies. See
`DEPLOYMENT-CLOSURE.md` for the original v2 findings. The result retains explicit
missing Linux native/launcher/memory/ordinary CLI/auth/observer-Python prerequisites;
the node_modules link is marked Darwin/local-only. No feature suppression or
copying Darwin binaries to Linux is permitted. Staged VERSION preserves the
source tuple, not a claim this companion is the original canonical executable;
its distinct output hashes remain necessary.

No test/build command has been executed for this revision. Root review is the next
authority boundary. The benchmark-suite guidance informed the separation of
reproducible build artifacts from runtime and performance claims.
