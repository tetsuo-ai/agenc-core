# Linux CLI v3 diagnostic validator checkpoint

This checkpoint preserves the diagnostic-only companion validator v3, the build
v3 recipe that compiles it, and run-cli-v3.sh. Validator v3 keeps every v2
requirement and only adds scalar/boolean rejection diagnostics, so a refusal
names the field that failed. It is operator-experiment preservation, not an
installed runtime feature. SOURCE-MANIFEST.json lists source paths and bytes.

The Linux cli-three build passed (3,481 graph inputs, 296 outputs, 4,866
canonical assets) and independent preflight passed (one producer collection,
one denied metadata lookup, zero forbidden fetches, zero validations). The
ordinary CLI then FAILED prepared-sampling validation before any provider fetch.
The v3 diagnostic showed sessionPresent, workspaceMatches, admissionRequired,
admissionPresent and nonInteractive all true, but lightMode false.

Cause: a fixture argv-order bug in linux-parent-v2/parent.mjs, not a Core
defect. The parent spawned `agenc -p TASK --light --provider ...`. `-p` is
boolean and runtime/src/bin/cli-option-region.ts ends the option region at the
first positional token, so `--light` and every later flag became prompt text.
The existing regression runtime/tests/bin/startup-selection.test.ts ("only
before the prompt") already documents this parser behaviour.

Owner exited 0, task exited 1, shutdown acknowledged, both children closed, no
timeout, kill or OOM. No ACK, no financial admission, empty synthetic ledger,
no paid call. Private evidence: Desktop light-evaluation-2026-09-30/linux-cli-v3/.
