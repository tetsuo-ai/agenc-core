"""Persistent host authority for Docker execution environments.

The runtime socket accepts only host root. The controller socket is reachable
only by the operator group and checks kernel peer credentials on every request.
Neither endpoint is mounted into a task environment.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
import re
import secrets
import signal
import socket
import stat
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from containment import Containment
from docker_api import DockerAPI
from environment import resolve_binding, validate_profile
from execution import Execution
from detached import DetachedExecution, DetachedStartup
from filesystem import FilesystemWorker, FilesystemError, KIND_FILE, KIND_DIRECTORY
from leases import LeaseStore
from output import read_output
from pidfd import PidfdReceipt
from protocol import HostError, decode_json, operation_index, peer_credentials, receive, send
from runtime_adapter import execution_spec
from task_files import describe_file


class Supervisor:
    def __init__(self, *, state_root: Path, socket_root: Path, launch_root: Path,
                 docker: DockerAPI, protected_roots: tuple[Path, ...],
                 controller_uids: frozenset[int], controller_gid: int):
        self.state_root = state_root
        self.socket_root = socket_root
        self.docker = docker
        self.protected_roots = protected_roots + (state_root, socket_root)
        self.controller_uids = controller_uids
        self.controller_gid = controller_gid
        self.store = LeaseStore(state_root / "receipts.sqlite")
        self.launch_files: dict[str, tuple[int, ...]] = {}
        self.containment = Containment(self.store, launch_root, self.assert_generation, self._release_launch_files)
        self.pidfds: dict[str, PidfdReceipt] = {}
        self.executions: dict[str, Execution] = {}
        self.detached_startups: dict[str, DetachedStartup] = {}
        self.filesystem_lock = threading.RLock()
        self.filesystems: dict[tuple[int, str], dict[str, Any]] = {}
        self.output_root = state_root / "output"
        self.output_root.mkdir(mode=0o700, exist_ok=True)
        self.stopping = threading.Event()
        self.listeners: list[socket.socket] = []
        self.threads: list[threading.Thread] = []

    def bind(self, container: str) -> dict[str, Any]:
        if not isinstance(container, str) or not 0 < len(container) <= 256:
            raise HostError("invalid_request", "Missing container name or immutable ID")
        inspected = self.docker.inspect(container)
        validate_profile(self.docker.info(), inspected, self.protected_roots)
        binding = resolve_binding(inspected)
        # Resolve by ID a second time; names and container restarts must not race
        # validation into silently changing the execution target.
        current = resolve_binding(self.docker.inspect(binding["containerId"]))
        if current != binding:
            raise HostError("environment_changed", "Task environment changed during binding")
        self.store.register_environment(binding)
        return binding

    def assert_generation(self, generation: str) -> dict[str, Any]:
        binding = self.store.environment(generation)
        try:
            current = resolve_binding(self.docker.inspect(binding["containerId"]))
            if current != binding:
                raise HostError("environment_dead", "Task environment generation changed")
        except Exception as error:
            self.store.quarantine(generation, str(error))
            raise HostError("environment_dead", "Original task environment is unavailable") from error
        return binding

    def _release_launch_files(self, operation: str) -> None:
        with self.store.lock:
            for fd in self.launch_files.pop(operation, ()):
                os.close(fd)

    def _allocate(self, message: dict[str, Any], principal: int) -> tuple[str, str]:
        spec = execution_spec(message["spec"])
        if (spec != message["spec"] or "files" in spec or "detachedLogPath" in spec or
                any(value.split("=", 1)[0] == "__AGENC_EXECUTION_LEASE_V1" for value in spec["env"])):
            raise HostError("invalid_request", "Launch requires an exact process; descriptor attestations are host-owned")
        bindings = message.get("bindings", {})
        if not isinstance(bindings, dict) or not bindings.keys() <= {"cwd", "stdin"}:
            raise HostError("invalid_request", "Invalid held task file bindings")
        if "stdin" in bindings and spec["terminal"]:
            raise HostError("unsupported_operation", "A terminal cannot also use a bound input file")
        captured: list[int] = []
        startup_channel: socket.socket | None = None
        try:
            # Match filesystem/authority lock ordering. The lease retains its
            # own exported descriptors even if the original capability closes.
            with self.filesystem_lock, self.store.lock:
                if self.stopping.is_set():
                    raise HostError("host_stopping", "Execution host is closing")
                if (bindings or message.get("detached")) and len(self.launch_files) >= 1024:
                    raise HostError("launch_limit", "Too many pending descriptor handoffs")
                if bindings:
                    if len(self.launch_files) >= 1024:
                        raise HostError("launch_limit", "Too many pending descriptor handoffs")
                    owner, generation, revision = message["owner"], message["generation"], message["authorityRevision"]
                    self.store.assert_authority(principal, owner, generation, revision)
                    self.assert_generation(generation)
                    entry = self.filesystems.get((principal, owner))
                    files = []
                    for role in ("cwd", "stdin"):
                        if role not in bindings:
                            continue
                        source = bindings[role]
                        if not isinstance(source, dict) or set(source) != {"workerId", "handle"}:
                            raise HostError("invalid_request", "Task descriptor requires a native capability")
                        if (entry is None or entry["generation"] != generation or entry["revision"] != revision or
                                source["workerId"] != entry["workerId"]):
                            raise HostError("stale_capability", "Task descriptor belongs to a different filesystem epoch or owner")
                        fd, identity = entry["worker"].export_handle(source["handle"], KIND_DIRECTORY if role == "cwd" else KIND_FILE)
                        captured.append(fd)
                        files.append(describe_file(role, source, fd, identity))
                    spec = {**spec, "files": files}
                if message.get("detached"):
                    startup_channel, writer = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC)
                    startup_channel.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
                    captured.append(writer.detach())
                operation, marker = self.containment.allocate(
                    generation=message["generation"], principal=principal, owner=message["owner"],
                    run_id=message["runId"], call_id=message["callId"], attempt=message["attempt"],
                    authority_revision=message["authorityRevision"], spec=spec,
                    detached=message.get("detached", False), index=message.get("operationIndex", 0))
                if startup_channel is not None:
                    self.detached_startups[operation] = DetachedStartup(self.store, operation, startup_channel,
                        lambda: self.assert_generation(message["generation"]), self.output_root)
                    startup_channel = None
                if captured:
                    self.launch_files[operation] = tuple(captured)
                    captured = []
                return operation, marker
        finally:
            if startup_channel is not None:
                startup_channel.close()
            for fd in captured:
                os.close(fd)

    def _runtime(self, message: dict[str, Any], peer_pid: int) -> dict[str, Any]:
        method = message.get("method")
        if method == "claim":
            marker = message.get("marker")
            if not isinstance(marker, str) or re.fullmatch(r"[0-9a-f]{32}\.[0-9a-f]{64}", marker) is None:
                raise HostError("invalid_lease", "Malformed runtime launch lease")
            with self.store.lock:
                operation = marker.split(".", 1)[0]
                if operation in self.pidfds:
                    raise HostError("invalid_lease", "Runtime lease was already claimed")
                row = self.store.operation(operation)
                if len(self.launch_files.get(operation, ())) != len(row["spec"].get("files", [])) + int("detachedLogPath" in row["spec"]):
                    raise HostError("invalid_lease", "Original task descriptors are unavailable; execution cannot be repeated")
                # Install the socket before acknowledging the claim; rapid
                # commands may exit before Docker's start reply arrives.
                receipt = PidfdReceipt(
                    self.socket_root / (operation + ".pidfd"),
                    lambda pid: self._started(operation, pid),
                    lambda: self._leader_exited(operation),
                    lambda error: self._receipt_failed(operation, error))
                try:
                    claim = self.containment.claim(marker=marker, container_id=message["containerId"],
                                                   spec=message["spec"], peer_pid=peer_pid)
                    self.pidfds[operation] = receipt
                    return {**claim, "pidfdSocket": str(receipt.path),
                            "_descriptors": self.launch_files.pop(operation, ())}
                except BaseException:
                    receipt.close()
                    raise
        if method == "runtime_finished":
            operation = message.get("operationId")
            code = message.get("exitCode")
            if not isinstance(operation, str) or type(code) is not int or not -128 <= code <= 255:
                raise HostError("invalid_request", "Invalid runtime settlement")
            with self.store.lock:
                row = self.store.operation(operation)
                if row["runtime_pid"] != peer_pid:
                    raise HostError("owner_denied", "Runtime settlement belongs to another adapter")
                if row["state"] not in ("claimed", "running"):
                    raise HostError("invalid_transition", "Runtime was already fenced")
                self.store.transition(operation, (row["state"],), row["state"],
                                      "runtime_finished", runtime_exit=code)
            if code != 0:
                self._schedule_cleanup(operation)
            return {}
        raise HostError("invalid_request", "Unsupported runtime operation")

    def _started(self, operation: str, pid: int) -> None:
        with self.store.lock:
            row = self.store.operation(operation)
            if row["state"] not in ("claimed", "running"):
                return
            identity: dict[str, Any] = {}
            if pid > 0:
                try:
                    directory = Path("/proc") / str(pid)
                    fields = (directory / "stat").read_text().rsplit(")", 1)[1].split()
                    status = dict(line.split(":", 1) for line in (directory / "status").read_text().splitlines() if ":" in line)
                    identity = {"leader_pid": pid, "leader_start_time": fields[19], "task_pid": int(status["NSpid"].split()[-1])}
                except (OSError, KeyError, ValueError, IndexError):
                    pass  # Rapid exit remains a process result, never a fresh PID lookup or replay.
            self.store.transition(operation, (row["state"],), "running", "process_started", **identity)

    def _finish_detached_scope(self, operation: str) -> bool:
        with self.store.lock:
            row = self.store.operation(operation)
            if row["cleanup_proven"]:
                return True
            command, launch = self.containment._scopes(row)
            try:
                if command.populated():
                    return False
            finally:
                command.close()
                launch.close()
            self.containment.stop(operation, row["principal"], row["owner"])
            return True

    def _execution(self, operation: str) -> Execution:
        row = self.store.operation(operation)
        arguments = (operation, self.store, self.docker, self.output_root, lambda: self._schedule_cleanup(operation))
        if row["detached"]:
            return DetachedExecution(*arguments, startup=self.detached_startups[operation],
                                     finish_scope=lambda: self._finish_detached_scope(operation))
        return Execution(*arguments)

    def _leader_exited(self, operation: str) -> None:
        with self.store.lock:
            row = self.store.operation(operation)
            if row["state"] in ("claimed", "running"):
                self.store.transition(operation, (row["state"],), row["state"],
                                      "leader_exited", leader_exited=1)
            if not row["detached"]:
                self._schedule_cleanup(operation)

    def _schedule_cleanup(self, operation: str) -> None:
        def cleanup() -> None:
            # Give Docker's detached runtime adapter its normal return path.
            # This is only a grace interval, never proof that launch is closed.
            deadline = time.monotonic() + 2
            try:
                while time.monotonic() < deadline and not self.stopping.is_set():
                    with self.store.lock:
                        row = self.store.operation(operation)
                        command, launch = self.containment._scopes(row)
                        try:
                            if not launch.populated():
                                break
                        finally:
                            command.close()
                            launch.close()
                    time.sleep(0.01)
                row = self.store.operation(operation)
                self.containment.stop(operation, row["principal"], row["owner"])
                with self.store.lock:
                    receipt = self.pidfds.pop(operation, None)
                if receipt is not None:
                    receipt.close()
            except (HostError, OSError) as error:
                row = self.store.operation(operation)
                self.store.quarantine(row["generation"], str(error))
        thread = threading.Thread(target=cleanup, daemon=True)
        thread.start()

    def _receipt_failed(self, operation: str, error: Exception) -> None:
        with self.store.lock:
            row = self.store.operation(operation)
            self.store.quarantine(row["generation"], str(error))
        self._schedule_cleanup(operation)

    def _controller(self, message: dict[str, Any], principal: int) -> dict[str, Any]:
        if ("processHandleNamespace" in message and
                message["processHandleNamespace"] != self.store.process_handle_namespace):
            raise HostError("receipt_store_changed", "Original execution receipt store is unavailable")
        method = message.get("method")
        if method == "capabilities":
            return {"protocolVersion": 1, "runtime": "agenc-runc", "runcVersion": "1.5.1",
                    "processHandleNamespace": self.store.process_handle_namespace,
                    "features": ["exact_environment", "argv0", "output_cursors", "terminal_resize", "authority_close", "filesystem", "operation_indexes", "filesystem_original_guard", "filesystem_recursive_guard", "filesystem_directory_mutations", "filesystem_create_directory", "filesystem_bound_readlink", "filesystem_path_metadata", "filesystem_path_description", "held_task_files", "durable_process_handles", "detached_task_logs"]}
        if method == "bind":
            return {"binding": self.bind(message.get("container"))}
        if method == "allocate":
            operation, marker = self._allocate(message, principal)
            return {"operationId": operation, "marker": marker}
        if method == "launch":
            # This API owns Docker creation and attachment. The controller may
            # reconnect by operation identity, but cannot ask it to retry start.
            operation, marker = self._allocate(message, principal)
            execution = self._execution(operation)
            self.executions[operation] = execution
            try:
                execution.create(marker)
                execution.start()
            except Exception as error:
                self._receipt_failed(operation, error)
                raise HostError("unknown_outcome", "Inspect the original operation after Docker dispatch failure") from error
            return {"operationId": operation, "sessionId": self.store.operation(operation)["session_id"]}
        if method == "authorize":
            with self.filesystem_lock:
                previous = self.filesystems.get((principal, message["owner"]))
                if previous is not None and (previous["generation"] != message["generation"] or
                                              previous["revision"] > message["authorityRevision"]):
                    raise HostError("invalid_authority", "Session environment cannot be replaced or its authority rolled back")
                self.containment.authorize(principal, message["owner"], message["generation"],
                                           message["authorityRevision"])
                if previous is not None and previous["revision"] != message["authorityRevision"]:
                    try:
                        previous["worker"].close()
                    except HostError as error:
                        self.store.quarantine(message["generation"], str(error))
                        raise
                    del self.filesystems[(principal, message["owner"])]
            return {}
        if method == "filesystem":
            return self._filesystem(message, principal)
        if method == "filesystem_effect":
            return {"effect": self.store.filesystem_effect(message["generation"], principal, message["owner"], message["effect"])}
        if method == "inspect":
            row = self.store.operation(message["operationId"], principal, message["owner"])
            # Launch tokens, host PIDs and cgroup locations are never model data.
            public = {key: row[key] for key in
                                  ("id", "session_id", "generation", "owner", "run_id", "call_id", "attempt", "operation_index",
                                   "authority_revision", "state", "created_at", "exec_id",
                                   "runtime_exit", "exit_code", "leader_exited", "output_complete",
                                   "cleanup_proven", "residual_processes_terminated", "failure", "spec", "detached")}
            startup = self.detached_startups.get(row["id"])
            if startup is not None:
                receipt = startup.receipt()
                if receipt is not None:
                    public["detachedService"] = {"logPath": row["spec"]["detachedLogPath"], "startupState": receipt["state"],
                        **({"pid": row["task_pid"]} if receipt["state"] == "bootstrap_closed" and
                            row["task_pid"] == receipt["task_pid"] and row["leader_pid"] == receipt["peer_pid"] and
                            not row["leader_exited"] and not row["cleanup_proven"] else {}),
                        **({"error": receipt["error"]} if receipt["error"] else {})}
            return {"operation": public}
        if method == "lookup":
            # Canonical run/call/attempt identity recovers the original operation
            # even when the initial controller RPC reply was lost.
            with self.store.lock:
                row = self.store.db.execute("SELECT id FROM operations WHERE generation=? AND principal=? "
                                             "AND owner=? AND run_id=? AND call_id=? AND attempt=? AND operation_index=?",
                                             (message["generation"], principal, message["owner"],
                                              message["runId"], message["callId"], message["attempt"],
                                              operation_index(message.get("operationIndex", 0)))).fetchone()
            return {"operationId": None if row is None else row["id"]}
        if method == "call_operations":
            return {"operations": self.store.call_operations(message["generation"], principal, message["owner"], message,
                                                              message["kind"], message.get("after", -1), message.get("maximum", 128))}
        if method == "output":
            row = self.store.operation(message["operationId"], principal, message["owner"])
            return Execution.output(self.output_root, row["id"], message["offset"],
                                    message.get("maximum", 262144))
        if method == "decoded_output":
            row = self.store.operation(message["operationId"], principal, message["owner"])
            if row["detached"]:
                return self.detached_startups[row["id"]].output(message["offset"], message.get("maximum", 262144))
            return read_output(self.store, self.output_root, row["id"], message["offset"],
                               message.get("maximum", 262144))
        if method == "resize":
            row = self.store.operation(message["operationId"], principal, message["owner"])
            self.assert_generation(row["generation"])
            self.store.assert_authority(principal, message["owner"], row["generation"], message["authorityRevision"])
            execution = self.executions.get(row["id"])
            if execution is None:
                raise HostError("terminal_closed", "Original terminal is no longer attached")
            execution.resize(message["columns"], message["rows"])
            return {}
        if method == "input":
            row = self.store.operation(message["operationId"], principal, message["owner"])
            self.assert_generation(row["generation"])
            self.store.assert_authority(principal, message["owner"], row["generation"], message["authorityRevision"])
            execution = self.executions.get(row["id"])
            if execution is None:
                raise HostError("unknown_outcome", "Original stdin stream is not attached; input is never replayed")
            content = base64.b64decode(message["data"], validate=True)
            execution.write(message["inputId"], content, message.get("eof", False))
            return {"acknowledged": True}
        if method == "stop":
            return self.containment.stop(message["operationId"], principal, message["owner"])
        if method == "close":
            # Closing persists a launch/input fence before draining. A delayed
            # RPC cannot start work after an empty-scope observation.
            with self.filesystem_lock, self.store.lock:
                authority = self.store.db.execute("SELECT * FROM authorities WHERE principal=? AND owner=?",
                                                  (principal, message["owner"])).fetchone()
                if (authority is None or authority["generation"] != message["generation"] or
                        authority["revision"] != message["authorityRevision"]):
                    raise HostError("invalid_authority", "Cannot close another execution authority")
                self.store.db.execute("UPDATE authorities SET closed=1 WHERE principal=? AND owner=?",
                                      (principal, message["owner"]))
                rows = self.store.db.execute("SELECT id FROM operations WHERE principal=? AND owner=? "
                                             "AND (detached=0 OR state='allocated') AND cleanup_proven=0", (principal, message["owner"])).fetchall()
                for row in rows:
                    self.containment.stop(row["id"], principal, message["owner"])
                entry = self.filesystems.get((principal, message["owner"]))
                if entry is not None:
                    try:
                        entry["worker"].close()
                    except HostError as error:
                        self.store.quarantine(message["generation"], str(error))
                        raise
                    del self.filesystems[(principal, message["owner"])]
            return {"cleanupProven": True}
        raise HostError("invalid_request", "Unsupported controller operation")

    def _filesystem(self, message: dict[str, Any], principal: int) -> dict[str, Any]:
        owner, generation, revision = message["owner"], message["generation"], message["authorityRevision"]
        operation = message["operation"]
        with self.filesystem_lock:
            self.store.assert_authority(principal, owner, generation, revision)
            binding = self.assert_generation(generation)
            entry = self.filesystems.get((principal, owner))
            if operation == "connect":
                if entry is None:
                    worker = FilesystemWorker.start(Path("/opt/agenc-execution/bin/agenc-filesystem-worker"), binding)
                    entry = {"worker": worker, "generation": generation, "revision": revision,
                             "workerId": secrets.token_hex(16)}
                    self.filesystems[(principal, owner)] = entry
                if entry["generation"] != generation or entry["revision"] != revision:
                    raise HostError("stale_capability", "Previous filesystem authority has not closed")
                return {"workerId": entry["workerId"]}
            if (entry is None or entry["generation"] != generation or entry["revision"] != revision or
                    message.get("workerId") != entry["workerId"]):
                raise HostError("stale_capability", "Filesystem capability is stale or belongs to another session")
            worker = entry["worker"]
            arguments = message.get("arguments", {})
            if not isinstance(arguments, dict):
                raise HostError("invalid_request", "Filesystem arguments must be an object")
            effect_id = None
            if operation in ("write", "remove", "remove_symlink", "remove_directory", "rename_file", "create_directory"):
                effect_id = self.store.begin_filesystem_effect(generation, principal, owner, message["effect"],
                                                                {"workerId": entry["workerId"], "operation": operation,
                                                                 "arguments": arguments})
            try:
                if operation == "bind":
                    kind = {"file": KIND_FILE, "directory": KIND_DIRECTORY}.get(arguments["kind"])
                    if kind is None:
                        raise HostError("invalid_request", "Unsupported filesystem binding kind")
                    result = worker.bind(arguments["path"], kind, arguments.get("base", 0))
                elif operation == "bind_entry":
                    result = worker.bind_entry(arguments["base"], arguments["name"])
                elif operation == "readlink":
                    result = {"data": base64.b64encode(worker.readlink(arguments["handle"])).decode("ascii")}
                elif operation in ("read", "expected"):
                    read = worker.read if operation == "read" else worker.expected
                    content = read(arguments["handle"], arguments["offset"], arguments.get("maximum", 65536))
                    result = {"data": base64.b64encode(content).decode("ascii")}
                elif operation == "stat":
                    result = {"stats": worker.stat(arguments["handle"])}
                elif operation == "inspect_path":
                    result = {"stats": worker.inspect_path(arguments["path"], arguments.get("followSymlinks", True))}
                elif operation == "describe_path":
                    result = worker.describe_path(arguments["path"], arguments.get("followSymlinks", True))
                elif operation == "describe_handle":
                    result = worker.describe_handle(arguments["handle"])
                elif operation == "list":
                    result = {"entries": worker.list(arguments["handle"], arguments.get("maximum", 128))}
                elif operation == "capture":
                    result = worker.capture(arguments["path"])
                elif operation == "stage":
                    result = {"handle": worker.stage()}
                elif operation == "append":
                    worker.append(arguments["handle"], arguments["offset"], base64.b64decode(arguments["data"], validate=True))
                    result = {}
                elif operation == "seal":
                    worker.seal(arguments["handle"])
                    result = {}
                elif operation == "assert":
                    worker.assert_state(arguments["handle"], arguments["expected"])
                    result = {}
                elif operation == "assert_original":
                    worker.assert_original(arguments["handle"])
                    result = {}
                elif operation == "write":
                    result = {"stats": worker.write(arguments["handle"], arguments["expected"], arguments["content"])}
                elif operation == "remove":
                    worker.remove(arguments["handle"], arguments["expected"])
                    result = {}
                elif operation in ("remove_symlink", "remove_directory"):
                    remove = worker.remove_symlink if operation == "remove_symlink" else worker.remove_directory
                    remove(arguments["handle"], arguments["quarantine"])
                    result = {}
                elif operation == "create_directory":
                    worker.create_directory(arguments["handle"], arguments["name"], arguments["mode"])
                    result = {}
                elif operation == "rename_file":
                    result = {"stats": worker.rename_file(arguments["handle"], arguments["target"], arguments["expected"])}
                elif operation == "release":
                    worker.release(arguments["handle"])
                    result = {}
                else:
                    raise HostError("unsupported_operation", "Unsupported protected filesystem operation")
                if effect_id is not None:
                    self.store.settle_filesystem_effect(effect_id, {"ok": True, **result})
                return result
            except FilesystemError as error:
                if effect_id is not None:
                    self.store.settle_filesystem_effect(effect_id, {"ok": False, "code": error.code,
                                                                    "mutationStarted": error.mutation_started})
                raise
            except HostError as error:
                if error.code in ("worker_protocol", "worker_unavailable", "unknown_outcome"):
                    self.store.quarantine(generation, str(error))
                raise

    def _connection(self, channel: socket.socket, runtime: bool) -> None:
        with channel:
            channel.settimeout(30)
            try:
                pid, uid, _ = peer_credentials(channel)
                if (runtime and uid != 0) or (not runtime and uid not in self.controller_uids):
                    raise HostError("owner_denied", "Peer is not an authorized host controller")
                message = receive(channel)
                result = self._runtime(message, pid) if runtime else self._controller(message, uid)
                descriptors = result.pop("_descriptors", ()) if runtime else ()
                try:
                    send(channel, {"ok": True, **result}, descriptors)
                finally:
                    for fd in descriptors:
                        os.close(fd)
            except (HostError, OSError, KeyError, TypeError, ValueError) as error:
                try:
                    send(channel, {"ok": False, "code": getattr(error, "code", "host_failure"),
                                   "message": str(error)[:4096],
                                   **({"mutationStarted": error.mutation_started} if isinstance(error, FilesystemError) else {})})
                except (HostError, OSError):
                    pass

    def serve(self) -> None:
        # No dispatch occurs during recovery. Uncertain operations remain
        # inspectable and controller effect recovery decides their review state.
        self.containment.recover()
        with self.store.lock:
            services = self.store.db.execute("SELECT id,generation,exec_id FROM operations WHERE detached=1").fetchall()
        for service in services:
            operation, generation = service["id"], service["generation"]
            self.detached_startups[operation] = DetachedStartup(self.store, operation, None,
                lambda generation=generation: self.assert_generation(generation), self.output_root)
            if service["exec_id"] is not None:
                execution = self._execution(operation)
                self.executions[operation] = execution
                execution.recover()
        for name, runtime in (("runtime.sock", True), ("controller.sock", False)):
            path = self.socket_root / name
            path.unlink(missing_ok=True)
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(str(path))
            os.chmod(path, 0o600 if runtime else 0o660)
            if not runtime:
                os.chown(path, 0, self.controller_gid)
            listener.listen(64)
            listener.settimeout(0.2)
            self.listeners.append(listener)

            def accept(bound: socket.socket = listener, is_runtime: bool = runtime) -> None:
                while not self.stopping.is_set():
                    try:
                        channel, _ = bound.accept()
                    except socket.timeout:
                        continue
                    except OSError:
                        if self.stopping.is_set():
                            return
                        raise
                    thread = threading.Thread(target=self._connection, args=(channel, is_runtime), daemon=True)
                    thread.start()

            thread = threading.Thread(target=accept, daemon=True)
            self.threads.append(thread)
            thread.start()
        self.stopping.wait()

    def close(self) -> None:
        self.stopping.set()
        for listener in self.listeners:
            listener.close()
        for receipt in self.pidfds.values():
            receipt.close()
        for execution in self.executions.values():
            execution.closed.set()
        for startup in self.detached_startups.values():
            startup.close()
        with self.store.lock:
            for operation in tuple(self.launch_files):
                self._release_launch_files(operation)
        with self.filesystem_lock:
            for entry in self.filesystems.values():
                entry["worker"].close()
        for thread in self.threads:
            thread.join(timeout=1)
        # Unfinished operational receipts are recovered by the next supervisor.
        # Shutdown does not fabricate a canonical outcome or repeat a command.


def read_config(path: Path) -> dict[str, Any]:
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        identity = os.fstat(fd)
        if identity.st_uid != 0 or identity.st_mode & 0o022 or not stat.S_ISREG(identity.st_mode):
            raise HostError("invalid_configuration", "Host configuration must be a protected root-owned file")
        value = decode_json(os.read(fd, 65537))
        if identity.st_size > 65536 or not isinstance(value, dict):
            raise HostError("invalid_configuration", "Host configuration exceeds its bound")
        return value
    finally:
        os.close(fd)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="/etc/agenc-execution/host.json")
    arguments = parser.parse_args()
    if os.geteuid() != 0:
        raise HostError("unsupported_host", "Execution supervision runs as root on the Docker daemon host")
    configuration = read_config(Path(arguments.config))
    runc = Path(configuration["runcPath"])
    if hashlib.sha256(runc.read_bytes()).hexdigest() != configuration["runcSha256"]:
        raise HostError("invalid_runtime", "Pinned runc content does not match installation")
    version = subprocess.run([str(runc), "--version"], check=True, capture_output=True,
                             timeout=10, env={"PATH": "/usr/bin:/bin"}).stdout.decode("utf-8")
    if version.splitlines()[0] != "runc version 1.5.1":
        raise HostError("invalid_runtime", "Execution host requires qualified runc 1.5.1")
    state_root = Path(configuration["stateRoot"])
    socket_root = Path(configuration["socketRoot"])
    launch_root = Path(configuration["launchRoot"])
    for root in (state_root, socket_root, launch_root):
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        current = root.lstat()
        if current.st_uid != 0 or current.st_mode & 0o022 or not stat.S_ISDIR(current.st_mode):
            raise HostError("invalid_configuration", "Host authority directories must be root-owned and protected")
    # Controllers may traverse the socket directory but cannot replace entries.
    os.chown(socket_root, 0, configuration["controllerGid"])
    os.chmod(socket_root, 0o750)
    supervisor = Supervisor(
        state_root=state_root, socket_root=socket_root, launch_root=launch_root,
        docker=DockerAPI(configuration["dockerSocket"]),
        protected_roots=tuple(Path(path) for path in configuration["protectedRoots"]),
        controller_uids=frozenset(configuration["controllerUids"]),
        controller_gid=configuration["controllerGid"])
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: supervisor.stopping.set())
    try:
        supervisor.serve()
    finally:
        supervisor.close()


if __name__ == "__main__":
    main()
