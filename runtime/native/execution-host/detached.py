"""Detached task startup and log handles. No task stdio depends on host pipes."""

from __future__ import annotations

import array
import base64
import hashlib
import os
import socket
import stat
import struct
import threading
from pathlib import Path
from typing import Any, Callable

from execution import Execution
from filesystem import FilesystemWorker, _reopen
from leases import LeaseStore
from protocol import HostError
from output import create_output_file


class DetachedStartup:
    def __init__(self, store: LeaseStore, operation: str, channel: socket.socket | None,
                 binding: Callable[[], dict[str, Any]], output_root: Path):
        self.store = store
        self.operation = operation
        self.channel = channel
        self.binding = binding
        self.log_fd = -1
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.error: Exception | None = None
        self.thread: threading.Thread | None = None
        self.output_path = output_root / (operation + ".detached-output")
        self.mirror_fd = -1
        if channel is None:
            row = self.receipt()
            if row is None or row["state"] != "bootstrap_closed":
                self.error = HostError("unknown_outcome", "Original detached startup acknowledgement is unavailable")
            self.ready.set()
            try:
                self.mirror_fd = os.open(self.output_path, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
            except OSError as error:
                self.error = error
        else:
            with store.lock:
                store.db.execute("INSERT INTO detached_startups(operation_id,state) VALUES(?,'waiting')", (operation,))
            self.mirror_fd = create_output_file(self.output_path, readable=True)
            self.thread = threading.Thread(target=self._receive, daemon=True)
            try:
                self.thread.start()
            except BaseException:
                os.close(self.mirror_fd)
                self.mirror_fd = -1
                channel.close()
                raise

    def receipt(self) -> dict[str, Any] | None:
        with self.store.lock:
            row = self.store.db.execute("SELECT * FROM detached_startups WHERE operation_id=?", (self.operation,)).fetchone()
            return None if row is None else dict(row)

    def _record(self, state: str, **fields: Any) -> None:
        if not fields.keys() <= {"task_pid", "peer_pid", "log_dev", "log_ino", "log_mode", "error"}:
            raise ValueError("Invalid detached startup receipt")
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            try:
                suffix = "".join("," + key + "=?" for key in fields)
                self.store.db.execute("UPDATE detached_startups SET state=?" + suffix + " WHERE operation_id=?",
                                      (state, *fields.values(), self.operation))
                self.store._receipt(self.operation, "detached_" + state, fields)
                self.store.db.execute("COMMIT")
            except BaseException:
                self.store.db.execute("ROLLBACK")
                raise

    def _receive(self) -> None:
        prepared = False
        assert self.channel is not None
        try:
            self.channel.settimeout(30)
            while True:
                descriptors: list[int] = []
                try:
                    payload, ancillary, flags, _ = self.channel.recvmsg(12, socket.CMSG_SPACE(4) + socket.CMSG_SPACE(12), socket.MSG_CMSG_CLOEXEC)
                    credentials = None
                    for level, kind, value in ancillary:
                        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                            fds = array.array("i")
                            fds.frombytes(value[:len(value) - len(value) % fds.itemsize])
                            descriptors.extend(fds)
                        elif level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(value) == 12:
                            credentials = struct.unpack("3i", value)
                    if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
                        raise HostError("startup_protocol", "Detached startup packet exceeds its bound")
                    if not payload:
                        if not prepared or descriptors:
                            raise HostError("unknown_outcome", "Detached launcher closed without its original log receipt")
                        self._record("bootstrap_closed")
                        return
                    if len(payload) != 12 or credentials is None or credentials[0] <= 0 or credentials[1:] != (0, 0):
                        raise HostError("startup_protocol", "Detached startup lacks kernel sender credentials")
                    magic, kind, value = struct.unpack("!4sII", payload)
                    if magic != b"ADS1":
                        raise HostError("startup_protocol", "Invalid detached startup frame")
                    if kind == 2 and not descriptors and 0 < value < 4096:
                        raise HostError("create_process", "Detached task bootstrap failed: " + os.strerror(value))
                    if kind != 1 or prepared or len(descriptors) != 1 or value < 1:
                        raise HostError("startup_protocol", "Invalid or duplicate detached log receipt")
                    original = os.fstat(descriptors[0])
                    if not stat.S_ISREG(original.st_mode):
                        raise HostError("startup_protocol", "Detached output must be an ordinary task file")
                    reopened = _reopen(descriptors[0], os.O_RDONLY)
                    with self.lock:
                        self.log_fd = reopened
                    self._record("prepared", task_pid=value, peer_pid=credentials[0], log_dev=str(original.st_dev),
                                 log_ino=str(original.st_ino), log_mode=original.st_mode)
                    prepared = True
                finally:
                    for fd in descriptors:
                        os.close(fd)
        except Exception as error:
            self.error = error
            self._record("failed", error=str(error))
        finally:
            self.channel.close()
            self.ready.set()

    def _restore_log(self) -> int:
        original = self.receipt()
        if original is None or original["log_ino"] is None:
            raise HostError("output_unavailable", "Original detached log identity is unavailable")
        row = self.store.operation(self.operation)
        worker = FilesystemWorker.start(Path("/opt/agenc-execution/bin/agenc-filesystem-worker"), self.binding())
        fd = -1
        try:
            bound = worker.bind(row["spec"]["detachedLogPath"])
            fd, _ = worker.export_stream(bound["handle"])
            actual = os.fstat(fd)
            if (str(actual.st_dev), str(actual.st_ino), actual.st_mode) != (original["log_dev"], original["log_ino"], original["log_mode"]):
                raise HostError("output_unavailable", "Original detached log was replaced")
            result, fd = fd, -1
            return result
        finally:
            if fd >= 0:
                os.close(fd)
            worker.close()

    def _capture(self, until: int) -> int:
        original = self.receipt()
        retained = 0 if original is None else original["mirrored_length"]
        if self.mirror_fd < 0 or os.fstat(self.mirror_fd).st_size != retained:
            raise HostError("output_unavailable", "Original detached output has an unsettled or missing retention receipt")
        if until <= retained:
            return retained
        if self.log_fd < 0:
            if not self.ready.is_set():
                return retained
            self.log_fd = self._restore_log()
        if os.fstat(self.log_fd).st_size < retained:
            raise HostError("output_unavailable", "Detached task log was truncated; retained output remains inspectable")
        while retained < until:
            content = os.pread(self.log_fd, min(65536, until - retained), retained)
            if not content:
                break
            if retained + len(content) > 256 * 1024 * 1024:
                raise HostError("output_limit", "Detached operational output exceeded its 256 MiB bound")
            copied = 0
            while copied < len(content):
                written = os.pwrite(self.mirror_fd, content[copied:], retained + copied)
                if written <= 0:
                    raise HostError("output_unavailable", "Detached output retention failed")
                copied += written
            os.fsync(self.mirror_fd)
            with self.store.lock:
                self.store.db.execute("BEGIN IMMEDIATE")
                try:
                    self.store.db.execute("UPDATE detached_startups SET mirrored_length=? WHERE operation_id=?", (retained + len(content), self.operation))
                    self.store._receipt(self.operation, "detached_output_retained", {
                        "offset": retained, "length": len(content), "sha256": hashlib.sha256(content).hexdigest()})
                    self.store.db.execute("COMMIT")
                except BaseException:
                    self.store.db.execute("ROLLBACK")
                    raise
            retained += len(content)
        return retained

    def capture_final_output(self) -> None:
        with self.lock:
            self._capture(256 * 1024 * 1024 + 1)

    def output(self, offset: int, maximum: int) -> dict[str, Any]:
        if type(offset) is not int or offset < 0 or type(maximum) is not int or not 1 <= maximum <= 262144:
            raise HostError("invalid_request", "Invalid detached log cursor")
        with self.lock:
            original = self.receipt()
            if offset > (0 if original is None else original["mirrored_length"]):
                raise HostError("invalid_request", "Detached cursor exceeds previously retained output")
            try:
                retained = self._capture(offset + maximum)
            except (HostError, OSError):
                original = self.receipt()
                retained = 0 if original is None else original["mirrored_length"]
                # Preserve the prefix already fsynced and acknowledged on the
                # host, even when the task log or its environment is gone.
                if offset >= retained or self.mirror_fd < 0 or os.fstat(self.mirror_fd).st_size < retained:
                    raise
            if offset > retained:
                raise HostError("invalid_request", "Detached cursor exceeds retained output")
            content = os.pread(self.mirror_fd, min(maximum, retained - offset), offset)
        return {"stdout": base64.b64encode(content).decode("ascii"), "stderr": "", "nextOffset": offset + len(content)}

    def close(self) -> None:
        if self.channel is not None and not self.ready.is_set():
            try:
                self.channel.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        if self.thread is not None and self.thread is not threading.current_thread():
            self.thread.join(timeout=1)
        with self.lock:
            if self.log_fd >= 0:
                os.close(self.log_fd)
                self.log_fd = -1
            if self.mirror_fd >= 0:
                os.close(self.mirror_fd)
                self.mirror_fd = -1


class DetachedExecution(Execution):
    def __init__(self, *args: Any, startup: DetachedStartup, finish_scope: Callable[[], bool], **kwargs: Any):
        super().__init__(*args, **kwargs)
        self.startup = startup
        self.finish_scope = finish_scope

    def start(self) -> None:
        row = self._prepare_start()
        self.thread = threading.Thread(target=self._run_detached, args=(row, True), daemon=True)
        self.thread.start()

    def recover(self) -> None:
        row = self.store.operation(self.operation)
        self.thread = threading.Thread(target=self._run_detached, args=(row, False), daemon=True)
        self.thread.start()

    def _run_detached(self, row: dict[str, Any], dispatch: bool) -> None:
        try:
            if dispatch:
                self.docker.request("POST", f"/exec/{row['exec_id']}/start", {"Detach": True, "Tty": False})
                self._record("detached_docker_start_acknowledged")
            if not self.startup.ready.wait(30):
                raise HostError("unknown_outcome", "Detached native startup acknowledgement timed out")
            if self.startup.error is not None:
                self._record("detached_start_unknown", failure=str(self.startup.error))
            self.ready.set()
            if not dispatch and row["runtime_pid"] is None:
                # Docker may report ExitCode=0 for an exec that was created but
                # never started. A revoked unclaimed lease is not a zero exit.
                return
            terminal_recorded = False
            while not self.closed.is_set():
                inspected = self.docker.request("GET", f"/exec/{row['exec_id']}/json")
                if inspected.get("Running") is False and type(inspected.get("ExitCode")) is int:
                    if not terminal_recorded:
                        self._record("detached_leader_exit_observed", exit_code=inspected["ExitCode"], leader_exited=1)
                        terminal_recorded = True
                    # A daemon may outlive its original leader. Its descendants
                    # retain environment lifetime even when the leader exits.
                    if self.finish_scope():
                        self.startup.capture_final_output()
                        self._record("detached_output_complete", output_complete=1)
                        return
                self.closed.wait(.1)
        except Exception as error:
            self._record("detached_unknown_outcome", failure=str(error))
        finally:
            self.ready.set()

    def write(self, input_id: str, content: bytes, eof: bool = False) -> None:
        raise HostError("stdin_closed", "Detached services use closed task stdin")

    def resize(self, columns: int, rows: int) -> None:
        raise HostError("unsupported_operation", "Detached services have no terminal")
