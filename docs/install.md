# Installing AgenC

**Current release: 0.7.2.** The public one-line installer and npm package use
the same reviewed immutable runtime release.

Three interchangeable install paths share one runtime contract. Each verified
runtime lives at:

```text
$AGENC_HOME/runtime/<version>/<platform>-<arch>-<libc-or-native>-node-abi-<abi>-sha256-<digest>/
```

The full artifact sha256 is part of the immutable cache identity, and the
`.agenc-runtime-ok` marker independently binds that entry to the digest and
executable. The platform, libc family, and Node native ABI stop one host or
Node line from reusing an incompatible runtime installed by another path.

Related: [quickstart](quickstart.md) · [onboarding](onboarding.md) ·
[VPS deploy](deploy/vps.md) · [gateway](gateway.md).

## One-line installer (macOS / Linux)

```bash
curl -fsSL https://get.agenc.ag/install.sh | sh
```

The script (source: `scripts/install/install.sh`):

1. requires a root-owned system `tar` and Node.js `>=25.9 <26` (Node is also
   used for uniform JSON, compatibility, sha256, and archive validation across
   platforms); official macOS installs also require the system `unzip`,
2. fetches the release manifest (`agenc-runtime-manifest-v2.json`) for the latest
   published release, or a pinned one with `--version` (the current release is
   `0.7.2`),
3. selects exactly one platform/architecture/native-ABI entry and rejects an
   incompatible host before downloading the runtime,
4. downloads only the manifest's canonical HTTPS release URL, rejects an
   HTTPS-to-HTTP redirect, enforces one two-minute monotonic deadline across
   redirects, headers, and body, and verifies both byte count and sha256,
5. for an official modern v2 release, downloads the artifact's canonical
   `.sigstore.json` bundle and a fresh digest-pinned GitHub CLI 2.96.0 into the
   private temporary root, then verifies the artifact against the exact hosted
   source workflow, commit, tag, GitHub OIDC issuer, and SLSA provenance-v1
   predicate before extraction; ambient GitHub CLI credentials/config are not
   used, telemetry/update egress is disabled, and standard proxy variables
   remain available; success writes a versioned receipt binding the runtime and
   attestation digests to that source identity and verification policy,
6. validates gzip/tar structure, checksums, entry types, traversal, links,
   duplicates, platform path rules, and resource bounds before extraction,
7. stages under a private temporary root inside `AGENC_HOME`, flushes payload,
   receipt, marker, journal, and directory durability boundaries, then
   atomically promotes the complete runtime under the content-addressed ABI
   path; a SQLite `BEGIN IMMEDIATE` lock makes concurrent local installs safe
   and is released by the OS if an installer exits,
8. installs an `agenc` wrapper to `--prefix`/bin (default `~/.local/bin`) with
   the absolute Node path baked in (user services run with a minimal PATH),
9. installs and starts the daemon as a systemd user service (Linux) or
   launchd agent (macOS). Skip with `--no-daemon`.

Before its first Node subprocess, the standalone installer removes inherited
`NODE_OPTIONS`, `NODE_PATH`, and `NODE_TLS_REJECT_UNAUTHORIZED`; those variables
can preload code, change module resolution, or disable HTTPS certificate
verification. It preserves `NODE_EXTRA_CA_CERTS` and the standard proxy
variables, and enables Node's environment-proxy support so reviewed enterprise
CAs and `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` continue to work. The PowerShell
installer restores the caller process's original Node variables in a `finally`
block, including on failure.

Flags: `--version`, `--manifest-url`, `--repo`, `--prefix`, `--no-daemon`.
Re-running is idempotent: a verified existing install skips the download.
Modern official installs additionally require the matching policy receipt; a
legacy sha256-only cache is re-downloaded and verified rather than grandfathered.
Interrupted promotions recover a verified staged tree or backup before any
artifact download. Per-artifact SQLite lock databases use OS file locking and
remain as durable identities; there is no stale PID lease to reap. Wrapper/shim
activation takes an `AGENC_HOME` transaction lock plus canonical wrapper-path
locks in a private per-user registry and uses a durable roll-forward journal,
so different homes cannot partially repoint the same wrapper. An unpinned
install never replaces a newer active version; `--version` is the explicit
downgrade path.

`AGENC_HOME` must be an absolute path; relative values are rejected before
download, update, or activation. It must be on one local, non-shared filesystem with working SQLite
file locks and atomic same-filesystem rename. Do not place it on NFS, SMB, or a
multi-host container volume. AgenC resolves the owning mount/drive and fails
closed when filesystem locality cannot be established. Wrapper activation is
serialized through an OS-account-owned registry that cannot be split by
changing `HOME`/`XDG_RUNTIME_DIR`/`LOCALAPPDATA`: Linux uses
`~/.local/state/AgenC/activation-locks`, macOS uses
`~/Library/Application Support/AgenC/activation-locks`, and Windows uses the
operating-system account home from `os.userInfo()` with
`.agenc-state/activation-locks`. Windows lock and wrapper paths must be on NTFS;
ReFS and network/unknown volumes are rejected because the required stable
64-bit file identity cannot be established through Node/libuv. Custom prefixes
must resolve to canonical, private directories. A network-backed account-state
directory therefore fails closed instead of falling back to `/tmp` or another
lock identity.

Pin explicitly:

```bash
curl -fsSL https://get.agenc.ag/install.sh | sh -s -- --version 0.7.2
```

## Updating

```bash
agenc update
```

`agenc update` applies the same compatibility, URL, byte-count, sha256,
archive-safety, locking, staging, and atomic-promotion contract. It installs
side by side under the content-addressed ABI runtime path and transactionally repoints all
eligible wrappers generated by `install.sh`. A running daemon keeps the old
version until `agenc daemon restart`. `--check` reports without writing;
`--pin 0.7.2` targets a specific release and is the only update mode allowed to
downgrade the active wrapper.

npm-launcher installs pin their runtime through the manifest bundled into the
launcher package, so they update with `npm install -g @tetsuo-ai/agenc@latest`
instead (`agenc update` detects this and says so). Re-running the install
one-liner also updates in place.

Tests: `runtime/tests/packaging/update-cli.test.ts`.

## One-line installer (Windows)

```powershell
iwr -useb https://get.agenc.ag/install.ps1 | iex
```

Source: `scripts/install/install.ps1`. Same manifest/verify/extract contract;
installs an `agenc.cmd` shim under `%LOCALAPPDATA%\agenc\bin`. Running the
daemon as a Windows service uses WinSW with `packaging/windows/agenc-daemon.xml`
(manual step; `agenc daemon start` works without it).

## Supported hosts

The public runtime matrix is deliberately explicit:

| Host | Architectures | Minimum native contract |
| --- | --- | --- |
| Linux glibc | x64, arm64 | glibc 2.28, GLIBCXX 3.4.25, CXXABI 1.3.11 |
| macOS | x64, arm64 | macOS 13.5 |
| Windows | x64 | Native Windows runtime |

All paths require Node.js 25.9 or newer within the 25.x line and the manifest's
native module ABI and Node-API version. Node 25 is now end-of-life; 0.7.2 is a
narrow compatibility bridge, not permission to substitute a different Node
major into release artifacts. Alpine/musl Linux, Linux armv7, and Windows arm64 are not in
the release matrix; installers fail before the runtime download rather than
attempting a best-effort install. Exact release inputs live in
`release-toolchain.json` (currently Node.js 25.9.0, ABI 141, Node-API 10, and
npm 11.17.0).

The initial official install requires public HTTPS access to the manifest,
selected runtime, its Sigstore bundle, the pinned GitHub CLI archive, and the
current GitHub/Sigstore trusted-root and transparency metadata used by
`gh attestation verify`. The bundle alone is not an offline trust root.
Installed runtime startup does not. `--repo` binds a repo-derived manifest to
that requested repository. `--manifest-url` and local paths deliberately select
an explicit-trust mirror/test mode: byte count, sha256, compatibility, and
archive safety still apply, but official source-workflow provenance does not.

## npm launcher

```bash
npm install -g @tetsuo-ai/agenc
```

The launcher's postinstall resolves the same runtime contract via
`packages/agenc/lib/runtime-manager.mjs`. Prefer a version that resolves
runtime **0.7.2** when you need parity with this doc set.

## Docker

```bash
test -z "$(git status --porcelain=v1 --untracked-files=all)"
commit="$(git rev-parse HEAD)"
epoch="$(git show -s --format=%ct HEAD)"
build_time="$(node -e \
  'process.stdout.write(new Date(Number(process.argv[1])*1000).toISOString())' \
  "$epoch")"
version="$(node -p 'require("./package.json").version')"
git archive --format=tar HEAD | \
  docker buildx build --load -f packaging/docker/Dockerfile -t agenc:local \
  --build-arg AGENC_BUILD_COMMIT="$commit" \
  --build-arg SOURCE_DATE_EPOCH="$epoch" \
  --build-arg AGENC_BUILD_TIME="$build_time" \
  --build-arg AGENC_VERSION="$version" -
docker run -it --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  -v agenc-data:/data -e XAI_API_KEY agenc:local
```

The pipe uses only files tracked by `HEAD`; this is stronger than a clean-status
check because ignored wallet, identity, and npm credential files cannot enter
the build context. For Compose, export the same four metadata values plus
`AGENC_DOCKER_CONTEXT`, pointing at either a checksum-bound Git URL or a
temporary directory populated by `git archive` as shown in the VPS guide.
Compose rejects missing source inputs. The image runs non-root, keeps state in
the `/data` volume, and publishes no ports by default. Its Linux peer-credential
addon is prebuilt and root-owned under `/usr/lib/agenc`; startup fails closed if
that configured addon cannot load, and `/data` can be `noexec` without weakening
socket authentication. VPS deployment shapes:
[docs/deploy/vps.md](deploy/vps.md).

## Homebrew (owner-publish pending)

`packaging/homebrew/agenc.rb` is the tap formula template; it wraps
`install.sh` so every path shares one verified contract. It ships with
placeholder URL/sha and is explicitly disabled. Homebrew/core has no `node@25`
formula, so the tap must not be published until AgenC moves to a supported Node
line and native macOS release gates pass.

## After install

```bash
agenc onboard              # first-run wizard (Act 1)
agenc security audit
agenc doctor
agenc gateway install-service   # optional always-on channels after Act 2
```

Full journey (identity, channels, budgeted autonomy):
[onboarding.md](onboarding.md). Five-minute path: [quickstart.md](quickstart.md).

## Release/publish procedure

Binaries publish to the **public** `tetsuo-ai/agenc-releases` repo. The
`tetsuo-ai/agenc-core` source repository must also remain public: npm trusted
publishing can authenticate a private repository, but npm cannot generate the
required public-package provenance from one, so both release workflows fail
closed if source visibility changes. The installers default to
`releases/latest/download/agenc-runtime-manifest-v2.json` there — a regression
test pins that default.

Release builds require exactly Node.js 25.9.0 and npm 11.17.0 as declared by
`release-toolchain.json` and the root `packageManager`. Start with `npm ci`;
the committed lockfile and reviewed lifecycle-script allowlist are the
dependency authority. Before assembling a release, run
`npm run check:clean-build` from a clean commit. `--skip-docker` is a focused
development option, not release acceptance. The full gate creates two isolated
installs under different umasks and time zones (the second install is offline
against the first run's cache), compares the runtime, launcher, SDK,
declarations, canonical runtime archive, manifest, npm tarballs, and SBOM, then
downloads and verifies exact Buildx 0.35.0, creates a digest-pinned BuildKit
0.31.1 builder, and builds from two more pristine source trees. It recursively
compares every un-attested OCI descriptor and compressed blob, loads that
proven subject, and exercises the daemon under the production hardening profile.

Runtime `.tar.gz` files are byte-reproducible when the source and recorded
native toolchain are held constant: paths, metadata, ordering, ownership,
modes, and gzip timestamps are canonicalized, and every archive has a bound
toolchain/dependency sidecar. Each workflow job builds twice and uploads only
matching bytes. The Linux base image, direct RPM inputs, and complete installed
RPM inventory are pinned or verified; hosted macOS and Windows image identity
is recorded but may evolve between workflow runs, so cross-run byte identity
on those hosts is not claimed. Both Docker base manifests, the Dockerfile
frontend, the Buildx client, and the BuildKit daemon are digest/version pinned.
The OCI exporter fixes compatibility version 30, forces one gzip contract, and
rewrites layer timestamps to `SOURCE_DATE_EPOCH`; matching local Docker image
IDs alone is not reproducibility evidence because they omit compressed blob
identity. Publish-time SBOM/provenance attestations are separately verified
statements over that subject and are not part of the byte-identity claim.
Runtime OS packages come from one signed `snapshot.debian.org` timestamp, each
direct package version is pinned in `release-toolchain.json`, and the complete
resolved package inventory is stored at
`/usr/share/agenc/debian-packages.txt` in the image.

1. Bump and review a version that has never been published, merge that commit
   to `main`, then create its source tag and dispatch
   `.github/workflows/release-runtime.yml` at that exact ref. These guards are
   intentionally safe to rerun: the tested preflight accepts only explicit
   HTTP 404 responses from the public npm registry and GitHub API. Existing
   versions fail, and DNS, TLS, authentication, rate-limit, redirect, and 5xx
   results are inconclusive failures rather than permission to tag.

   ```bash
   git fetch origin main --tags
   test -z "$(git status --porcelain=v1 --untracked-files=all)"
   git merge-base --is-ancestor HEAD origin/main
   version="$(node -p 'require("./package.json").version')"
   tag="agenc-v${version}"
   ! git rev-parse --verify --quiet "refs/tags/$tag"
   npm run release:preflight
   git tag --annotate "$tag" --message "AgenC $version"
   # Complete the exact-tag detached-checkout gates and human review described
   # in docs/ci-required-gates.md before pushing this tag.
   tested_sha="$(git rev-parse "${tag}^{commit}")"
   evidence_path="${AGENC_RELEASE_EVIDENCE_DIR:-$HOME/.agenc/release-evidence}/${tag}-${tested_sha}.json"
   test -f "$evidence_path"
   evidence_sha256="$(sha256sum "$evidence_path" | cut -d ' ' -f 1)"
   [[ "$evidence_sha256" =~ ^[0-9a-f]{64}$ ]]
   git push origin "refs/tags/$tag"
   gh workflow run release-runtime.yml --repo tetsuo-ai/agenc-core \
     --ref "$tag" \
     -f tested_sha="$tested_sha" \
     -f local_evidence_sha256="$evidence_sha256"
   ```

   The source tag remains local until the exact-tag evidence has passed human
   review. The workflow dispatch is invalid if either evidence input is
   omitted.

   Wait for all five jobs (Linux x64/arm64, macOS x64/arm64, Windows x64).
   Publishing stays operator-driven; the workflow has no cross-repository
   publish secret.
2. Download into a fresh temporary directory. `gh run download` creates one
   subdirectory per matrix artifact, and the manifest assembler accepts that
   one-level layout:

   ```bash
   tmp="$(mktemp -d)"
   github_cli=/absolute/path/to/checksum-verified/gh
   "$github_cli" run download <run-id> \
     --dir "$tmp/download" --pattern 'agenc-runtime-*'
   legacy_generate_args=()
   if [ "$version" != "0.7.2" ]; then
     mkdir -m 700 "$tmp/frozen-legacy"
     "$github_cli" release download agenc-v0.7.2 \
       --repo tetsuo-ai/agenc-releases \
       --pattern agenc-runtime-manifest.json \
       --dir "$tmp/frozen-legacy"
     legacy_generate_args=(
       --frozen-legacy "$tmp/frozen-legacy/agenc-runtime-manifest.json"
     )
   fi
   node packages/agenc/scripts/gen-manifest.mjs \
     --artifacts "$tmp/download" \
     --repo tetsuo-ai/agenc-releases --tag "$tag" \
     --legacy-output "$tmp/agenc-runtime-manifest.json" \
     "${legacy_generate_args[@]}"
   npm run sbom -- --output "$tmp/agenc-core.spdx.json"
   node packages/agenc/scripts/prepare-release-assets.mjs \
     --artifacts "$tmp/download" --sbom "$tmp/agenc-core.spdx.json" \
     --github-cli "$github_cli" \
     --legacy-manifest "$tmp/agenc-runtime-manifest.json" \
     --output "$tmp/upload"
   ```

   `github_cli` must be the canonical absolute path extracted from the exact
   platform archive, byte count, and SHA-256 in
   `release-toolchain.json#githubCli`; an ambient `gh` found through `PATH` is
   rejected. Its ordinary GitHub authentication may still authorize reading
   the source repository, but the verifier receives a private config/cache
   home, no ambient GitHub tokens, and a bounded execution deadline.

   The `agenc-v0.7.0` and `agenc-v0.7.1` source tags are already occupied by
   source-only candidates that never produced public runtime artifacts or npm
   packages. Release 0.7.2 therefore deterministically creates the one legacy
   v1 compatibility manifest. After that release is immutable, land a
   separate reviewed PR that changes `release-toolchain.json#legacyBridge`
   from `pending-*` to `pinned`
   and records that asset's exact SHA-256 and byte count. Later releases fetch
   the immutable 0.7.2 asset above, and both manifest generation and asset
   preparation reject it unless it matches those reviewed central pins. A
   later release cannot provide its own replacement digest on the command line.

   Manifest generation fails unless the matrix is exactly complete and every
   sidecar, source/lock/toolchain identity, dependency inventory, byte count,
   digest, entrypoint, and compatibility floor validates. Asset preparation
   rejects nested surprises and filename collisions. Asset preparation also
   downloads and verifies every tarball and sidecar attestation against the
   `tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml` signer, exact
   source commit/tag, and hosted-runner policy. It exports the verified JSONL
   bundles beside the public assets as durable verification inputs, then emits
   `SHA256SUMS`. Current verification is online: a genuinely offline verifier
   must also capture trusted-root material and pass `--custom-trusted-root`, as
   described by GitHub's offline-attestation procedure. The operator's `gh`
   session therefore needs read access to the source repository even though
   the destination assets are public.
3. Create a new draft in `tetsuo-ai/agenc-releases` and upload once. Never use
   `--clobber`; a correction requires a new reviewed build/tag rather than
   silently replacing bytes:

   ```bash
   source_sha="$(git rev-parse "${tag}^{commit}")"
   release_notes="docs/releases/${version}.md"
   test -f "$release_notes"
   release_branch="$(gh api repos/tetsuo-ai/agenc-releases --jq .default_branch)"
   release_head="$(gh api \
     "repos/tetsuo-ai/agenc-releases/git/ref/heads/$release_branch" --jq .object.sha)"
   release_tag_object="$(gh api --method POST \
     repos/tetsuo-ai/agenc-releases/git/tags \
     --raw-field tag="$tag" \
     --raw-field message="AgenC $version artifacts from agenc-core@$source_sha" \
     --raw-field object="$release_head" --raw-field type=commit --jq .sha)"
   gh api --method POST repos/tetsuo-ai/agenc-releases/git/refs \
     --raw-field ref="refs/tags/$tag" \
     --raw-field sha="$release_tag_object"
   gh release create "$tag" --repo tetsuo-ai/agenc-releases \
     --verify-tag --draft --title "AgenC $version" \
     --notes-file "$release_notes"
   gh release upload "$tag" --repo tetsuo-ai/agenc-releases \
     "$tmp/upload"/*
   ```

   If transport failure leaves a partial draft, never add `--clobber`. Resume
   by deleting and recreating only the draft/tag that can be proven to belong
   to this exact source build; any mismatch stops for review:

   ```bash
   draft_json="$(gh release view "$tag" --repo tetsuo-ai/agenc-releases \
     --json tagName,name,isDraft,isPrerelease)"
   DRAFT_JSON="$draft_json" TAG="$tag" VERSION="$version" python3 - <<'PY'
   import json, os
   value = json.loads(os.environ["DRAFT_JSON"])
   assert value == {
       "tagName": os.environ["TAG"],
       "name": f"AgenC {os.environ['VERSION']}",
       "isDraft": True,
       "isPrerelease": False,
   }, "existing release is not this run's unpublished draft"
   PY
   tag_object_sha="$(gh api \
     "repos/tetsuo-ai/agenc-releases/git/ref/tags/$tag" \
     --jq 'select(.object.type == "tag") | .object.sha')"
   test -n "$tag_object_sha"
   annotation_json="$(gh api \
     "repos/tetsuo-ai/agenc-releases/git/tags/$tag_object_sha")"
   ANNOTATION_JSON="$annotation_json" TAG="$tag" SOURCE_SHA="$source_sha" \
     VERSION="$version" python3 - <<'PY'
   import json, os
   value = json.loads(os.environ["ANNOTATION_JSON"])
   assert value.get("tag") == os.environ["TAG"]
   assert value.get("message") == (
       f"AgenC {os.environ['VERSION']} artifacts from "
       f"agenc-core@{os.environ['SOURCE_SHA']}"
   )
   PY
   gh release delete "$tag" --repo tetsuo-ai/agenc-releases \
     --cleanup-tag --yes
   # Re-run the create/upload block above with the unchanged $tmp/upload bytes.
   ```

   Review the draft's manifest and `SHA256SUMS` before publishing it. Release
   immutability must already be enabled for `tetsuo-ai/agenc-releases`; once
   published, GitHub locks the tag and assets and creates a signed release
   attestation. Publish and verify that boundary before any downstream package
   consumes the assets:

   ```bash
   gh release edit "$tag" --repo tetsuo-ai/agenc-releases --draft=false
   gh release verify "$tag" --repo tetsuo-ai/agenc-releases
   ```

   The release must not be marked prerelease: `releases/latest/download/`
   skips prereleases and the default installer URL would stop advancing.
4. npm: dispatch the trusted-publishing workflow at the same immutable source
   tag and approve its `npm-production` environment. The workflow verifies the
   immutable runtime release and its assets, packs in an isolated detached
   worktree, attests the exact tarball and receipt, revalidates both after the
   approval gate, publishes with npm OIDC, and verifies the registry receipt:

   ```bash
   tested_sha="$(git rev-parse "${tag}^{commit}")"
   evidence_path="${AGENC_RELEASE_EVIDENCE_DIR:-$HOME/.agenc/release-evidence}/${tag}-${tested_sha}.json"
   test -f "$evidence_path"
   evidence_sha256="$(sha256sum "$evidence_path" | cut -d ' ' -f 1)"
   [[ "$evidence_sha256" =~ ^[0-9a-f]{64}$ ]]
   gh workflow run publish-npm.yml --repo tetsuo-ai/agenc-core \
     --ref "$tag" \
     -f tested_sha="$tested_sha" \
     -f local_evidence_sha256="$evidence_sha256"
   ```

5. `https://get.agenc.ag/{install.sh,install.ps1,manifest-v2.json,manifest.json}`
   307-redirect to the release assets. The site root serves the versioned
   installer landing page. Vercel project `agenc-get` has its complete tracked
   source in `packaging/get-agenc-ag/` (redeploy: `vercel deploy --prod` from
   that directory).
6. Docker publication is intentionally disabled, remains outside the hosted M0
   quality-gate scope, and stays unauthorized until measured environment drift
   earns that work. Do not publish from an ambient local `docker buildx` invocation: a
   version string does not prove the Buildx binary, and one host architecture
   does not validate both native-addon targets. Any separately approved path
   must reuse the checksum-verified Buildx bytes, prove both native platform
   manifests, attach validated SBOM and provenance whose subjects match those
   manifests, publish the immutable version digest first, smoke the registry
   result, and only then advance `latest` by digest. The local clean-build gate
   proves the current host image only and no GHCR release is authorized.
7. Homebrew tap (`tetsuo-ai/homebrew-agenc`) remains disabled for 0.7.2. Do not
   fill or publish the template merely because darwin tarballs exist: first
   migrate the runtime contract to a supported Node line with a Homebrew
   formula, then rerun native macOS release gates.

For npm artifacts, use the exact launcher workspace and an owned empty output
directory:

```bash
mkdir -m 700 "$tmp/npm-artifacts"
npm run npm:release -- pack --silent \
  --pack-destination "$tmp/npm-artifacts" \
  --workspace=@tetsuo-ai/agenc
```

This creates one exact tarball plus its `.release.json`
byte/identity/source receipt. The launcher has
an explicit leaf-file publish allowlist. Packing freezes the clean tagged Git
tree and every expected payload byte before npm runs its documented `prepack`,
`prepare`, and `postpack` lifecycle; the completed tar is then parsed under
entry/size/type/path bounds and compared byte-for-byte, mode-for-mode, and
path-for-path with that snapshot. Every member must be tracked at the tagged
commit except the single generated v2 runtime-manifest overlay, whose digest is
recorded separately. Lifecycle mutations, symlinks, duplicate or colliding
names, extra members, and attempts to disable scripts or select ambiguous
workspaces fail closed.

`publish` accepts only that explicit `.tgz`, revalidates its receipt, complete
payload, package metadata, embedded five-platform manifest, clean source tag,
lockfile, Node/npm versions, and then uploads an immutable private snapshot
with `--provenance`; workspace/directory publishes and repacks are rejected.
After upload, the wrapper polls npm and fails the release job unless the
registry's SHA-1, SHA-512 integrity, and canonical tarball URL match those
reviewed bytes. The production path is the
`publish-npm.yml` trusted-publishing workflow with the `npm-production`
approval environment. Configure that exact workflow filename and environment
as the npm trusted publisher, permit only `npm publish`, protect the environment
with required reviewers and tag deployment rules, then disable/revoke legacy
write tokens after the first successful OIDC release. No long-lived npm token
is used by the workflow. Do not invoke `npm pack` or `npm publish` directly.

One-time production controls are part of rollout, not optional advice:

```bash
npm trust github @tetsuo-ai/agenc \
  --repo tetsuo-ai/agenc-core \
  --file publish-npm.yml \
  --environment npm-production \
  --allow-publish --yes
```

- Enable immutable releases on `tetsuo-ai/agenc-releases` before creating the
  next draft; existing releases do not become immutable retroactively.
- Protect source tags matching `agenc-v*` and require the tagged commit to be
  merged into `main` (the workflows independently enforce ancestry).
- On `npm-production`, require reviewers, prevent self-review, allow only
  `agenc-v*` tags, and disable administrator bypass.
- After the first successful OIDC publication, set npm to disallow write tokens
  and revoke obsolete automation tokens. Keep recovery credentials offline.

Tests: `runtime/tests/packaging/install-sh.test.ts` exercises fresh and
idempotent installs, compatibility/byte/hash failures, redirect downgrade,
malicious archives, concurrent installers, stale-lock recovery, marker repair,
and systemd generation against synthetic assets. Equivalent launcher,
PowerShell, updater, and shared archive-validator suites guard the other paths.
