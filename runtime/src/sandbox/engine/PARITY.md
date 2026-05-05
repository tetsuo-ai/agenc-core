# Cross-Platform Sandbox Engine Parity

Donor source commit: `c8c30d9d75556ecbe94991af22380d2a4e9d6589`.

Primary source anchors:
- `sandboxing/src/lib.rs`
- `sandboxing/src/manager.rs`
- `sandboxing/src/policy_transforms.rs`
- `sandboxing/src/seatbelt.rs`
- `sandboxing/src/seatbelt_tests.rs`
- `sandboxing/src/landlock.rs`
- `sandboxing/src/landlock_tests.rs`
- `sandboxing/src/bwrap.rs`
- `sandboxing/src/bwrap_tests.rs`
- `sandboxing/src/manager_tests.rs`
- `sandboxing/src/policy_transforms_tests.rs`
- `sandboxing/src/seatbelt_base_policy.sbpl`
- `sandboxing/src/seatbelt_network_policy.sbpl`
- `sandboxing/src/restricted_read_only_platform_defaults.sbpl`

This directory owns AgenC's TypeScript port of the sandbox engine's policy
model and platform backend argument generation:
- `index.ts` defines shared policy/profile types and path access helpers.
- `manager.ts` selects and transforms sandboxed command requests.
- `policy-transforms.ts` merges, normalizes, intersects, and applies
  additional permission profiles.
- `seatbelt.ts` builds macOS `sandbox-exec` policy payloads.
- `landlock.ts` serializes the Linux launcher argv handoff and exposes the
  child-process spawn surface for the helper executable.
- `bwrap.ts` probes host bubblewrap support and user namespace diagnostics.
- `policies/` contains the macOS seatbelt policy templates.

ZC-33 coverage lock:
- The engine source set listed above remains represented by AgenC-owned
  TypeScript counterparts in this directory.
- Platform backends are not shape-only ports: `seatbelt.ts` spawns
  `/usr/bin/sandbox-exec`, `landlock.ts` spawns the Linux helper executable,
  and `bwrap.ts` probes the real host bubblewrap binary with `spawnSync`.
- Source test anchors map to `linux-engine.test.ts`, `seatbelt.test.ts`, and
  `policy-transforms.test.ts`; the ZC-33 verifier runs those suites instead of
  only checking that the files exist.
- `runtime/src/permissions/sandbox.ts` is intentionally policy math only. The
  OS-backed execution layer lives here and in `runtime/src/sandbox/linux-launcher`.

Security-critical parity notes:
- Restricted read-only policies do not implicitly make the sandbox cwd
  writable.
- More-specific read/deny entries and protected metadata paths override
  broader writable roots unless an explicit write entry targets the metadata
  path.
- Restricted filesystem-root read/write grants are recognized as full-disk
  access only when not narrowed by deny/read carveouts.
- Read-deny glob entries participate in permission-profile intersection before
  accepting granted paths.
- The Linux test suite drives generated launcher arguments through a real
  helper subprocess.

Cross-cuts deliberately not carried:
- The Linux launcher executable is covered by C-01b.
- Runtime approval escalation is covered by C-01e.
- Windows restricted-token execution remains data-modeled here for manager
  selection parity, but the platform executor is out of this item.
