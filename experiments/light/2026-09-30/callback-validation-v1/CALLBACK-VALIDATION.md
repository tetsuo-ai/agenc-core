# Callback validation — 2026-09-30

Root read the complete callback source and tests before execution. The synthetic
unit gate now passes **25/25 tests with zero skips**, and strict TypeScript
`noEmit` passes without reducing compiler checks or substituting source stubs.

Source `fixture-callbacks.ts` is unchanged from the frozen draft:
`40e03b818ed202b7ce6f8bd6f8f88dd4ef607d7f5c0c3b87bccf79fd2ce49d82`.
Corrected test SHA-256:
`2723790403bc2b47b8977c8cb929bafcadd6d64dcc59fa15250f2c67a43dd53c`.

The first run (17529 / 1b3eec) passed all 25 unit tests but failed strict types:
the JS-inferred `createFinancialOwner` parameter requires an explicit `fs`
property. The test now supplies its actual imported Node filesystem. No runtime
callback logic or financial implementation was changed. The corrected run
(68654 / 694aaf) passed both gates. Both logs/results are retained in
`callback-checks-first/` and `callback-checks-corrected/`; the first failure is
not hidden or replaced.

The test config reuses the selected Core's default hermetic setup and network
tripwire, uses the zero-skip reporter, selects exactly the one synthetic file,
and resolves `agenc-selected/*` to actual immutable `403da043` source. A separate
read-only verification (e03780) rechecked all 60 binding source pins and the
extra CLI source pins. No product source was edited or repinned. Node was
26.8.1. Result JSON records the input hashes and their stability across each run.

Covered: exact publisher-to-parent joins in positive-cap and credit-exhaustion
modes; one exact synthetic admission; finite SSE; no settlement by the callback;
strict request bytes/lexemes; one-shot/sticky refusal; immutable input snapshots;
all nine publication fsync boundaries; write/link failures and retained partial
evidence. Financial writes use fresh temporary synthetic roots only.

Not covered: installing/running the real observer together with these callbacks,
actual daemon/client/bootstrap, real ledger settlement, Linux containment,
performance, or a current Light/Pi model comparison. The next bounded integration
gate will join the unchanged observer with this callback in an owned offline
child. All deployment selections and Linux execution gates remain false.

The Linux read-only SSH probe (98889 / b28809) timed out before authentication.
The existing multiplexed control connection was also absent (fc19e9). Remote
processes remain unknown; no arm was restarted or declared stopped. The user was
asked to confirm PC reachability/address while local work continues.
