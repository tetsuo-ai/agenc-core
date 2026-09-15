"""Descriptor-bound command scopes and a separate fence for runtime launches."""

from __future__ import annotations

import os
import select
import stat
import time
from pathlib import Path

from protocol import HostError


class Scope:
    def __init__(self, path: Path, expected_identity: tuple[int, int] | None = None):
        self.path = path
        self.fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        current = os.fstat(self.fd)
        self.identity = (current.st_dev, current.st_ino)
        if expected_identity is not None and self.identity != expected_identity:
            self.close()
            raise HostError("scope_changed", "Command cgroup identity changed")
        # Opening these files also rejects ordinary directories and unsupported kernels.
        try:
            self._read("cgroup.events")
            fd = os.open("cgroup.kill", os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
                         dir_fd=self.fd)
            os.close(fd)
        except BaseException:
            self.close()
            raise

    @classmethod
    def create(cls, parent: Path, name: str) -> Scope:
        if not name or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in name):
            raise HostError("invalid_scope", "Invalid host scope name")
        os.mkdir(parent / name, 0o700)
        return cls(parent / name)

    def _read(self, name: str) -> str:
        fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=self.fd)
        try:
            value = os.read(fd, 65537)
            if len(value) > 65536:
                raise HostError("scope_unreadable", "Cgroup metadata exceeds its bound")
            return value.decode("ascii")
        finally:
            os.close(fd)

    def _write(self, name: str, data: bytes) -> None:
        fd = os.open(name, os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=self.fd)
        try:
            if os.write(fd, data) != len(data):
                raise HostError("cleanup_unproven", "Short cgroup control write")
        finally:
            os.close(fd)

    def assert_current(self) -> None:
        current = os.stat(self.path, follow_symlinks=False)
        if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != self.identity:
            raise HostError("scope_changed", "Command cgroup is missing or was replaced")

    def populated(self) -> bool:
        events = dict(line.split() for line in self._read("cgroup.events").splitlines())
        if events.get("populated") not in ("0", "1"):
            raise HostError("cleanup_unproven", "Cgroup population is unknown")
        return events["populated"] == "1"

    def attach(self, pid: int) -> None:
        if pid <= 1:
            raise HostError("invalid_peer", "Cannot attach an invalid runtime peer")
        # pidfd pins the peer identity while it is moved before its first fork.
        pidfd = os.pidfd_open(pid)
        try:
            if select.select([pidfd], [], [], 0)[0]:
                raise HostError("invalid_peer", "Runtime peer exited before claim")
            self._write("cgroup.procs", str(pid).encode("ascii"))
            if select.select([pidfd], [], [], 0)[0]:
                raise HostError("invalid_peer", "Runtime peer exited during claim")
        finally:
            os.close(pidfd)

    def kill_and_wait(self, deadline: float) -> None:
        self.assert_current()
        self._write("cgroup.kill", b"1")
        while self.populated():
            if time.monotonic() >= deadline:
                raise HostError("cleanup_unproven", "Cgroup did not become empty before deadline")
            time.sleep(0.01)

    def close(self) -> None:
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1


def cleanup_scopes(launch: Scope, command: Scope, timeout: float = 10) -> bool:
    """Call only after atomically fencing further claims in the lease store.

    Empty command scope before the launch fence is closed proves nothing. Kill
    runtime launchers first and observe their complete subtree empty, then kill
    commands including any process that runc moved while the fence was closing.
    """
    deadline = time.monotonic() + timeout
    launch.kill_and_wait(deadline)
    populated = command.populated()
    command.kill_and_wait(deadline)
    return populated
