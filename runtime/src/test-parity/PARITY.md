# Test Suite Parity

Source root: `/home/tetsuo/git/codex` at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`.

Primary source anchors:
- `codex-rs/core/tests/suite/exec.rs`
- `codex-rs/core/tests/suite/exec_policy.rs`
- `codex-rs/core/tests/suite/fork_thread.rs`
- `codex-rs/core/tests/suite/hierarchical_agents.rs`
- `codex-rs/core/tests/suite/request_permissions.rs`
- `codex-rs/core/tests/suite/request_user_input.rs`
- `codex-rs/core/tests/suite/sqlite_state.rs`
- `codex-rs/core/tests/suite/shell_command.rs`
- `codex-rs/core/tests/suite/tool_parallelism.rs`
- `codex-rs/app-server/tests/suite/v2/initialize.rs`
- `codex-rs/app-server/tests/suite/v2/command_exec.rs`
- `codex-rs/app-server/tests/suite/v2/request_permissions.rs`
- `codex-rs/app-server/tests/suite/v2/request_user_input.rs`
- `codex-rs/app-server/tests/suite/v2/thread_start.rs`
- `codex-rs/app-server/tests/suite/v2/thread_read.rs`
- `codex-rs/app-server/tests/suite/v2/thread_list.rs`
- `codex-rs/app-server/tests/suite/v2/thread_fork.rs`
- `codex-rs/app-server/tests/suite/v2/turn_interrupt.rs`
- `codex-rs/app-server/tests/suite/v2/turn_steer.rs`
- `codex-rs/apply-patch/tests/fixtures/scenarios/`
- `codex-rs/apply-patch/tests/suite/scenarios.rs`

ZC-36 coverage lock:
- AgenC intentionally carries a representative top-20 suite subset rather than copying the full Rust integration harness. The full source suites require a different process harness, provider simulator, and app-server transport stack shape.
- The complete apply-patch numbered fixture corpus is already present under `runtime/src/tools/apply-patch/__fixtures__/scenarios/` and replayed by `runtime/src/tools/apply-patch/scenarios.test.ts`.
- `parity/ZC-36-parity.json` is the executable matrix for the selected behavior rows and target tests.
- `runtime/src/test-parity/zc36-suite-coverage.test.ts` verifies the matrix shape, target test files, and full apply-patch scenario inventory.
