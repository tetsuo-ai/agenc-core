# Reproducible installs and release inputs

**Decision record:** 2026-07-14
**Scope:** M0 “Make installs and releases reproducible”
**Status:** implementation under local verification; Docker registry publication remains disabled
until the separate hosted PR/release-gates item proves native amd64 and arm64.

## Required properties

A reviewed source commit must be sufficient to reconstruct the dependency
graph, runtime, launcher, SDK, declarations, npm packages, release tarballs,
SBOM, and current-host Docker image without developer-home state. A gate must
reject drift rather than silently repair it. Repeating the build from fresh
trees must give the same dependency inventory and release-facing bytes; Docker
proof compares the complete unattested OCI descriptor/blob graph, not only an
image ID.

The lock used by installers and wrapper activation is part of this contract.
It must survive process death without a stale lease, never block Node's event
loop while another process owns the lock, reject unsafe filesystem aliases,
and apply one deadline to preparation, queuing, SQLite recovery, and every lock
in a set.

## Primary-source research

Research was refreshed on 2026-07-14. The load-bearing sources are:

- npm documents `npm ci` as the frozen, clean-install command: it requires an
  existing lock, removes an existing `node_modules`, and exits when the lock and
  manifest disagree. npm also requires lock-affecting configuration used to
  create the lock to be supplied to `npm ci`.
  [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci),
  [package-lock.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json)
- The reproducible-builds specification defines `SOURCE_DATE_EPOCH` as the
  source-derived timestamp input. GNU tar separately documents deterministic
  member order, ownership, modes, names, and timestamps.
  [SOURCE_DATE_EPOCH](https://reproducible-builds.org/docs/source-date-epoch/),
  [GNU tar reproducibility](https://www.gnu.org/software/tar/manual/html_node/Reproducibility.html)
- BuildKit 0.31.1 documents source-date rewriting, the OCI exporter’s
  `rewrite-timestamp=true`, and `compatibility-version` for stable output.
  Docker documents OCI exporters and recommends native nodes over emulation for
  compilation-heavy multi-platform builds.
  [BuildKit reproducible builds](https://github.com/moby/buildkit/blob/v0.31.1/docs/build-repro.md),
  [OCI/Docker exporters](https://docs.docker.com/build/exporters/oci-docker/),
  [multi-platform strategies](https://docs.docker.com/build/building/multi-platform/)
- OCI content descriptors bind media type, byte size, and digest; therefore a
  matching Docker image ID alone does not prove identical compressed layers or
  the outer image manifest.
  [OCI Image Specification](https://github.com/opencontainers/image-spec/blob/v1.1.1/spec.md)
- Debian snapshot archives provide timestamp-addressed repositories. APT's
  `--error-on=any` turns transient index failures into a failed build instead
  of accepting a partial update.
  [snapshot.debian.org](https://snapshot.debian.org/),
  [apt-get(8)](https://manpages.debian.org/bookworm/apt/apt-get.8.en.html)
- Node's `DatabaseSync` API is synchronous. SQLite's busy handler may sleep,
  extended result codes retain the primary code in the low byte, rollback
  journals recover interrupted transactions, and `synchronous=EXTRA` adds the
  directory-sync durability step for `DELETE` journals.
  [Node `node:sqlite`](https://nodejs.org/api/sqlite.html),
  [busy timeout](https://www.sqlite.org/c3ref/busy_timeout.html),
  [busy handler](https://www.sqlite.org/c3ref/busy_handler.html),
  [result codes](https://www.sqlite.org/rescode.html),
  [locking and hot journals](https://www.sqlite.org/lockingv3.html),
  [PRAGMA reference](https://www.sqlite.org/pragma.html)
- On Windows, an unqualified executable name is subject to process-search
  rules. Security-sensitive validation must use the absolute System32
  PowerShell path, literal paths, SID-based ownership, and decoded ACL rights;
  NTFS can also enable case sensitivity per directory.
  [CreateProcess search rules](https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessa),
  [GetSystemDirectory](https://learn.microsoft.com/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsystemdirectoryw),
  [Win32 device namespaces](https://learn.microsoft.com/windows/win32/fileio/naming-a-file),
  [Get-Acl](https://learn.microsoft.com/powershell/module/microsoft.powershell.security/get-acl),
  [FileSystemRights](https://learn.microsoft.com/dotnet/api/system.security.accesscontrol.filesystemrights),
  [per-directory case sensitivity](https://learn.microsoft.com/windows/wsl/case-sensitivity)
- npm trusted publishing uses short-lived OIDC credentials rather than a
  stored registry write token. GitHub immutable releases prevent asset/tag
  mutation after publication.
  [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/),
  [GitHub immutable releases](https://docs.github.com/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases)
- npm documents that `npm pack` runs `prepack`, `prepare`, and `postpack`, and
  that `--ignore-scripts` suppresses lifecycle scripts. Release evidence must
  therefore bind the complete pre-lifecycle source payload and reject a
  caller-controlled script bypass rather than trusting a tarball digest alone.
  [npm lifecycle order](https://docs.npmjs.com/cli/v11/using-npm/scripts/),
  [`npm pack`](https://docs.npmjs.com/cli/v11/commands/npm-pack/)
- Node documents that `NODE_OPTIONS` changes process startup,
  `NODE_TLS_REJECT_UNAUTHORIZED=0` disables certificate validation,
  `NODE_USE_ENV_PROXY=1` enables the standard proxy variables, and
  `NODE_EXTRA_CA_CERTS` extends trusted CAs. The bootstrap therefore removes
  code/module/TLS-disable controls while retaining reviewed enterprise trust
  and proxy inputs.
  [Node command-line environment](https://nodejs.org/api/cli.html)
- GitHub artifact attestations bind an artifact digest to the workflow identity
  carried by GitHub's OIDC certificate. The pinned `actions/attest` action emits
  a bundle path, and GitHub CLI can verify a local artifact against that bundle
  while enforcing repository, workflow, workflow digest, source digest/ref,
  OIDC issuer, predicate type, and a hosted-runner-only policy.
  [artifact attestations](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds),
  [`actions/attest` contract](https://github.com/actions/attest/blob/a1948c3f048ba23858d222213b7c278aabede763/action.yml),
  [`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify),
  [offline verification requirements](https://docs.github.com/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline)
- `actions/attest` accepts multiple newline-delimited subject paths in one
  attestation, npm exposes mutable distribution tags separately from immutable
  package versions, and GitHub's release-asset API reports server-computed
  SHA-256 digests. The release handoff therefore authenticates each tarball and
  metadata sidecar, checks the exact immutable asset graph, and verifies
  `latest` after publication.
  [`actions/attest` multiple subjects](https://github.com/actions/attest#identify-multiple-subjects),
  [`npm dist-tag`](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag),
  [GitHub release assets](https://docs.github.com/rest/releases/assets)
- GitHub-hosted native runner labels receive weekly mutable images. The exact
  image versions reviewed for this release contract are macOS arm64
  `20260706.0213.1`, macOS x64 `20260629.0276.1`, and Windows x64
  `20260628.181.1`; their release inventories are the primary source for the
  pinned Xcode, SDK, Visual Studio, MSVC, and Windows SDK identities.
  [macOS arm64 image](https://github.com/actions/runner-images/releases/tag/macos-15-arm64%2F20260706.0213),
  [macOS x64 image](https://github.com/actions/runner-images/releases/tag/macos-15%2F20260629.0276),
  [Windows x64 image](https://github.com/actions/runner-images/releases/tag/win25%2F20260628.181)
- Node's release archive identifies 25.9.0 as out of maintenance, and the
  current Homebrew/core Node formula list has no `node@25`. The 0.6.2 release
  therefore treats Node 25.9.0 as an exact compatibility bridge and disables
  Homebrew publication instead of silently selecting another ABI.
  [Node 25.9.0 archive](https://nodejs.org/en/download/archive/v25.9.0),
  [Homebrew Node formula](https://formulae.brew.sh/formula/node)

## Decisions

### One committed dependency contract

The root `package-lock.json`, exact npm version, Node 25.9.0 / ABI 141 / Node-API
10 bridge, base-image
digests, Buildx binary hashes, BuildKit image digest, Debian snapshot, direct
runtime packages, and native release toolchains live in reviewed files. Every
install/release path uses `npm ci`; no gate accepts a regenerated lock.

`.npmrc` records the lock-affecting install settings for normal checkouts. It is
excluded from Docker input and recreated from two reviewed literal settings in
the build stage, so a local registry token can never become a layer.

### Compare outputs, not successful commands

`npm run check:clean-build` checks out Git's committed index into independently
created trees with different umasks/time zones. The second install is offline
against only the first run's ephemeral cache. It compares the installed graph,
runtime/SDK declarations and bundles, runtime tarball and sidecars, all three
npm packages, and the SPDX SBOM.

Archives use sorted paths, normalized uid/gid/user/group/modes, a commit-derived
timestamp, gzip without ambient headers, strict path validation, and
post-extraction identity/permission checks. Manifests bind version, platform,
ABI, source commit, build time, byte size, and SHA-256.

### Docker proof is an OCI proof

The clean gate downloads the exact Buildx binary named in
`release-toolchain.json`, verifies its SHA-256, and runs a digest-pinned BuildKit
daemon. Two no-cache builds start from exact tracked-index snapshots. Each
exports an OCI layout with timestamp rewriting, compatibility version 30,
fixed gzip settings, provenance/SBOM disabled, and one explicit native
platform. The validator walks every descriptor, verifies size/digest/media
type/reachability/platform/config/timestamp/user, then recursively compares all
layout files. A separately loaded image must use the already-proven config
digest and pass SQLite, PTY, daemon, health, SIGTERM, permission, and native
peer-UID smokes.

Local documentation pipes `git archive HEAD` into BuildKit. A clean working
tree is not a sufficient boundary because ignored identity, wallet, or npm
credential files are invisible to `git status`. Compose requires an explicit
tracked snapshot directory or checksum-bound Git context.

The peer-credential addon is compiled with hardened flags in the build stage,
installed root-owned beneath root-owned non-writable ancestors, and required by
a root-owned marker. Runtime state is never loaded as native code, runtime
compiler packages are absent, `/data:noexec` is exercised, and inability to
resolve a peer UID terminates the daemon nonzero.

### SQLite is the crash-releasing lock; SQLite never sleeps on the event loop

PID leases and timestamp lockfiles were rejected because SIGKILL and clock
skew create ambiguous stale-owner recovery. SQLite `BEGIN IMMEDIATE` supplies
an OS-released cross-process writer lock and hot-journal recovery.

`DatabaseSync` is opened with zero timeout. `SQLITE_BUSY` (including extended
codes) closes the connection and retries after bounded full jitter using an
async timer. A versioned `Symbol.for` registry provides FIFO serialization
across duplicate launcher/runtime module instances. Locks are deduplicated and
ordered by filesystem device/inode identity, not lowercased paths. One
monotonic deadline covers path creation, locality/ACL validation, the FIFO,
dynamic import, every retry, initialization, and a multi-lock set.

Lock databases use `DELETE`, `synchronous=EXTRA`, `busy_timeout=0`,
`trusted_schema=OFF`, disabled extension loading, defensive mode, a strict
application ID/schema/singleton/version sentinel, private ownership/modes, and
single-link identity revalidation. Unrelated databases, symlinks, hard links,
network/unknown filesystems, path replacement, and untrusted Windows owner/DACL
mutation rights fail closed. Tests create a real dirty rollback journal, kill
its writer, and verify restored format, removed uncommitted table, and
`integrity_check=ok`.

### Publication separates proof from promotion

Runtime assets are assembled before release and uploaded by immutable artifact
identity. npm pack produces an exact tarball plus receipt; the protected OIDC
publish job revalidates those bytes after approval and verifies the registry
integrity receipt. Existing mutable release state is never silently repaired.

Before npm packing, the downstream job proves that the immutable release API,
canonical `SHA256SUMS`, complete five-platform tar/metadata/attestation matrix,
source-exact installers, SBOM, and locally re-prepared 21-file asset directory
have identical names, sizes, and SHA-256 digests. An incomplete, substituted,
or extra immutable asset therefore blocks launcher promotion. Packing and
verification both run the complete launcher-manifest validator over the exact
source or embedded bytes. Stable publication explicitly selects `latest` and
then independently verifies the registry dist-tag, including idempotent reruns.

The npm launcher payload is a literal leaf-file allowlist. Before npm lifecycle
execution, release tooling requires the exact clean tag/commit/tree and freezes
the complete source-bound payload. It runs lifecycle-enabled `npm pack` only in
an owned private destination, parses every tar member under strict resource and
path bounds, and compares every byte and canonical mode with both the frozen
payload and the unchanged post-lifecycle tree. The generated v2 runtime
manifest is the only untracked overlay and has an independent receipt digest.
Verification and publication reconstruct the same payload from the tagged
checkout, so a self-consistent forged tarball and receipt are insufficient.

Docker publication is deliberately not authorized by this slice. A local
single-architecture proof cannot justify a multi-platform tag, and the
temporary verified Buildx binary cannot validate a later ambient invocation.
The following hosted-gates checkbox must prove native amd64 and arm64, validate
attestation subjects/SBOMs against the proven manifests, push the immutable
version digest first, smoke the registry digest, and only then move `latest`.

### Native builds and downloads carry source provenance

The Linux native build runs in one digest-pinned Rocky Linux image and records
the reviewed signing-key set plus the RPM header and payload digest inventory,
not only package names and versions. Native macOS and Windows jobs fail closed
unless the hosted runner image and compiler/SDK inventory exactly match
`release-toolchain.json`. Updating a moving runner image is therefore a
reviewed source change instead of an invisible release input.

Each runtime tarball and its provenance metadata sidecar are subjects of one
pinned-workflow attestation. Its canonical
`<tarball>.sigstore.json` bundle is byte-counted and hashed into the release
manifest. Official standalone installs and self-updates bootstrap an exact
per-platform GitHub CLI archive by reviewed URL, size, and SHA-256, isolate its
configuration from ambient credentials, then require the attestation to match
the AgenC source repository, exact workflow path and commit, release tag and
commit, GitHub OIDC issuer, SLSA v1 predicate, and a GitHub-hosted runner. This
verification completes before runtime archive parsing or extraction. Custom
HTTPS and local manifests remain explicit operator trust modes; they cannot be
silently reclassified as official. The npm launcher instead consumes the
manifest bundled into its provenance-bearing npm package and still requires
the exact artifact URL, byte count, and SHA-256 from that immutable package.

Standalone bootstraps remove inherited Node code-preload, module-search, and
TLS-disable controls before the first Node child while preserving reviewed CA
and proxy inputs. Temporary parents are canonicalized and validated before
creation; only the retained canonical private leaf is used for verification,
extraction, and cleanup. Archive validators cap compressed and uncompressed
input (512 MiB uncompressed), reject unsupported PAX/sparse semantics, expand
the complete symlink graph under a cycle/depth bound, and reject any composed
escape before extraction. Windows system tools use absolute native-system
device paths rather than ambient `PATH`, `SystemRoot`, or WOW64-relative lookup.
The npm launcher likewise stages downloads beneath its canonical private
runtime directory, preserves archive identity across hashing, validation, and
extraction, and invokes only a root-owned absolute system tar under a scrubbed
environment and finite deadline.

## Alternatives rejected

- `npm install`, floating semver/tool/action/image tags, and hidden global npm
  config: convenient, but they mutate the dependency/toolchain contract.
- Comparing only file lists, an image ID, or a successful build: none binds all
  release bytes.
- Building from `.` after `git status` or a permissive `.dockerignore`: ignored
  secrets can still enter `COPY`.
- SQLite `busy_timeout`: it sleeps inside synchronous SQLite and can deadlock a
  timer that would release an in-process holder.
- WAL for the lock database: unnecessary sidecars and weaker fit for a single
  durable writer sentinel; `DELETE` gives deterministic hot-journal recovery.
- Lowercasing Windows paths: NTFS directory case-sensitivity makes text folding
  an invalid identity. Device/inode identity is authoritative.
- Runtime compilation/caching of the peer addon: it creates persistent native
  code writable by the daemon UID and requires a compiler in production.
- A floating hosted-runner toolchain, package-name-only native inventory,
  ambient `gh`, or a release-repository checksum alone: each leaves a mutable
  input outside review or proves bytes without proving the source workflow that
  produced them.
- Publishing version and `latest` together from a workstation: it conflates
  proof, immutable publication, smoke verification, and mutable promotion.

## Rollback and residual limits

The lock database format remains version 1 and is forward-validated; rollback
does not require deleting it. A failed build/publish never mutates a successful
artifact. npm/GitHub publication is immutable, so recovery uses the next patch
version rather than overwriting released bytes.

The current Docker acceptance proof is intentionally native-host only. It does
not claim arm64 from an amd64 host or authorize GHCR. Windows ACL and native
architecture behavior must run on their real hosted platforms in the next M0
gate. `socket._handle.fd` is a Node implementation detail, so the real
`verifiedBy=peerUid` smoke is mandatory on every supported Node/platform
release job. Node 25 is end-of-life and unavailable as a versioned Homebrew
formula, so the Homebrew template stays disabled and a separately reviewed
Node 26 migration is required after this compatibility bridge.

Official artifact attestations authenticate build origin, but the current
online verifier still obtains current GitHub/Sigstore trusted-root and
transparency metadata. AgenC does not yet ship a reviewed custom trusted-root
snapshot or a TUF-style signed root/expiry/threshold/rollback/freeze contract
for its release manifest; a bundle by itself is not offline verification.
[The Update Framework specification](https://theupdateframework.github.io/specification/)
defines those freshness and rollback protections. The
Windows timeout fallback confirms `taskkill /T` completion but is not a native
Job Object containment boundary. Archive inflation is capped at 512 MiB, yet
the trusted synchronous validator can still occupy the event loop while it
processes that bound. These are explicit hardening follow-ups, not claims made
by this reproducibility slice.
The opt-in legacy-v1 path retained for already-published compatibility clients
authenticates its canonical HTTPS location and strict schema but is not a new
cryptographic trust root; new v2 installers use the source-attestation path.
