# Linux CLI v4 argv-order successor: first passing ordinary-CLI Light cell

Successor to linux-cli-v3. linux-parent-v3 differs from linux-parent-v2 only in
the ordinary CLI argv, now built by the pinned task-argv.mjs:

    agenc -p --light --provider openai --model gpt-6-luna \
      --config CONFIG --permission-mode default -- TASK

task-argv.mjs is added to the parent self-pin list. child.mjs, io.mjs and
setup.mjs are byte-identical to v2. linux-build-v4/seal-inputs.mjs changes only
the run root (cli-four), manifest names and protocol/run/channel ids (v4). The
v3 build.mjs and validator v3 are reused unchanged; no validator check was
loosened.

Regression: task-argv.test.mts imports the canonical Core parser
(readStartupCliFlags, stripRoutingFlags, tokenizeCliOptionRegion) and checks the
exact argv the parent spawns: lightMode, provider, model, config and permission
mode are selected and the prompt is exactly TASK. A negative control shows the
v2 ordering drops lightMode and leaks the flags into the prompt. Result: 4/4
pass with `CORE_RUNTIME=<core>/runtime tsx --test task-argv.test.mts` on Darwin
Node 26.8.1 (the Linux image runs Node 26.5.0).

Linux cli-four (native Node 26.5.0, network none, nonroot 1000:1000, 8 GiB, no
extra swap, 2 CPUs, 512 PIDs, 180 s watchdog) PASSED end to end in about 5 s:
build 3,481 inputs / 296 outputs / 4,866 assets; preflight one producer
collection, one denied metadata lookup, zero forbidden fetches; owner validator
every field true including lightMode and defaultPermission; one selected main
call dispatched to the local fixture response; callbacks published and fetched;
one ACK; finalizer clean commit equal to the attempt commit; owner and CLI both
exit 0; CLI printed "Done"; zero network attempts; OOMKilled false.

This is one synthetic fake-response cell in a fresh synthetic financial root.
The ledger row uses fixture pricing; nothing reached a provider and no paid
credit was used. It proves the ordinary Light CLI path through the accepted
owner, observer and finalizer on Linux. It is not a Light versus Pi result.
Private evidence: Desktop light-evaluation-2026-09-30/linux-cli-v4/.
