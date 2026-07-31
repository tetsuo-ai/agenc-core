# Fix the AgenC Release Process

## Problem

An AgenC release currently takes hours because the release tooling records
state but does not orchestrate the complete process. An operator or AI must
manually:

- Run and monitor several workflows.
- Copy SHA, evidence, and workflow-run identifiers between commands.
- Download, verify, and re-upload 17 candidate files.
- Create candidate and source tags.
- Assemble manifests, attestations, and the final GitHub release.
- Promote installers, deploy the website, update Homebrew, and publish npm.
- Check every public channel for convergence.

The verification itself is not the main bottleneck. Most of the delay is
serial coordination, repeated checks, and manual recovery.

## Goal

Provide one deterministic and resumable command:

```bash
npm run release:run -- --version 0.13.0
```

The command should complete the release automatically, pausing only for a
genuine failure or the required npm production approval.

Target:

- 45 to 75 minutes of elapsed time under normal CI conditions.
- Less than five minutes of operator involvement.
- No manual source-tag creation.
- Safe resume from the last publicly verified checkpoint.

## Target release flow

```text
exact-main verification + Rocky/toolchain proof
                         |
               five native candidates
                         |
              immutable candidate escrow
                         |
               exact source tag creation
                         |
              tagged byte re-attestation
                         |
              immutable GitHub release
                         |
       +-----------------+------------------+
       |                 |                  |
   installers         Homebrew          npm + website
       +-----------------+------------------+
                         |
                convergence smokes
```

## Required changes

### 1. Add a release controller

Extend the release state tooling with a `run` command that:

- Dispatches each required workflow.
- Watches jobs to completion.
- Validates outputs before advancing.
- Records checkpoints automatically.
- Queries public state when resuming.
- Treats an already-correct public result as success.
- Stops with a precise recovery instruction when a gate fails.

The controller should be a scheduler around the existing validators, not a
replacement for their security checks.

### 2. Automate candidate escrow and source tags

After all five candidate builders and the candidate seal pass, a narrowly
scoped GitHub App should:

1. Verify the exact candidate receipt and all 17 files.
2. Publish the immutable candidate escrow.
3. Confirm the escrow through GitHub's public API.
4. Atomically create `agenc-vX.Y.Z` at the verified source SHA.

Operators and AI should never create release tags manually. This removes the
largest source of wrong-version and wrong-commit releases.

### 3. Run source verification once

Run typecheck, sharded tests, PTY startup, clean-build checks, and compatible
toolchain checks concurrently against the exact merged `main` SHA.

Produce signed evidence keyed by:

```text
source SHA + release-toolchain.json digest + lockfile digest
```

Resumed releases must consume that evidence instead of rerunning successful
gates. Immutable bootstrap proofs may be reused when their toolchain inputs
have not changed.

### 4. Assemble the final release in CI

Tagged promotion should automatically:

- Re-attest the escrowed candidate bytes without rebuilding them.
- Generate runtime manifests and the SBOM.
- Validate the complete release inventory.
- Create and verify the immutable GitHub release.

No release assets should need to pass through an operator's filesystem.

### 5. Promote downstream channels concurrently

Once the immutable GitHub release exists:

- Promote the stable installers automatically.
- Deploy get.agenc.ag only when its tracked bytes changed.
- Generate the Homebrew formula directly from the release manifest.
- Open and auto-merge the Homebrew PR after both macOS jobs pass.
- Dispatch npm trusted publishing behind its existing production approval.
- Run isolated installation and update smokes for every channel.

These operations should run in parallel wherever their dependencies allow it.

## Safety guarantees to preserve

Automation must not weaken the current release contract:

- Every release is bound to one exact merged source SHA.
- No source tag exists before all native candidates pass.
- Candidate artifacts come only from workflow attempt one.
- Candidate escrow and the final release are immutable.
- Tagged promotion reuses verified candidate bytes and never rebuilds them.
- All five native targets and the glibc 2.28 floor remain enforced.
- Build and tag provenance remain independently verified.
- npm production publishing retains its human approval boundary.
- Completion requires public convergence across every supported channel.

## Implementation order

1. Add `release:run` to dispatch, monitor, resume, and checkpoint the existing
   process.
2. Move candidate escrow and source-tag creation into trusted automation.
3. Move final release assembly and validation into the workflow.
4. Automate installer, website, Homebrew, and npm promotion.
5. Parallelize source gates and reuse unchanged toolchain evidence.
6. Add an end-to-end dry-run lane that exercises the whole state machine
   without publishing public versions.

## Definition of done

A release is fixed when an operator can run one command, approve npm once, and
receive a final report containing:

- The exact source SHA and release tag.
- Candidate and final immutable release URLs.
- All five native artifact digests.
- Installer, website, Homebrew, and npm publication results.
- End-to-end installation and update smoke results.
- A complete checkpoint ledger suitable for safe resume and audit.

