# V3 package-layout and independent-entry result

Root reviewed the complete v2-to-v3 diff and source-owned runtime package and
classifier path resolvers. HIGH authored the build correction; XHIGH's separate
read-only review found no blocker within the build-only scope.

- Strict `tsc --noEmit -p tsconfig.companion.json`, including the new guarded
  preflight entry: process 29805, result 2c5034, exit 0, no diagnostics.
- Fresh manifest sealing: process 90457 / b64e65 verified 6,166 Git blobs at
  `403da04398b55e51d1f4e8814f9a70957b0db5ef`; 37,031 inputs, 620,722,550 bytes.
  Manifest SHA256: `c73dbf32d6c243e115bf524459f535cace0f8effdc7d00901d274e2a5bec05cd`.
- OS-network-denied build: process 33825 / 74547d, exit 0; 3,474 graph inputs,
  288 emitted files under `/private/tmp/light-companion-build-v3/dist`.
- One canonical scoped-session implementation contributes bytes to one chunk.
  Both entry static closures contain zero Core source bytes; optional Chrome
  remains outside both closures.
- Exact selected runtime package manifest, VERSION and two classifier prompt
  files are staged in canonical package/dist geometry. No immutable source was
  modified; no assets plugin or native compiler was invoked.
- Root read both complete emitted entry static closures. Network-denied smoke
  67470c passed: both entries import; owner rejects with
  `cli_fixture_selection_not_accepted`, preflight rejects with
  `preflight_execution_not_approved`; global fetch remains unchanged. Both
  classifier paths resolve, and package/VERSION/prompt bytes match pinned
  inputs. All output and external helper hashes were checked before and after.

The smoke is **not** an import of the dynamic Core graph, daemon startup,
preflight execution, Linux validation or a provider call. The path checks prove
the concrete packaging corrections, not full executable closure. Both execution
approvals and deploymentClosureComplete remain false. The separate Darwin
dependency symlink is not a Linux native installation.

Retained metadata SHA256:

- `build-result.json`: `00cbecea8889c362e817e4931b28ef3e5dc4a340b39633f852c9e8c11f86edd1`
- `metafile.json`: `b7cbc8d63a83f01b3a4bee256a1414fb4e1e3c086c51928fbee1ddb8393c8140`

V1 and v2 outputs remain unchanged. No earlier failure was retried or replaced.
Linux SSH process 67671 / d91c10 again timed out before authentication; remote
process state is unknown. The next implementation is the actual parent recipe
and current identity adapter described in REAL-CLIENT-NEXT-GATE.md. A matched
paid Light/Pi panel and superiority remain unproven.
