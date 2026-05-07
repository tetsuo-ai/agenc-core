# @tetsuo-ai/agenc 0.2.0 Release Notes

## Daemon-Backed CLI

The public `agenc` launcher now starts through the local AgenC daemon. Normal
prompt, TUI, and background-agent commands attach to the daemon instead of
building an in-process runtime for each command.

## What Changed

- `agenc` installs from `@tetsuo-ai/agenc` and delegates to the packaged
  `@tetsuo-ai/runtime` command surface.
- The launcher checks `~/.agenc/daemon.pid` and `~/.agenc/daemon.cookie`,
  starts the daemon when it is absent, and waits for daemon readiness before
  handing off to runtime commands.
- `agenc daemon start`, `agenc daemon start --foreground`, `agenc daemon status`,
  `agenc daemon restart`, and `agenc daemon stop` manage the local daemon.
- `agenc agent start`, `agenc agent list`, `agenc agent attach`,
  `agenc agent stop`, and `agenc agent logs` operate through the daemon-owned
  background-agent lifecycle.
- Linux `systemd` and macOS `launchd` templates run
  `agenc daemon start --foreground` for supervisor-managed daemon operation.

## Configuration And Operations

- Set `AGENC_HOME` to move daemon state away from `~/.agenc`.
- Set `AGENC_DAEMON_AUTOSTART=0` to disable launcher autostart.
- Set `AGENC_DAEMON_READY_TIMEOUT_MS` to change how long the public launcher
  waits for daemon readiness.
- Set `AGENC_DAEMON_REQUEST_TIMEOUT_MS` to tune daemon client request timeouts.
- Daemon state files live under the resolved AgenC home:
  `daemon.pid`, `daemon.sock`, `daemon.cookie`, and `daemon-snapshot.json`.

## Upgrade Notes

Existing operator flows should use the `agenc` command installed by
`@tetsuo-ai/agenc`. For long-running hosts, install the provided supervisor
template for the target platform and keep foreground daemon mode under the
supervisor.
