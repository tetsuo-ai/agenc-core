# Linux Sandbox Launcher Parity

Source root: `/home/tetsuo/git/codex/codex-rs` at `c8c30d9d75556ecbe94991af22380d2a4e9d6589`. <!-- branding-scan: allow donor citation in local parity artifact -->

Primary source anchors:
- `linux-sandbox/src/lib.rs`
- `linux-sandbox/src/main.rs`
- `linux-sandbox/src/launcher.rs`
- `linux-sandbox/src/bwrap.rs`
- `linux-sandbox/src/landlock.rs`
- `linux-sandbox/src/linux_run_main.rs`
- `linux-sandbox/src/proxy_routing.rs`
- `linux-sandbox/src/vendored_bwrap.rs`
- `linux-sandbox/config.h`
- `linux-sandbox/build.rs`

Target mapping:
- `main.ts` is the executable Node entrypoint.
- `lib.ts` owns reusable entrypoint helpers for bin startup and programmatic tests.
- `cli.ts` parses the manager handoff arguments and permission profile JSON.
- `linux-run-main.ts` resolves the profile, builds the outer bubblewrap invocation, re-enters the helper for the inner command stage, uses `execve` for the non-proxy final command, applies an inner seccomp bubblewrap wrapper for managed proxy commands, and relays termination signals when a child process must remain supervised.
- `launcher.ts` discovers the real `bwrap` / `bubblewrap` binary, probes `--argv0` support, and spawns the platform binary with an inherited seccomp FD.
- `bwrap.ts` builds the bubblewrap filesystem, namespace, proc, argv0, and seccomp flags from AgenC's sandbox policy model.
- `landlock.ts` carries the Linux network hardening path in TypeScript by generating a cBPF seccomp program and passing it to bubblewrap with `--seccomp FD`.
- `proxy-routing.ts` ports proxy environment recognition, loopback endpoint validation, host-side UDS route preparation, namespace-local loopback activation, URL rewrite helpers, and stream-pairing primitives.
- `vendored-bwrap.ts` records the build-shape divergence: the TypeScript runtime requires a system bubblewrap binary instead of linking an embedded C helper.
- `build.ts` records the launcher build contract exposed to tests and package validation.
- `runtime/scripts/write-build-version.mjs` copies sandbox policy assets beside the built launcher entrypoint so package-bin smoke execution can import the bundled sandbox modules.

Documented divergences:
- Legacy direct Landlock is fail-closed in the TypeScript launcher. AgenC's active Linux path performs filesystem isolation with bubblewrap and network syscall restriction with a bubblewrap-loaded seccomp cBPF program. The Rust-only direct Landlock fallback has no Node native binding in this runtime.
- Embedded bubblewrap C compilation is not carried. AgenC ships a Node executable that discovers and launches the platform `bwrap` / `bubblewrap` binary, matching the system-binary execution path.
- Managed proxy mode uses a Node TCP/UDS route pair instead of the donor's lower-level helper. The outer launcher prepares loopback proxy routes on host-owned UDS sockets, bind-mounts the socket directory into bubblewrap, and the inner stage activates namespace-local loopback listeners before applying a proxy-routed seccomp filter to the user command through an inner bubblewrap invocation.
- Proxy mode keeps the inner Node process alive while the proxied command runs so the namespace-local TCP listeners can continue to serve the command. Non-proxy inner launches use `process.execve` so the Node helper is replaced by the final command.
