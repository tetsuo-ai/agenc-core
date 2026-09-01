# Installing AgenC

**Current version in tree: 0.17.0.** The standalone installer, npm launcher,
updater, and Homebrew template share the same reviewed immutable runtime
contract.

User install is this page through **After install**. **Release/publish
procedure** further down is maintainer-only (the agenc-release skill still
points here).

Install paths that actually work for users: Unix curl, Windows iwr, npm, and
a local Docker build. The in-tree Homebrew formula is an unpublished template.
There is no authorized GHCR image.

Each verified runtime lives at:

```text
$AGENC_HOME/runtime/<version>/<platform>-<arch>-<libc-or-native>-node-abi-<abi>-sha256-<digest>/
```

The full artifact sha256 is part of the immutable cache identity, and the
`.agenc-runtime-ok` marker independently binds that entry to the digest and
executable. The platform, libc family, and Node native ABI stop one artifact or
runtime line from reusing an incompatible install created by another path.

Related: [quickstart](quickstart.md) · [onboarding](onboarding.md) ·
[VPS deploy](deploy/vps.md) · [gateway](gateway.md).

## One-line installer (macOS / Linux)

```bash
curl -fsSL https://get.agenc.ag/install.sh | sh
```

The script (source: `scripts/install/install.sh`):

1. requires trusted operating-system download, SHA-256, and archive tools. It
   uses a compatible host Node 26 when present; otherwise it downloads and
   verifies the exact Node 26.5.0 distribution into a private temporary
   directory. Linux also bootstraps the exact reviewed `libatomic.so.1`
   compatibility payload needed to start that portable Node. No host Node
   installation is required; official macOS installs also require the system
   `unzip`,
2. fetches the release manifest (`agenc-runtime-manifest-v2.json`) for the latest
   published release, or a pinned one with `--version` (this tree targets
   `0.17.0`),
3. selects exactly one platform/architecture entry and enforces its operating
   system compatibility floors before downloading; the host Node version and
   native ABI never control modern artifact selection,
4. downloads only the manifest's canonical HTTPS release URL, rejects an
   HTTPS-to-HTTP redirect, enforces one monotonic deadline across redirects,
   headers, and body (two minutes for undeclared sizes; sized artifacts scale
   with the declared byte count), aborts a 60s stall, and verifies both byte
   count and sha256,
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
8. installs an `agenc` wrapper to `--prefix`/bin (default `~/.local/bin`) that
   points at the artifact's private Node executable and, on Linux, its private
   compatibility-library directory (user services run with a minimal PATH),
9. installs and starts the daemon as a systemd user service (Linux) or
   launchd agent (macOS). Skip with `--no-daemon`.

Before its first Node subprocess, the standalone installer removes inherited
`NODE_OPTIONS`, `NODE_PATH`, and `NODE_TLS_REJECT_UNAUTHORIZED`; those variables
can preload code, change module resolution, or disable HTTPS certificate
verification. It preserves `NODE_EXTRA_CA_CERTS` and the standard proxy
variables, and enables Node's environment-proxy support after the private
bootstrap has been verified, so reviewed enterprise CAs and
`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` continue to work. The PowerShell installer
restores the caller process's original Node variables in a `finally` block,
including on failure.

Flags: `--version`, `--manifest-url`, `--repo`, `--prefix`, `--no-daemon`.
Re-running is idempotent: a verified existing install skips the download.

### Download deadlines

The Node `fetch_to` helper in `scripts/install/install.sh` and
`scripts/install/install.ps1` owns every post-bootstrap HTTPS fetch (manifest,
runtime artifact, Sigstore bundle, GitHub CLI archive). A fixed two-minute
ceiling made any link under about 1 MiB/s unable to finish a ~120 MiB runtime.

| Input | Deadline |
| --- | --- |
| Undeclared size (manifests, some bundles) | 120s |
| Declared `exact` byte count | `max(120s, ceil(exact / 128 KiB/s) + 30s)` |
| Official runtime artifact ceiling (`MAX_ARTIFACT_BYTES` = 256 MiB) | about 34 minutes at the 128 KiB/s floor |
| Stall (no delivered bytes) | 60s abort, independent of the total budget |

The Windows Node bootstrap uses the same sized formula against the pinned
Node distro byte count. Unix Node bootstrap still uses the trusted OS `curl`
before `fetch_to` exists. Test-only `AGENC_INSTALL_TEST_*` overrides may
shorten a deadline; they cannot extend it. A byzantine server stays bounded
by the declared size at that minimum sustained rate.

`download deadline exceeded after …ms` is a slow or stalled link, not a
corrupt artifact. Retry; a hash mismatch is a different failure.

Modern official installs additionally require the matching policy receipt; a
legacy sha256-only cache is re-downloaded and verified rather than grandfathered.
Supported standalone pins are the frozen `0.7.2` bridge, which requires host
Node 25.9, or private-Node releases `0.11.2` and newer. Releases `0.8.0` through
`0.11.1` use an unavailable or retired artifact contract and are rejected with an
actionable compatibility error.

The `agenc-v0.11.0` and `agenc-v0.11.1` source tags did not publish runtime
artifacts. The first stopped at the hosted Rocky signed-package inventory gate;
the second passed that gate but stopped when the Rocky-generated compatibility
bootstrap archives did not match identities prepared with a different tar
build. Neither tag was moved; `0.11.2` is the private-Node bootstrap anchor.
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
curl -fsSL https://get.agenc.ag/install.sh | sh -s -- --version 0.17.0
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
`--pin 0.17.0` targets a specific private-Node release and is the only update
mode allowed to downgrade the active wrapper. The in-runtime updater accepts
`0.11.2` and newer; use the standalone installer, not `agenc update`, for the
frozen host-Node `0.7.2` bridge.

npm-launcher installs pin their runtime through the manifest bundled into the
launcher package, so they update with `npm install -g @tetsuo-ai/agenc@latest`
instead (`agenc update` detects this and says so). Re-running the install
one-liner also updates in place.

The 0.10.0 standalone updater runs on Node 25 / ABI 141 and cannot select the
new ABI 147 artifact. Upgrade an existing standalone 0.10.0 installation by
rerunning the one-line installer once. The resulting private-Node wrapper and
future updates use the artifact's private Node runtime.

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

Standalone and Homebrew installations include the exact reviewed Node.js
26.5.0 runtime, module ABI 147, and Node-API 10; they do not require host Node.
Source checkouts, the npm launcher, and the SDK require Node.js `>=26.5 <27`.
Node 26 is Current through 2026-10-28 and is scheduled to enter Active LTS on
that date. Release artifacts remain pinned to one exact toolchain even though
source/npm engine ranges permit compatible 26.x updates. Substituting another
Node major into release artifacts is unsupported. Alpine/musl Linux, Linux
armv7, and Windows arm64 are not in the release matrix; installers fail before
the runtime download rather than attempting a best-effort install. Exact
release inputs live in `release-toolchain.json` (currently Node.js 26.5.0, ABI
147, Node-API 10, and npm 11.17.0).

Lifecycle sources: [Node.js releases](https://nodejs.org/en/about/previous-releases)
and the [Node.js Release Working Group schedule](https://github.com/nodejs/Release#release-schedule).

The initial official standalone install requires public HTTPS access to the
exact Node distribution, the Linux compatibility bootstrap when applicable,
the manifest, selected runtime, its Sigstore bundle, the pinned GitHub CLI
archive, and the current GitHub/Sigstore trusted-root and transparency metadata
used by `gh attestation verify`. The bundle alone is not an offline trust root.
Installed runtime startup does not require that network access. `--repo` binds
a repo-derived manifest to that requested repository. `--manifest-url` and
local paths deliberately select an explicit-trust mirror/test mode: byte
count, sha256, compatibility, and archive safety still apply, but official
source-workflow provenance does not.

### Ubuntu AppArmor and bubblewrap

Ubuntu 24.04 and newer can restrict unprivileged user namespaces through
AppArmor even when `kernel.unprivileged_userns_clone=1`. When `agenc doctor`
reports `bubblewrap` failing with `Failed RTM_NEWADDR: Operation not permitted`,
install the generated per-command profile:

```bash
agenc doctor --apparmor-profile |
  sudo tee /etc/apparmor.d/agenc-native-userns >/dev/null
sudo apparmor_parser -r /etc/apparmor.d/agenc-native-userns
agenc doctor
```

The first command only prints the profile and works after Doctor proves the
standalone wrapper launches the exact active runtime. The profile attaches to
that wrapper and grants the `userns` feature required by bubblewrap; it does
not disable AppArmor or the system-wide user-namespace restriction. If AgenC
is later removed, unload and delete the profile:

```bash
sudo apparmor_parser -R /etc/apparmor.d/agenc-native-userns
sudo rm /etc/apparmor.d/agenc-native-userns
```

Until the profile is installed, AgenC runs on its Landlock fallback. Landlock
is a pure allow-list: it cannot grant write access to a project while keeping
`.git`, `.agenc`, and `.agents` read-only inside it, so sandboxed spawns that
need a writable project root (shell in git projects, most stdio MCP servers)
are refused with a `[sandbox_policy_unexpressible]` error naming the path.
There is no safe partial waiver for this: any flag that made those paths
writable would let a confined process install git hooks that execute outside
the sandbox. The supported options are installing the AppArmor profile above
(restores full bubblewrap confinement), `sandbox_mode = "read-only"`, or the
explicit `danger-full-access` posture. Plugin-declared MCP servers are exempt:
they run under a tighter profile confined to their plugin data directory,
which the Landlock fallback can express. `Grep`, `Glob`, and `Orient` are also
exempt: they spawn a narrowed read-only ripgrep child (`cwdBinding:
"inherited_readonly"`) with write and network grants stripped, so Landlock can
express that profile even when the session itself is workspace-write. The
fallback never grants `/proc` or `/sys`, including under full-disk-read;
`/proc`-dependent commands fail with `EACCES` rather than seeing the daemon's
environment. `[sandbox].writable_roots` extends the workspace-write allowlist,
but it cannot weaken protected `.git`, `.agenc`, or agent-control paths and
therefore does not bypass this fallback limitation. Details:
[tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md#search-execution-and-limits).

## npm launcher

```bash
npm install -g @tetsuo-ai/agenc
```

The launcher's postinstall resolves the same runtime contract via
`packages/agenc/lib/runtime-manager.mjs`. Prefer a version that resolves
runtime **0.17.0** when you need parity with this doc set. npm itself still
requires a compatible host Node; use the standalone installer or Homebrew
formula when you want a self-contained installation.

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
socket authentication. No GHCR image is authorized. Build locally as above.
VPS deployment shapes: [docs/deploy/vps.md](deploy/vps.md).

## Homebrew

```bash
# Not a live public tap yet. The in-tree formula still has
# REPLACE_WITH_DARWIN_* digest placeholders.
brew install tetsuo-ai/agenc/agenc
```

When an owner publishes the tap, the formula installs the architecture-specific
macOS runtime artifact and its bundled Node 26.5.0. Homebrew upgrades AgenC
and that Node together with `brew upgrade agenc`; `agenc update` is not the
update path for formula installs.

Until those placeholder digests are replaced after both native macOS release
gates pass, use the Unix installer or npm instead.

## After install

```bash
agenc onboard              # first-run wizard (Act 1)
agenc security audit
agenc doctor
agenc gateway install-service   # optional always-on channels after Act 2
```

Full journey (identity, channels, budgeted autonomy):
[onboarding.md](onboarding.md). Five-minute path: [quickstart.md](quickstart.md).

On Linux, a userland install puts `agenc-linux-sandbox` under
`$AGENC_HOME/runtime/…`. A bare `agenc` in a fresh terminal opens `$HOME` as
the workspace, so the helper sits inside the writable tree and startup fails
closed (`[sandbox_required_unavailable]`). That refusal is correct: a jailed
process that can rewrite its jailer is not jailed. The remediation names the
home workspace and tells you to open a project directory — do not reinstall
the helper. See
[tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md).

## Release/publish procedure

Releases are exact-SHA and resumable. The private state record under
`${AGENC_RELEASE_STATE_DIR:-$HOME/.local/state/agenc-release}` is the execution
ledger; public services remain the source of truth and are read back before a
checkpoint is trusted. Never restart a completed gate merely because a process
or agent session ended.

There are two authorized lanes:

- `full` publishes a new SemVer through native runtimes, the immutable GitHub
  release, the stable installer channel, get.agenc.ag, Homebrew, and npm.
- `installer-hotfix` promotes reviewed `install.sh`/`install.ps1` bytes without
  changing the product version or rebuilding unchanged runtimes and npm.

### Full release

1. Prepare the version, landing copy, release notes, and source changes on a
   branch. Run the fast PR checks and any targeted release-package tests,
   commit with hooks enabled, create the PR, and squash-merge it. Do **not** run
   the full clean-build acceptance before the final merge commit exists.
2. Fetch `origin/main`, switch to its clean exact commit, and run the complete
   verification plan once:

   ```bash
   version="$(node -p 'require("./package.json").version')"
   npm run release:verify -- --lane full --version "$version"
   ```

   The command writes one private state directory for the exact SHA and holds
   an exclusive operation lock so duplicate invocations cannot run gates in
   parallel. It runs preflight, discovers every current stable or rolling
   hosted-runner image, and verifies its exact-commit inventory online (byte
   count, SHA-256, image version, and parsed toolchain facts). It then runs
   installer synchronization, typecheck, the full test suite, runtime startup
   smokes, and `check:clean-build` once. Each passing gate is recorded
   atomically with its retained log digest. Repeating the command resumes at
   the first missing, failed, or tampered gate.
3. Before creating an immutable source tag, reproduce both Linux compatibility
   bootstraps on their native pinned Rocky runners, then run the complete
   five-target release workflow in untagged candidate mode:

   ```bash
   tested_sha="$(git rev-parse HEAD)"
   evidence_sha256="<release:verify evidenceSha256>"
   gh workflow run verify-node-bootstrap.yml --repo tetsuo-ai/agenc-core \
     --ref main \
     -f tested_sha="$tested_sha" \
     -f local_evidence_sha256="$evidence_sha256"
   gh workflow run release-runtime.yml --repo tetsuo-ai/agenc-core \
     --ref main \
     -f phase=candidate \
     -f candidate_run_id=0 \
     -f tested_sha="$tested_sha" \
     -f local_evidence_sha256="$evidence_sha256"
   ```

   Require both `rocky-bootstrap` matrix jobs and all ten successful candidate
   workflow jobs (source, three hosted-toolchain preflights, five native
   targets, and `candidate-seal`), with all six unexpired artifacts: five
   runtime artifacts plus the attested candidate seal. The three hosted
   preflights validate macOS arm64, macOS x64, and Windows x64, and every
   artifact builder waits on the complete matrix as a single barrier.
   Candidate mode is the only phase that runs the reproducible Linux, Darwin,
   and Windows builders and native probes; it refuses to run if the version tag
   already exists. Download and verify the workflow-generated seal with the
   checksum-pinned GitHub CLI, then checkpoint its receipt before any tag is
   created:

   ```bash
   candidate_run_id="<successful candidate workflow run ID>"
   candidate_seal_dir="$(mktemp -d)"
   github_cli=/absolute/path/to/checksum-verified/gh
   "$github_cli" run download "$candidate_run_id" \
     --repo tetsuo-ai/agenc-core \
     --name agenc-runtime-candidate-seal \
     --dir "$candidate_seal_dir"
   candidate_receipt="$candidate_seal_dir/agenc-runtime-candidate-seal.json"
   "$github_cli" attestation verify "$candidate_receipt" \
     --bundle "${candidate_receipt}.sigstore.json" \
     --repo tetsuo-ai/agenc-core \
     --signer-workflow \
       tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml \
     --signer-digest "$tested_sha" \
     --source-digest "$tested_sha" \
     --source-ref refs/heads/main \
     --hostname github.com \
     --cert-oidc-issuer https://token.actions.githubusercontent.com \
     --predicate-type https://slsa.dev/provenance/v1 \
     --deny-self-hosted-runners
   npm run release:checkpoint -- \
     --lane full --version "$version" --sha "$tested_sha" \
     --step candidate-build-complete \
     --receipt-file "$candidate_receipt" \
     --receipt-bundle "${candidate_receipt}.sigstore.json" \
     --github-cli "$github_cli"
   ```

   `github_cli` must be the canonical absolute path extracted from the exact
   archive pinned under `release-toolchain.json#githubCli`. The checkpoint also
   matches the executable itself to that host pin's reviewed
   `executableBytes` and `executableSha256` before and after verification and
   records that identity; a version-compatible substitute is rejected. The
   later detailed procedure describes that verifier boundary. Candidate
   artifacts are created only by attempt 1 (`run_attempt=1`): every
   artifact-producing candidate job
   rejects a direct or whole-workflow retry before checkout, build, attestation,
   or upload. If any candidate job fails, dispatch a fresh candidate workflow.
   Until immutable escrow publication finishes, a later “re-run all jobs” can
   delete the successful attempt's Actions staging artifacts. Only an escrowed
   candidate is retry-independent: tagged promotion validates attempt 1
   through GitHub's attempt-specific jobs API, requires the top-level run to
   remain a completed attempt-one success, and authenticates the escrowed
   signed seal, native bundles, and exact byte identities. A candidate
   failure remains recoverable through an ordinary PR because no source tag
   exists.

   The candidate checkpoint receipt is schema version 1 and must contain the
   canonical workflow name, `phase=candidate`, run ID/attempt/URL, tested SHA,
   evidence digest, the exact ten successful job names, and all five runtime
   artifact records. Each artifact record binds the canonical archive filename
   plus the byte count and SHA-256 of the archive, metadata, and build Sigstore
   bundle downloaded from that run. `release:checkpoint` privately copies and
   authenticates the receipt with the checksum-pinned GitHub CLI before parsing
   it, and rejects an incomplete or differently bound candidate receipt.

   Before creating the source tag, copy all 17 sealed candidate files into a
   permanent immutable prerelease escrow in `tetsuo-ai/agenc-releases`. The
   escrow tag is always derived from the reviewed version and run ID; it is
   never an operator input. Actions artifacts remain convenient staging
   transport only because a later “re-run all jobs” can delete the original
   run artifacts:

   ```bash
   [[ "$candidate_run_id" =~ ^[1-9][0-9]*$ ]]
   candidate_tag="agenc-candidate-v${version}-run-${candidate_run_id}"
   candidate_assets="$(mktemp -d)"
   "$github_cli" run download "$candidate_run_id" \
     --repo tetsuo-ai/agenc-core \
     --pattern 'agenc-runtime-*' \
     --dir "$candidate_assets"
   test "$(find "$candidate_assets" -mindepth 2 -maxdepth 2 -type f \
     -printf x | wc -c)" -eq 17
   verification_args=(
     --repo tetsuo-ai/agenc-core
     --signer-workflow \
       tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml
     --signer-digest "$tested_sha"
     --source-digest "$tested_sha"
     --source-ref refs/heads/main
     --hostname github.com
     --cert-oidc-issuer https://token.actions.githubusercontent.com
     --predicate-type https://slsa.dev/provenance/v1
     --deny-self-hosted-runners
   )
   candidate_receipt="$candidate_assets/agenc-runtime-candidate-seal/agenc-runtime-candidate-seal.json"
   candidate_seal_bundle="${candidate_receipt}.sigstore.json"
   "$github_cli" attestation verify "$candidate_receipt" \
     --bundle "$candidate_seal_bundle" "${verification_args[@]}"
   for slug in linux-x64 linux-arm64 darwin-x64 darwin-arm64 win-x64; do
     archive="$candidate_assets/agenc-runtime-$slug/agenc-runtime-${version}-${slug}-node26-abi147.tar.gz"
     metadata="${archive}.meta.json"
     candidate_bundle="${archive}.sigstore.json"
     "$github_cli" attestation verify "$archive" \
       --bundle "$candidate_bundle" "${verification_args[@]}"
     "$github_cli" attestation verify "$metadata" \
       --bundle "$candidate_bundle" "${verification_args[@]}"
     python3 scripts/release_candidate_policy.py promote \
       --repository tetsuo-ai/agenc-core \
       --run-id "$candidate_run_id" --run-attempt 1 \
       --tested-sha "$tested_sha" --evidence-sha256 "$evidence_sha256" \
       --version "$version" --slug "$slug" \
       --receipt "$candidate_receipt" \
       --seal-bundle "$candidate_seal_bundle" \
       --artifact "$archive" --metadata "$metadata" \
       --candidate-bundle "$candidate_bundle"
   done
   release_branch="$(gh api repos/tetsuo-ai/agenc-releases --jq .default_branch)"
   release_head="$(gh api \
     "repos/tetsuo-ai/agenc-releases/git/ref/heads/$release_branch" \
     --jq .object.sha)"
   candidate_tag_object="$(gh api --method POST \
     repos/tetsuo-ai/agenc-releases/git/tags \
     --raw-field tag="$candidate_tag" \
     --raw-field message="AgenC $version candidate run $candidate_run_id" \
     --raw-field object="$release_head" --raw-field type=commit --jq .sha)"
   gh api --method POST repos/tetsuo-ai/agenc-releases/git/refs \
     --raw-field ref="refs/tags/$candidate_tag" \
     --raw-field sha="$candidate_tag_object"
   gh release create "$candidate_tag" --repo tetsuo-ai/agenc-releases \
     --verify-tag --draft --prerelease \
     --title "AgenC $version candidate run $candidate_run_id" \
     --notes "Permanent candidate escrow for agenc-core run $candidate_run_id."
   gh release upload "$candidate_tag" --repo tetsuo-ai/agenc-releases \
     "$candidate_assets"/agenc-runtime-*/*
   gh release edit "$candidate_tag" --repo tetsuo-ai/agenc-releases \
     --draft=false --prerelease
   gh release verify "$candidate_tag" --repo tetsuo-ai/agenc-releases
   GH_TOKEN="$("$github_cli" auth token --hostname github.com)" \
     npm run release:checkpoint -- \
       --lane full --version "$version" --sha "$tested_sha" \
       --step candidate-escrow-published \
       --github-cli "$github_cli"
   ```

   The checkpoint invokes the checksum-pinned CLI itself, verifies GitHub's
   immutable-release attestation, requests the release API contract version
   that exposes asset digests, and matches the exact 17 public asset names,
   byte counts, and SHA-256 values to the already-authenticated candidate seal.
   It requires `immutable=true`, `draft=false`, and `prerelease=true`. Keep this
   escrow permanently; do not delete it after the final release.
4. Only after `candidate-escrow-published` is recorded, use the command's
   `evidenceSha256` and exact `sha` to create and dispatch the source tag:

   ```bash
   tag="agenc-v${version}"
   tested_sha="$(git rev-parse HEAD)"
   evidence_sha256="<release:verify evidenceSha256>"
   git fetch origin main --tags
   test "$(git rev-parse refs/remotes/origin/main)" = "$tested_sha"
   ! git show-ref --verify --quiet "refs/tags/$tag"
   git tag --annotate --message "AgenC $version" "$tag" "$tested_sha"
   test "$(git rev-parse "${tag}^{commit}")" = "$tested_sha"
   git push origin "refs/tags/$tag"
   gh workflow run release-runtime.yml --repo tetsuo-ai/agenc-core \
     --ref "$tag" \
     -f phase=tagged \
     -f candidate_run_id="$candidate_run_id" \
     -f tested_sha="$tested_sha" \
     -f local_evidence_sha256="$evidence_sha256"
   promotion_run_id="<tagged promotion workflow run ID>"
   npm run release:checkpoint -- \
     --lane full --version "$version" --sha "$tested_sha" \
     --step source-tag-pushed \
     --receipt-json \
       "{\"tag\":\"$tag\",\"sha\":\"$tested_sha\",\"promotionRunId\":$promotion_run_id}"
   ```

   Tagged mode verifies the candidate run metadata, then reads the five runtime
   artifacts and attested seal exclusively from the derived immutable escrow
   prerelease. Actions run artifacts are non-authoritative at this point. It
   preserves each authenticated branch-ref bundle
   as `<archive>.build.sigstore.json` and emits a distinct
   `<archive>.sigstore.json` tag-ref attestation over the same archive and
   metadata bytes. It does not rebuild on mutable native runners after the tag
   exists. Do not repeat the verifier from a detached tag: the tag points to
   the already-proven commit.
5. Wait for all five tagged promotion targets, assemble and verify the
   manifests/SBOM/attestations with `prepare-release-assets.mjs`, and stage one
   matching cross-repository draft without clobber. Record
   `runtime-build-complete` against `promotion_run_id`, then
   `release-draft-staged` with the distinct destination draft URL.
6. Publish and verify the immutable non-prerelease GitHub release, then run
   `scripts/validate-runtime-release-inventory.py` against that immutable
   release and its downloaded assets. The validator deliberately rejects a
   draft. Then promote
   the same SHA through the stable installer channel. Record
   `github-published` before dispatching the installer workflow and
   `installer-promoted` only after its branch and public-byte readback passes:

   ```bash
   gh workflow run promote-installers.yml --repo tetsuo-ai/agenc-core \
     --ref "$tag" \
     -f lane=full \
     -f tested_sha="$tested_sha" \
     -f local_evidence_sha256="$evidence_sha256"
   ```

   `promote-installers.yml` advances the dedicated `installer-stable`
   promotion branch only by fast-forward and verifies the public installer
   bytes. Versioned GitHub releases still retain immutable installer
   snapshots.
7. Deploy `packaging/get-agenc-ag/` to Vercel production only when its tracked
   route or landing source differs from production. Otherwise record a checked
   skip. Record `vercel-deployed` in either case. The manifest routes remain
   redirects to GitHub latest; the installer routes point to
   `installer-stable`.
8. Populate the private-Node formula in `tetsuo-ai/homebrew-agenc` from the
   immutable Darwin artifact URLs and SHA-256 values. Land it through a PR only
   after both hosted Intel and Apple Silicon test-bot jobs pass, verify a clean
   tap install, and record `homebrew-published`.
9. Dispatch npm trusted publishing at the identical tag and evidence identity:

   ```bash
   gh workflow run publish-npm.yml --repo tetsuo-ai/agenc-core \
     --ref "$tag" \
     -f tested_sha="$tested_sha" \
     -f local_evidence_sha256="$evidence_sha256"
   ```

   The `npm-production` environment remains the OIDC publication boundary.
   Record `npm-published` only after registry integrity and provenance readback.
10. Run isolated installer-managed, Homebrew, and npm-managed install/update
    smokes, then audit public convergence. Record `converged` only when source
    tag, all five native artifacts, manifests, GitHub latest, installer
    promotion, get.agenc.ag, the Homebrew tap, npm latest, and the landing agree.

Query or resume the exact state at any time:

```bash
npm run release:status -- --lane full --version "$version"
```

Checkpoints are ordered and idempotent. Re-recording an identical receipt is a
no-op; a conflicting receipt stops rather than replacing history. Recording
`converged` deterministically gzip-compacts the retained gate logs while
preserving their original hashes and archive receipts, so completed releases
do not accumulate large plaintext logs.

### Installer-only hotfix

The installer hotfix lane exists for failures in the stable bootstrap scripts
that do not require new runtime or launcher bytes.

1. Land the installer fix and revert-sensitive regression tests through the
   normal branch/PR/squash-merge flow without changing package versions.
2. At clean exact `origin/main`, run:

   ```bash
   npm run release:verify -- --lane installer-hotfix
   ```

   This targeted plan checks embedded lock synchronization, shell syntax, the
   standalone installer suite, and launcher tests. It does not run
   `check:clean-build`.
3. Dispatch the promotion at exact main:

   ```bash
   tested_sha="$(git rev-parse HEAD)"
   evidence_sha256="<release:verify evidenceSha256>"
   gh workflow run promote-installers.yml --repo tetsuo-ai/agenc-core \
     --ref main \
     -f lane=installer-hotfix \
     -f tested_sha="$tested_sha" \
     -f local_evidence_sha256="$evidence_sha256"
   ```

4. Verify that `installer-stable` equals `tested_sha`, both stable installer
   URLs return the tested hashes, and isolated installation succeeds. Record
   `installer-promoted` and `converged`. Do not publish a runtime release, npm
   package, manifest, or landing version for this lane.

If the product version changed since the prior installer promotion, or the fix
requires runtime/launcher/manifest behavior, use the full lane.

### Recovery rules

- Start with `release:status` and public readback. Resume from the first
  unproven checkpoint.
- A matching existing tag, workflow run, draft, branch promotion, deployment,
  or npm version is success; do not recreate it.
- Never use release upload clobber or move an immutable tag.
- A partial draft can be deleted/recreated only after its annotation proves the
  same source SHA and version.
- If GitHub is immutable but npm tooling failed before upload, use the reviewed
  `recovery_tag` path in `publish-npm.yml`; package bytes still come from the
  immutable tag.
- Any conflicting immutable identity requires a new version.

The detailed artifact-assembly commands below are retained as an operational
reference. Their former duplicate pre-merge and detached-tag test sequence is
superseded by `release:verify`.

## Archived manual release procedure

Binaries publish to the **public** `tetsuo-ai/agenc-releases` repo. The
`tetsuo-ai/agenc-core` source repository must also remain public: npm trusted
publishing can authenticate a private repository, but npm cannot generate the
required public-package provenance from one, so both release workflows fail
closed if source visibility changes. The installers default to
`releases/latest/download/agenc-runtime-manifest-v2.json` there — a regression
test pins that default.

Release builds require exactly Node.js 26.5.0 and npm 11.17.0 as declared by
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
   to `main`, run the native pre-tag bootstrap and full candidate workflows,
   then create its source tag and dispatch `.github/workflows/release-runtime.yml`
   in tagged mode at that exact ref. The preflight guards are intentionally
   safe to repeat, but a failed candidate workflow must be replaced by a fresh
   dispatch rather than retried: only attempt 1 can produce candidate
   artifacts. A later whole-workflow retry can delete the original Actions
   artifacts until they have been copied into the permanent immutable
   prerelease escrow. After escrow, tagged promotion is retryable because it
   authenticates and re-attests only those durable sealed candidate bytes. The
   tested preflight accepts only
   explicit HTTP 404 responses from the public npm registry and GitHub API.
   Existing versions fail, and DNS, TLS, authentication, rate-limit, redirect,
   and 5xx results are inconclusive failures rather than permission to tag.

   ```bash
   git fetch origin main --tags
   test -z "$(git status --porcelain=v1 --untracked-files=all)"
   git merge-base --is-ancestor HEAD origin/main
   version="$(node -p 'require("./package.json").version')"
   tag="agenc-v${version}"
   ! git show-ref --verify --quiet "refs/tags/$tag"
   npm run release:preflight
   tested_sha="$(git rev-parse HEAD)"
   evidence_path="${AGENC_RELEASE_EVIDENCE_DIR:-$HOME/.agenc/release-evidence}/${tag}-${tested_sha}.json"
   test -f "$evidence_path"
   evidence_sha256="$(sha256sum "$evidence_path" | cut -d ' ' -f 1)"
   [[ "$evidence_sha256" =~ ^[0-9a-f]{64}$ ]]
   gh workflow run verify-node-bootstrap.yml --repo tetsuo-ai/agenc-core \
     --ref main \
     -f tested_sha="$tested_sha" \
     -f local_evidence_sha256="$evidence_sha256"
   gh workflow run release-runtime.yml --repo tetsuo-ai/agenc-core \
     --ref main \
     -f phase=candidate \
     -f candidate_run_id=0 \
     -f tested_sha="$tested_sha" \
     -f local_evidence_sha256="$evidence_sha256"
   # Require both Rocky jobs, all ten candidate jobs, and all six artifacts.
   candidate_run_id="<successful candidate run ID>"
   candidate_seal_dir="$(mktemp -d)"
   github_cli=/absolute/path/to/checksum-verified/gh
   "$github_cli" run download "$candidate_run_id" \
     --repo tetsuo-ai/agenc-core \
     --name agenc-runtime-candidate-seal \
     --dir "$candidate_seal_dir"
   candidate_receipt="$candidate_seal_dir/agenc-runtime-candidate-seal.json"
   "$github_cli" attestation verify "$candidate_receipt" \
     --bundle "${candidate_receipt}.sigstore.json" \
     --repo tetsuo-ai/agenc-core \
     --signer-workflow \
       tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml \
     --signer-digest "$tested_sha" \
     --source-digest "$tested_sha" \
     --source-ref refs/heads/main \
     --hostname github.com \
     --cert-oidc-issuer https://token.actions.githubusercontent.com \
     --predicate-type https://slsa.dev/provenance/v1 \
     --deny-self-hosted-runners
   npm run release:checkpoint -- \
     --lane full --version "$version" --sha "$tested_sha" \
     --step candidate-build-complete \
     --receipt-file "$candidate_receipt" \
     --receipt-bundle "${candidate_receipt}.sigstore.json" \
     --github-cli "$github_cli"
   [[ "$candidate_run_id" =~ ^[1-9][0-9]*$ ]]
   candidate_tag="agenc-candidate-v${version}-run-${candidate_run_id}"
   candidate_assets="$(mktemp -d)"
   "$github_cli" run download "$candidate_run_id" \
     --repo tetsuo-ai/agenc-core \
     --pattern 'agenc-runtime-*' --dir "$candidate_assets"
   test "$(find "$candidate_assets" -mindepth 2 -maxdepth 2 -type f \
     -printf x | wc -c)" -eq 17
   verification_args=(
     --repo tetsuo-ai/agenc-core
     --signer-workflow \
       tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml
     --signer-digest "$tested_sha"
     --source-digest "$tested_sha"
     --source-ref refs/heads/main
     --hostname github.com
     --cert-oidc-issuer https://token.actions.githubusercontent.com
     --predicate-type https://slsa.dev/provenance/v1
     --deny-self-hosted-runners
   )
   candidate_receipt="$candidate_assets/agenc-runtime-candidate-seal/agenc-runtime-candidate-seal.json"
   candidate_seal_bundle="${candidate_receipt}.sigstore.json"
   "$github_cli" attestation verify "$candidate_receipt" \
     --bundle "$candidate_seal_bundle" "${verification_args[@]}"
   for slug in linux-x64 linux-arm64 darwin-x64 darwin-arm64 win-x64; do
     archive="$candidate_assets/agenc-runtime-$slug/agenc-runtime-${version}-${slug}-node26-abi147.tar.gz"
     metadata="${archive}.meta.json"
     candidate_bundle="${archive}.sigstore.json"
     "$github_cli" attestation verify "$archive" \
       --bundle "$candidate_bundle" "${verification_args[@]}"
     "$github_cli" attestation verify "$metadata" \
       --bundle "$candidate_bundle" "${verification_args[@]}"
     python3 scripts/release_candidate_policy.py promote \
       --repository tetsuo-ai/agenc-core \
       --run-id "$candidate_run_id" --run-attempt 1 \
       --tested-sha "$tested_sha" --evidence-sha256 "$evidence_sha256" \
       --version "$version" --slug "$slug" \
       --receipt "$candidate_receipt" \
       --seal-bundle "$candidate_seal_bundle" \
       --artifact "$archive" --metadata "$metadata" \
       --candidate-bundle "$candidate_bundle"
   done
   release_branch="$(gh api repos/tetsuo-ai/agenc-releases --jq .default_branch)"
   release_head="$(gh api \
     "repos/tetsuo-ai/agenc-releases/git/ref/heads/$release_branch" \
     --jq .object.sha)"
   candidate_tag_object="$(gh api --method POST \
     repos/tetsuo-ai/agenc-releases/git/tags \
     --raw-field tag="$candidate_tag" \
     --raw-field message="AgenC $version candidate run $candidate_run_id" \
     --raw-field object="$release_head" --raw-field type=commit --jq .sha)"
   gh api --method POST repos/tetsuo-ai/agenc-releases/git/refs \
     --raw-field ref="refs/tags/$candidate_tag" \
     --raw-field sha="$candidate_tag_object"
   gh release create "$candidate_tag" --repo tetsuo-ai/agenc-releases \
     --verify-tag --draft --prerelease \
     --title "AgenC $version candidate run $candidate_run_id" \
     --notes "Permanent candidate escrow for agenc-core run $candidate_run_id."
   gh release upload "$candidate_tag" --repo tetsuo-ai/agenc-releases \
     "$candidate_assets"/agenc-runtime-*/*
   gh release edit "$candidate_tag" --repo tetsuo-ai/agenc-releases \
     --draft=false --prerelease
   gh release verify "$candidate_tag" --repo tetsuo-ai/agenc-releases
   GH_TOKEN="$("$github_cli" auth token --hostname github.com)" \
     npm run release:checkpoint -- \
       --lane full --version "$version" --sha "$tested_sha" \
       --step candidate-escrow-published \
       --github-cli "$github_cli"
   git fetch origin main --tags
   test "$(git rev-parse refs/remotes/origin/main)" = "$tested_sha"
   ! git show-ref --verify --quiet "refs/tags/$tag"
   git tag --annotate --message "AgenC $version" "$tag" "$tested_sha"
   test "$(git rev-parse "${tag}^{commit}")" = "$tested_sha"
   git push origin "refs/tags/$tag"
   gh workflow run release-runtime.yml --repo tetsuo-ai/agenc-core \
     --ref "$tag" \
     -f phase=tagged \
     -f candidate_run_id="$candidate_run_id" \
     -f tested_sha="$tested_sha" \
     -f local_evidence_sha256="$evidence_sha256"
   promotion_run_id="<tagged promotion workflow run ID>"
   npm run release:checkpoint -- \
     --lane full --version "$version" --sha "$tested_sha" \
     --step source-tag-pushed \
     --receipt-json \
       "{\"tag\":\"$tag\",\"sha\":\"$tested_sha\",\"promotionRunId\":$promotion_run_id}"
   ```

   The source tag does not exist until the exact-SHA evidence, both native
   Rocky bootstrap jobs, all ten full candidate jobs, the five runtime
   artifacts, the attested candidate seal, and its permanent immutable
   17-asset prerelease escrow have passed review and checkpointing. Tagged mode
   reads only that escrow, preserves the verified build provenance, and adds
   tag provenance while promoting those exact candidate bytes; it does not
   rebuild them. Each
   workflow dispatch is invalid if either evidence input is omitted.

   Wait for all five tagged promotion jobs (Linux x64/arm64, macOS x64/arm64,
   Windows x64).
   Publishing stays operator-driven; the workflow has no cross-repository
   publish secret.
2. Download into a fresh temporary directory. `gh run download` creates one
   subdirectory per matrix artifact, and the manifest assembler accepts that
   one-level layout:

   ```bash
   tmp="$(mktemp -d)"
   github_cli=/absolute/path/to/checksum-verified/gh
   "$github_cli" run download "$promotion_run_id" \
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
   npm run release:checkpoint -- \
     --lane full --version "$version" --sha "$tested_sha" \
     --step runtime-build-complete \
     --receipt-json \
       "{\"runId\":$promotion_run_id,\"sha\":\"$tested_sha\"}"
   ```

   `github_cli` must be the canonical absolute path extracted from the exact
   platform archive, byte count, and SHA-256 in
   `release-toolchain.json#githubCli`; candidate checkpointing additionally
   requires the selected host pin's exact executable byte count and SHA-256.
   An ambient `gh` found through `PATH` is rejected. Its ordinary GitHub authentication may still authorize reading
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
   draft_url="$(gh release view "$tag" --repo tetsuo-ai/agenc-releases \
     --json url --jq .url)"
   npm run release:checkpoint -- \
     --lane full --version "$version" --sha "$tested_sha" \
     --step release-draft-staged \
     --receipt-json \
       "{\"tag\":\"$tag\",\"sha\":\"$tested_sha\",\"url\":\"$draft_url\"}"
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
   release_readback="$tmp/release-readback"
   mkdir -m 700 "$release_readback"
   gh release download "$tag" --repo tetsuo-ai/agenc-releases \
     --dir "$release_readback"
   gh api \
     -H 'Accept: application/vnd.github+json' \
     -H 'X-GitHub-Api-Version: 2026-03-10' \
     "repos/tetsuo-ai/agenc-releases/releases/tags/$tag" \
     > "$release_readback/release.json"
   python3 scripts/validate-runtime-release-inventory.py \
     --release-json "$release_readback/release.json" \
     --manifest "$release_readback/agenc-runtime-manifest-v2.json" \
     --checksums "$release_readback/SHA256SUMS" \
     --asset-root "$release_readback" \
     --prepared-root "$tmp/upload" \
     --toolchain release-toolchain.json \
     --tag "$tag"
   npm run release:checkpoint -- \
     --lane full --version "$version" --sha "$tested_sha" \
     --step github-published \
     --receipt-json \
       "{\"tag\":\"$tag\",\"sha\":\"$tested_sha\",\"repository\":\"tetsuo-ai/agenc-releases\"}"
   ```

   The release must not be marked prerelease: `releases/latest/download/`
   skips prereleases and the default installer URL would stop advancing.
4. Promote the exact tested SHA through the stable installer lane only after
   the immutable GitHub release passes readback. Wait for the workflow, verify
   that `installer-stable` and both public installer routes resolve to the
   tested bytes, then record `installer-promoted`:

   ```bash
   gh workflow run promote-installers.yml --repo tetsuo-ai/agenc-core \
     --ref "$tag" \
     -f lane=full \
     -f tested_sha="$tested_sha" \
     -f local_evidence_sha256="$evidence_sha256"
   installer_run_id="<successful installer promotion run ID>"
   npm run release:checkpoint -- \
     --lane full --version "$version" --sha "$tested_sha" \
     --step installer-promoted \
     --receipt-json \
       "{\"runId\":$installer_run_id,\"sha\":\"$tested_sha\"}"
   ```
5. `https://get.agenc.ag/{install.sh,install.ps1,manifest-v2.json,manifest.json}`
   307-redirect to the release assets. The site root serves the versioned
   installer landing page. Vercel project `agenc-get` has its complete tracked
   source in `packaging/get-agenc-ag/` (redeploy: `vercel deploy --prod` from
   that directory). Record `vercel-deployed` with the production deployment
   identity, or with an explicit checked-skip receipt when the tracked source
   already matches production.
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
7. Homebrew resumes with the private-Node formula in 0.11.2. Keep the checked-in
   placeholder formula unpublishable until both native macOS artifacts pass
   their release gates; then substitute the immutable release URLs and SHA-256
   values in `tetsuo-ai/homebrew-agenc`, test both Intel and Apple Silicon
   installs, and publish the tap update. Record `homebrew-published` with the
   merged tap commit, PR URL, formula version, Darwin artifact hashes, and both
   successful hosted test-bot run URLs:

   ```bash
   tap_commit="<merged tap commit SHA>"
   tap_pr_url="<merged tap PR URL>"
   darwin_arm64_sha256="<immutable Darwin arm64 artifact SHA-256>"
   darwin_x64_sha256="<immutable Darwin x64 artifact SHA-256>"
   arm64_test_bot_url="<successful Apple Silicon test-bot run URL>"
   x64_test_bot_url="<successful Intel test-bot run URL>"
   homebrew_receipt_json="$(
     AGENC_TAP_COMMIT="$tap_commit" \
     AGENC_TAP_PR_URL="$tap_pr_url" \
     AGENC_RELEASE_VERSION="$version" \
     AGENC_DARWIN_ARM64_SHA256="$darwin_arm64_sha256" \
     AGENC_DARWIN_X64_SHA256="$darwin_x64_sha256" \
     AGENC_ARM64_TEST_BOT_URL="$arm64_test_bot_url" \
     AGENC_X64_TEST_BOT_URL="$x64_test_bot_url" \
       node -e '
         process.stdout.write(JSON.stringify({
           tapCommit: process.env.AGENC_TAP_COMMIT,
           prUrl: process.env.AGENC_TAP_PR_URL,
           version: process.env.AGENC_RELEASE_VERSION,
           darwinSha256: {
             arm64: process.env.AGENC_DARWIN_ARM64_SHA256,
             x64: process.env.AGENC_DARWIN_X64_SHA256,
           },
           testBotRunUrls: {
             arm64: process.env.AGENC_ARM64_TEST_BOT_URL,
             x64: process.env.AGENC_X64_TEST_BOT_URL,
           },
         }))'
   )"
   npm run release:checkpoint -- \
     --lane full --version "$version" --sha "$tested_sha" \
     --step homebrew-published \
     --receipt-json "$homebrew_receipt_json"
   ```
8. npm: only after the immutable runtime release, stable installers,
   get.agenc.ag, and Homebrew have passed readback, dispatch the
   trusted-publishing workflow at the same immutable source tag and approve its
   `npm-production` environment. The workflow verifies the immutable runtime
   release and its assets, packs in an isolated detached worktree, attests the
   exact tarball and receipt, revalidates both after the approval gate,
   publishes with npm OIDC, and verifies the registry receipt:

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
   npm_run_id="<successful npm publication run ID>"
   npm run release:checkpoint -- \
     --lane full --version "$version" --sha "$tested_sha" \
     --step npm-published \
     --receipt-json "{\"runId\":$npm_run_id,\"sha\":\"$tested_sha\"}"
   ```

   If the immutable tag's npm workflow fails before upload because of a
   release-tooling defect, do not move the tag, rebuild runtime assets, or
   publish locally. Land a reviewed tooling repair on `main`, reverify the
   immutable runtime release and unchanged evidence digest, then use the
   workflow's explicit recovery mode:

   ```bash
   git fetch origin main --tags
   test "$(git rev-parse "${tag}^{commit}")" = "$tested_sha"
   git merge-base --is-ancestor "$tested_sha" origin/main
   gh workflow run publish-npm.yml --repo tetsuo-ai/agenc-core \
     --ref main \
     -f tested_sha="$tested_sha" \
     -f local_evidence_sha256="$evidence_sha256" \
     -f recovery_tag="$tag"
   ```

   Recovery mode requires the workflow checkout to equal current `main`,
   resolves `tested_sha` from the immutable `recovery_tag`, requires that
   source to remain in `main`, and compares the lockfile and release-toolchain
   pins with the tag. It executes the reviewed repaired packer and manifest
   validator against a clean detached checkout of the tagged source, so the
   tarball and receipt remain bound to the original tag commit. The
   workflow-run attestations and npm provenance identify the reviewed recovery
   tooling commit. This exception is only for downstream npm recovery after an
   immutable matching runtime release; identity drift still requires a new
   version.

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
