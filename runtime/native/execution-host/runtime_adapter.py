"""Docker runc replacement. Unmanaged OCI operations retain Docker ownership.

Installed entrypoint runs this with an absolute Python interpreter and -I -B.
The configured runc and host socket paths are installer-owned, not task inputs.
"""

from __future__ import annotations

import os
import fcntl
import socket
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from protocol import HostError, LEASE_ENV, MAX_FRAME_BYTES, decode_json, encode_json, request, request_descriptors
from task_bootstrap import LAUNCHER_PATH, launch_descriptors
from task_files import has_file, validate_files

RUNC_PATH = "/opt/agenc-execution/bin/runc-1.5.1"
RUNTIME_SOCKET = "/run/agenc-execution/runtime.sock"


def subcommand_index(argv: list[str]) -> int | None:
    takes_value = {"--root", "--log", "--log-format", "--rootless", "--criu"}
    switches = {"--debug", "--systemd-cgroup", "--help", "-h", "--version", "-v"}
    index = 0
    while index < len(argv):
        value = argv[index]
        if not value.startswith("-"):
            return index
        name, separator, _ = value.partition("=")
        if name in takes_value:
            index += 1 if separator else 2
        elif name in switches:
            index += 1
        else:
            raise HostError("unsupported_runtime_option", "Unqualified runc global option")
    return None


def process_option(argv: list[str], command_index: int) -> tuple[int, str, str] | None:
    takes_value = {"--console-socket", "--pid-file", "--process", "-p", "--cwd", "--env", "-e",
                   "--user", "-u", "--additional-gids", "-g", "--process-label", "--apparmor",
                   "--cap", "--preserve-fds", "--cgroup", "--pidfd-socket"}
    switches = {"--detach", "-d", "--tty", "-t", "--no-new-privs", "--ignore-paused"}
    index = command_index + 1
    found: tuple[int, str] | None = None
    while index < len(argv) and argv[index].startswith("-"):
        value = argv[index]
        name, separator, attached = value.partition("=")
        if name in takes_value:
            if not separator and index + 1 >= len(argv):
                raise HostError("invalid_runtime_option", "Missing runc exec option value")
            argument = attached if separator else argv[index + 1]
            if name in ("--process", "-p"):
                if found is not None:
                    raise HostError("invalid_runtime_option", "Duplicate runc process specification")
                found = (index, argument)
            index += 1 if separator else 2
        elif name in switches:
            index += 1
        else:
            raise HostError("unsupported_runtime_option", "Unqualified runc exec option")
    if found is None:
        if any(LEASE_ENV in value for value in argv[command_index + 1:]):
            raise HostError("invalid_lease", "Managed exec requires an OCI process specification")
        return None
    if index != len(argv) - 1:
        raise HostError("invalid_runtime_option", "Expected one immutable OCI container ID")
    return found[0], found[1], argv[index]


def read_process(path: str) -> dict[str, Any]:
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        with os.fdopen(fd, "rb", closefd=False) as source:
            data = source.read(MAX_FRAME_BYTES + 1)
        if len(data) > MAX_FRAME_BYTES:
            raise HostError("invalid_process", "OCI process specification exceeds its bound")
        value = decode_json(data)
        if not isinstance(value, dict):
            raise HostError("invalid_process", "OCI process specification must be an object")
        return value
    finally:
        os.close(fd)


def extract_lease(process: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
    env = process.get("env", [])
    if not isinstance(env, list) or not all(isinstance(value, str) and "\0" not in value for value in env):
        raise HostError("invalid_process", "Invalid OCI process environment")
    markers = [value for value in env if value.split("=", 1)[0] == LEASE_ENV]
    if not markers:
        return None, process
    if len(markers) != 1 or "=" not in markers[0]:
        raise HostError("invalid_lease", "Duplicate or malformed reserved launch marker")
    marker = markers[0].split("=", 1)[1]
    if not marker:
        raise HostError("invalid_lease", "Empty launch lease")
    return marker, {**process, "env": [value for value in env if value != markers[0]]}


def execution_spec(process: dict[str, Any]) -> dict[str, Any]:
    args = process.get("args")
    cwd = process.get("cwd")
    user = process.get("user")
    env = process.get("env", [])
    if (not isinstance(env, list) or
            not all(isinstance(value, str) and "\0" not in value and "=" in value and
                    value.split("=", 1)[0] for value in env) or
            len({value.split("=", 1)[0] for value in env}) != len(env)):
        raise HostError("invalid_process", "Process environment must have unique explicit names and values")
    if (not isinstance(args, list) or not args or not args[0] or
            not all(isinstance(value, str) and "\0" not in value for value in args) or
            not isinstance(cwd, str) or not cwd.startswith("/") or "\0" in cwd or
            not isinstance(user, dict) or type(user.get("uid")) is not int or type(user.get("gid")) is not int or
            user["uid"] != 0 or user["gid"] != 0 or
            user.get("additionalGids") not in (None, [], [0]) or
            type(process.get("terminal", False)) is not bool):
        raise HostError("invalid_process", "Unqualified managed process specification")
    # Docker owns all other OCI security fields. The adapter only removes the
    # transport marker; capabilities, LSM labels, rlimits and console survive.
    result = {"args": args, "cwd": cwd, "env": env,
              "terminal": process.get("terminal", False), "user": {"uid": 0, "gid": 0}}
    if "argv0" in process:
        if not isinstance(process["argv0"], str) or "\0" in process["argv0"]:
            raise HostError("invalid_process", "Alternate argv[0] must be a NUL-free string")
        result["argv0"] = process["argv0"]
    if "files" in process:
        result["files"] = validate_files(process["files"])
    if "detachedLogPath" in process:
        path = process["detachedLogPath"]
        if not isinstance(path, str) or re.fullmatch(r"/tmp/agenc-detached-[a-f0-9]{32}\.log", path) is None:
            raise HostError("invalid_process", "Detached log identity must be allocated by the host")
        result["detachedLogPath"] = path
    return result


def run(argv: list[str], *, runc_path: str = RUNC_PATH,
        runtime_socket: str = RUNTIME_SOCKET, launcher_path: str = LAUNCHER_PATH) -> int:
    index = subcommand_index(argv)
    if index is None or argv[index] != "exec":
        os.execv(runc_path, [runc_path, *argv])
    option = process_option(argv, index)
    if option is None:
        os.execv(runc_path, [runc_path, *argv])
    position, path, container_id = option
    marker, process = extract_lease(read_process(path))
    if marker is None:
        os.execv(runc_path, [runc_path, *argv])
    # A managed exec cannot override the host-owned scope, pidfd receipt or
    # process fields after the lease was validated.
    managed_allowed = {"--console-socket", "--pid-file", "--process", "-p", "--detach", "-d"}
    cursor = index + 1
    while cursor < len(argv) - 1:
        name, separator, _ = argv[cursor].partition("=")
        if name not in managed_allowed:
            raise HostError("invalid_lease", "Managed runc exec has an unauthorized option")
        cursor += 1 if separator or name in ("--detach", "-d") else 2
    claim, received = request_descriptors(runtime_socket, {"method": "claim", "marker": marker,
                                                          "containerId": container_id, "spec": execution_spec(process)})
    sources: list[int] = []
    try:
        target = claim.get("processSpec")
        if (not isinstance(target, dict) or execution_spec(target) != target or
                len(received) != len(target.get("files", [])) + int("detachedLogPath" in target)):
            raise HostError("invalid_lease", "Runtime claim omitted its exact process or held descriptors")
        for fd in received:
            sources.append(fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 10))
    except BaseException:
        for fd in sources:
            os.close(fd)
        raise
    finally:
        for fd in received:
            os.close(fd)
    process = {**process, "args": ["/proc/self/fd/3"], "env": [],
               **({"cwd": "/"} if has_file(target, "cwd") else {})}
    # Claim establishes our host launch cgroup before any runtime child exists.
    # A cancellation kills this adapter and every runtime descendant, then
    # kills the command scope, so a delayed runc cannot populate it afterward.
    try:
        with launch_descriptors(target, launcher_path) as (launcher_fd, bootstrap_fd), tempfile.TemporaryFile() as process_file:
            process_file.write(encode_json(process))
            process_file.flush()
            process_slot = 5 + len(sources)
            replacement = f"/proc/self/fd/{process_slot}"
            forwarded = argv.copy()
            if "=" in forwarded[position]:
                forwarded[position] = "--process=" + replacement
            else:
                forwarded[position + 1] = replacement
            forwarded[index + 1:index + 1] = ["--cgroup", claim["subgroup"],
                                            "--pidfd-socket", claim["pidfdSocket"], "--preserve-fds", str(2 + len(sources))]
            # No Python callback executes after fork. Only the launcher,
            # bootstrap and attested task descriptors survive into the task;
            # runc's process JSON does not. LISTEN_FDS cannot alter this layout.
            pid = os.posix_spawn(runc_path, [runc_path, *forwarded],
                                 {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"},
                                 file_actions=[(os.POSIX_SPAWN_DUP2, process_file.fileno(), process_slot),
                                               (os.POSIX_SPAWN_DUP2, launcher_fd, 3),
                                               (os.POSIX_SPAWN_DUP2, bootstrap_fd, 4),
                                               *[(os.POSIX_SPAWN_DUP2, fd, 5 + offset) for offset, fd in enumerate(sources)]])
            _, status = os.waitpid(pid, 0)
            result = os.waitstatus_to_exitcode(status)
    finally:
        for fd in sources:
            os.close(fd)
    # A lost reply is not retried. The original operation is inspectable in the
    # supervisor, including its pidfd and eventual cleanup receipt.
    request(runtime_socket, {"method": "runtime_finished", "operationId": claim["operationId"],
                             "exitCode": result})
    return result


def report_error(argv: list[str], error: Exception) -> None:
    message = f"agenc-runc: {error}"
    print(message, file=sys.stderr)
    # containerd obtains runtime diagnostics from runc's --log file; adapter
    # stderr alone is commonly discarded during a detached Docker exec.
    try:
        index = subcommand_index(argv)
        globals_ = argv if index is None else argv[:index]
        for position, value in enumerate(globals_):
            if value == "--log":
                path = globals_[position + 1]
            elif value.startswith("--log="):
                path = value.partition("=")[2]
            else:
                continue
            fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
            try:
                os.write(fd, encode_json({"level": "error", "msg": message,
                                          "time": datetime.now(timezone.utc).isoformat()}) + b"\n")
            finally:
                os.close(fd)
            break
    except (OSError, HostError, IndexError):
        pass


if __name__ == "__main__":
    try:
        sys.exit(run(sys.argv[1:]))
    except (HostError, OSError, ValueError) as error:
        report_error(sys.argv[1:], error)
        sys.exit(125)
