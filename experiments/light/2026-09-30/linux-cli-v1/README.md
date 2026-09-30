# Linux companion build and first preflight attempt

This is original-byte preservation of the Linux-specific companion builder,
owned-parent/setup support and one build-manifest correction. These are operator
experiments, not installed runtime modules or a portable launcher. Imports and
`/gate` paths retain their original deployment assumptions; adjacent dependencies
must be selected from their separately pinned snapshots, not guessed or stubbed.
`SOURCE-MANIFEST.json` records every imported file's original path and hash.

The selected product source remains `403da04398b55e51d1f4e8814f9a70957b0db5ef`.
The Linux build uses snapshot `38d63e586a92c4da8b1e51b31d46f74ee359a55a`, whose
`runtime/src` is unchanged. The separate
[Linux correctness result](../linux-resume-v1/README.md) retains its own scope.

The first companion build refused its manifest before producing output: the
shared setup/deployment inventory included Python outside the build-only input
namespace. A separately preserved manifest correction removed only that unused
build input; no source, toolchain, financial or deployment pin was relaxed.
The corrected build succeeded with 3,480 graph inputs, 294 emitted outputs and
4,866 canonical Linux runtime assets. It retains three entries, one compiled
scoped-Session module, guarded owner/preflight static closures and the normal
runtime assets. Build success does not establish actual runtime readiness.

The subsequent real owned-parent attempt failed during independent preflight,
before owner/task startup or a provider request. The child exited1 with observed
close/disconnect and completed cleanup; the synthetic ledger remained empty.
The first failure artifact retained only its call phase, so its cause is not
established by that artifact. A native storage warning is not causal proof.
The failed attempt is preserved, not reset or silently replaced.

Two separately preserved location diagnostics followed. Diagnostic v1 refused
its own setup because its absent-`NODE_OPTIONS` assumption conflicted with the
canonical network tripwire's exact injected preload. Diagnostic v2 accepts only
that exact pinned preload and reached the unchanged preflight assertion
`preflight_attempted_sampling`. This identifies the failed assertion, **not**
which fetch/validation callback or caller caused it. There was no ordinary CLI
startup or real provider-network request. No Core defect, libsecret cause or
successful preflight is claimed; further localization is a separate task.

All generated manifests, logs, child evidence and deployment paths remain in
the private Desktop evaluation archive under
`light-evaluation-2026-09-30/linux-cli-v1/`. No source tar, dependency tree,
emitted bundle, raw wire/prompt, private database or credential is imported here.
No paid execution, matched Light/Pi result, timing gain or finalization authority
follows from this checkpoint. Root owns any separately versioned diagnosis and
subsequent execution approval.
