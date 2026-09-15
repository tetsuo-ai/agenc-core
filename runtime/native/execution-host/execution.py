"""Supervisor-owned Docker dispatch and durable operational input/output.

Reconnecting clients inspect a stable operation and byte offset. Neither a lost
start reply nor an unacknowledged input causes another Docker exec or write.
"""

from __future__ import annotations

import base64
import hashlib
import os
import select
import socket
import threading
from pathlib import Path
from typing import Any, Callable

from docker_api import DockerAPI
from leases import LeaseStore
from output import OutputIndex, record_output, create_output_file
from protocol import HostError, LEASE_ENV, encode_json, peer_credentials
from task_files import has_file


class Execution:
    def __init__(self, operation: str, store: LeaseStore, docker: DockerAPI, output_root: Path,
                 on_failure: Callable[[], None]):
        self.operation = operation
        self.store = store
        self.docker = docker
        self.output_path = output_root / (operation + ".output")
        self.on_failure = on_failure
        self.input_lock = threading.Lock()
        self.ready = threading.Event()
        self.closed = threading.Event()
        self.channel: socket.socket | None = None
        self.thread: threading.Thread | None = None

    def create(self, marker: str) -> str:
        with self.store.lock:
            row = self.store.operation(self.operation)
            if row["state"] != "allocated" or row["exec_id"] is not None:
                raise HostError("operation_exists", "Inspect the original Docker execution")
            # A receipt is committed before crossing Docker's creation boundary.
            # Recovery never re-enters this method after a lost acknowledgement.
            previous = self.store.db.execute("SELECT 1 FROM receipts WHERE operation_id=? "
                                             "AND kind='exec_create_intent'", (self.operation,)).fetchone()
            if previous is not None:
                raise HostError("unknown_outcome", "Docker exec creation acknowledgement is unknown")
            self.store.transition(self.operation, ("allocated",), "allocated", "exec_create_intent")
            binding = self.store.environment(row["generation"])
        spec = row["spec"]
        result = self.docker.request("POST", f"/containers/{binding['containerId']}/exec", {
            "AttachStdin": not bool(row["detached"]), "AttachStdout": not bool(row["detached"]), "AttachStderr": not bool(row["detached"]),
            "Tty": spec["terminal"], "Cmd": spec["args"], "WorkingDir": "/" if has_file(spec, "cwd") else spec["cwd"],
            "User": "0:0", "Privileged": False, "Env": [*spec["env"], LEASE_ENV + "=" + marker],
        })
        exec_id = result.get("Id")
        if not isinstance(exec_id, str) or len(exec_id) != 64 or any(c not in "0123456789abcdef" for c in exec_id):
            raise HostError("unknown_outcome", "Docker exec creation returned no immutable identity")
        with self.store.lock:
            current = self.store.operation(self.operation)
            self.store.transition(self.operation, (current["state"],), current["state"],
                                  "exec_created", exec_id=exec_id)
        return exec_id

    def _prepare_start(self) -> dict[str, Any]:
        with self.store.lock:
            row = self.store.operation(self.operation)
            if row["state"] != "allocated" or row["exec_id"] is None:
                raise HostError("invalid_transition", "Execution cannot cross dispatch in its current state")
            previous = self.store.db.execute("SELECT 1 FROM receipts WHERE operation_id=? "
                                             "AND kind='exec_start_intent'", (self.operation,)).fetchone()
            if previous is not None:
                raise HostError("unknown_outcome", "Docker start acknowledgement is unknown; inspect the original operation")
            self.store.transition(self.operation, ("allocated",), "allocated", "exec_start_intent")
        return row

    def start(self) -> None:
        row = self._prepare_start()
        # Opening the output destination is controller-host work. Task paths
        # cannot select or replace this operational evidence file.
        fd = create_output_file(self.output_path)
        self.thread = threading.Thread(target=self._run, args=(row, fd), daemon=True)
        try:
            self.thread.start()
        except BaseException:
            os.close(fd)
            raise

    def _record(self, kind: str, **fields: Any) -> None:
        with self.store.lock:
            row = self.store.operation(self.operation)
            self.store.transition(self.operation, (row["state"],), row["state"], kind, **fields)

    def _run(self, row: dict[str, Any], output_fd: int) -> None:
        channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        daemon_pidfd = -1
        index = OutputIndex(row["spec"]["terminal"])
        try:
            channel.settimeout(30)
            channel.connect(self.docker.socket_path)
            daemon_pid, _, _ = peer_credentials(channel)
            daemon_pidfd = os.pidfd_open(daemon_pid)
            payload = encode_json({"Detach": False, "Tty": row["spec"]["terminal"]})
            headers = (f"POST /exec/{row['exec_id']}/start HTTP/1.1\r\n"
                       "Host: localhost\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n"
                       "Content-Type: application/json\r\n"
                       f"Content-Length: {len(payload)}\r\n\r\n").encode("ascii")
            channel.sendall(headers + payload)
            response = bytearray()
            while b"\r\n\r\n" not in response:
                part = channel.recv(4096)
                if not part:
                    raise HostError("unknown_outcome", "Docker disconnected before acknowledging stream attachment")
                response.extend(part)
                if len(response) > 65536:
                    raise HostError("unknown_outcome", "Docker stream headers exceed their bound")
            head, initial = bytes(response).split(b"\r\n\r\n", 1)
            status = head.split(b"\r\n", 1)[0].split(b" ")[1]
            if status not in (b"101", b"200") or b"transfer-encoding:" in head.lower():
                raise HostError("unknown_outcome", "Docker did not acknowledge a raw exec stream")
            self.channel = channel
            self._record("stream_attached")
            self.ready.set()
            pending = initial
            total = 0
            while True:
                if pending:
                    total += len(pending)
                    if total > 256 * 1024 * 1024:
                        raise HostError("output_limit", "Operational output exceeded the 256 MiB command limit")
                    view = memoryview(pending)
                    while view:
                        written = os.write(output_fd, view)
                        if written <= 0:
                            raise HostError("output_unavailable", "Operational output could not be persisted")
                        view = view[written:]
                    os.fsync(output_fd)
                    record_output(self.store, self.operation, index.feed(pending))
                if self.closed.is_set():
                    raise HostError("unknown_outcome", "Operational stream closed before output completed")
                if not select.select([channel], [], [], .2)[0]:
                    pending = b""
                    continue
                pending = channel.recv(65536)
                if not pending:
                    break
            index.finish()
            if select.select([daemon_pidfd], [], [], 0)[0]:
                raise HostError("unknown_outcome", "Docker daemon died before output settlement")
            inspected = self.docker.request("GET", f"/exec/{row['exec_id']}/json")
            if (select.select([daemon_pidfd], [], [], 0)[0] or inspected.get("Running") is not False or
                    type(inspected.get("ExitCode")) is not int):
                raise HostError("unknown_outcome", "Docker stream ended without a terminal execution receipt")
            self._record("docker_exit_observed", exit_code=inspected["ExitCode"], output_complete=1)
        except Exception as error:
            self._record("stream_unknown_outcome", failure=str(error))
            self.on_failure()
        finally:
            self.closed.set()
            self.ready.set()
            channel.close()
            os.close(output_fd)
            if daemon_pidfd >= 0:
                os.close(daemon_pidfd)

    def resize(self, columns: int, rows: int) -> None:
        if any(type(value) is not int or not 1 <= value <= 65535 for value in (columns, rows)):
            raise HostError("invalid_request", "Terminal dimensions are outside their bound")
        row = self.store.operation(self.operation)
        if not row["spec"]["terminal"]:
            raise HostError("unsupported_operation", "Execution has no terminal")
        if not self.ready.wait(timeout=30) or self.closed.is_set() or row["exec_id"] is None:
            raise HostError("terminal_closed", "Original execution terminal is unavailable")
        self.docker.request("POST", f"/exec/{row['exec_id']}/resize?h={rows}&w={columns}")

    def write(self, input_id: str, content: bytes, eof: bool = False) -> None:
        if has_file(self.store.operation(self.operation)["spec"], "stdin"):
            raise HostError("unsupported_operation", "Original execution stdin is a bound task file")
        if len(content) > 1024 * 1024 or type(eof) is not bool:
            raise HostError("invalid_request", "Input exceeds its bound or has an invalid EOF flag")
        digest = hashlib.sha256(bytes([int(eof)]) + content).hexdigest()
        with self.input_lock:
            # Preserve the original acknowledgement even if the stream has since
            # ended. Pending intents remain unknown and never resend their data.
            with self.store.lock:
                previous = self.store.db.execute("SELECT 1 FROM inputs WHERE operation_id=? AND input_id=?",
                                                 (self.operation, input_id)).fetchone()
            if previous is not None:
                self.store.begin_input(self.operation, input_id, digest)
                return
            if not self.ready.wait(timeout=30) or self.channel is None or self.closed.is_set():
                raise HostError("stdin_closed", "Original execution stream is unavailable for input")
            if not self.store.begin_input(self.operation, input_id, digest):
                return
            try:
                if content:
                    self.channel.sendall(content)
                if eof:
                    self.channel.shutdown(socket.SHUT_WR)
            except OSError as error:
                raise HostError("unknown_outcome", "Input may have reached the task; it is not repeated") from error
            self.store.acknowledge_input(self.operation, input_id)

    @staticmethod
    def output(output_root: Path, operation: str, offset: int, maximum: int = 262144) -> dict[str, Any]:
        if type(offset) is not int or offset < 0 or type(maximum) is not int or not 1 <= maximum <= 262144:
            raise HostError("invalid_request", "Invalid bounded output cursor")
        try:
            fd = os.open(output_root / (operation + ".output"), os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        except FileNotFoundError:
            if offset != 0:
                raise HostError("output_unavailable", "Original output is unavailable at that cursor")
            return {"data": "", "nextOffset": 0}
        try:
            size = os.fstat(fd).st_size
            if offset > size:
                raise HostError("invalid_request", "Output cursor exceeds retained evidence")
            content = os.pread(fd, maximum, offset)
            return {"data": base64.b64encode(content).decode("ascii"), "nextOffset": offset + len(content)}
        finally:
            os.close(fd)
