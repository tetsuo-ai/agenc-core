"""Private transport to the immutable native filesystem worker.

The worker retains task-only descriptors. Reopening an O_PATH descriptor is
mediated here via SCM_RIGHTS: inspect its type first, then reopen that *same*
file description through this host process's private fd namespace. No task
pathname is resolved on the host, and special resources are never opened for I/O.
"""

from __future__ import annotations

import array
import ctypes
import errno
import os
import select
import socket
import stat
import struct
import threading
import time
from pathlib import Path
from typing import Any

from protocol import HostError

PACKET_LIMIT = 128 * 1024
CHUNK_LIMIT = 64 * 1024
REOPEN_STATUS = 0xFFFFFFFF
WORKER_PROTOCOL_VERSION = 9
KIND_FILE, KIND_DIRECTORY, KIND_GUARD, KIND_CONTENT = 1, 2, 3, 4
SPECIAL_FILESYSTEMS = {0x9FA0, 0x62656572, 0x27E0EB, 0x63677270, 0x1CD1,
                       0x64626720, 0x74726163, 0xCAFE4A11, 0x6E736673,
                       0x73636673, 0x50495045, 0x19800202}
_libc = ctypes.CDLL(None, use_errno=True)
_libc.fstatfs.argtypes = (ctypes.c_int, ctypes.c_void_p)
_libc.fstatfs.restype = ctypes.c_int


class FilesystemError(HostError):
    def __init__(self, number: int, mutation_started: bool = False):
        codes = {errno.ESTALE: "path_conflict", errno.ENOENT: "not_found",
                 errno.EOPNOTSUPP: "unsupported_resource", errno.EFBIG: "file_limit",
                 errno.EACCES: "permission_denied", errno.EPERM: "permission_denied",
                 errno.EEXIST: "path_conflict", errno.ELOOP: "path_conflict"}
        super().__init__(codes.get(number, "filesystem_failure"), os.strerror(number))
        self.number = number
        self.mutation_started = mutation_started


def _u32(value: int) -> bytes:
    if type(value) is not int or not 0 <= value <= 0xFFFFFFFF:
        raise HostError("invalid_request", "Filesystem integer is outside its bound")
    return struct.pack("!I", value)


def _string(value: str) -> bytes:
    if not isinstance(value, str) or "\0" in value:
        raise HostError("invalid_request", "Filesystem paths must be NUL-free strings")
    content = value.encode("utf-8")
    if len(content) >= 16384:
        raise HostError("invalid_request", "Filesystem path exceeds its bound")
    return _u32(len(content)) + content


def _stats(content: bytes) -> dict[str, Any]:
    if len(content) != 44:
        raise HostError("worker_protocol", "Invalid native filesystem metadata")
    device, inode, mode, size, modified, changed = struct.unpack("!QQIQqq", content)
    return {"dev": str(device), "ino": str(inode), "mode": str(mode), "size": size,
            "mtimeMs": modified / 1000000, "ctimeMs": changed / 1000000}


def _description(content: bytes) -> dict[str, Any]:
    if len(content) < 65:
        raise HostError("worker_protocol", "Invalid native path description")
    device, inode, mode, links, size, modified, modified_ns, changed, changed_ns, length = struct.unpack("!QQIQQqIqII", content[:64])
    if length != len(content) - 64 or length >= 16384 or max(modified_ns, changed_ns) >= 1000000000:
        raise HostError("worker_protocol", "Invalid native canonical path length")
    try:
        path = content[64:].decode("utf-8")
    except UnicodeDecodeError as error:
        raise HostError("unsupported_resource", "Task canonical path is not UTF-8") from error
    if not path.startswith("/") or "\0" in path:
        raise HostError("worker_protocol", "Invalid native canonical path")
    return {"canonicalPath": path, "identity": {"dev": str(device), "ino": str(inode), "mode": str(mode),
            "size": str(size), "mtimeNs": str(modified * 1000000000 + modified_ns),
            "ctimeNs": str(changed * 1000000000 + changed_ns), "nlink": str(links)}}


def _reopen(fd: int, flags: int) -> int:
    original = os.fstat(fd)
    if flags not in (os.O_RDONLY, os.O_RDWR):
        raise OSError(errno.EINVAL, "Invalid private reopen flags")
    if not stat.S_ISREG(original.st_mode) and not (stat.S_ISDIR(original.st_mode) and flags == os.O_RDONLY):
        raise OSError(errno.EOPNOTSUPP, "Special filesystem resources are not supported")
    metadata = ctypes.create_string_buffer(256)
    if _libc.fstatfs(fd, metadata) != 0:
        raise OSError(ctypes.get_errno(), "Cannot inspect descriptor filesystem")
    kind = ctypes.c_long.from_buffer(metadata).value & 0xFFFFFFFF
    if kind in SPECIAL_FILESYSTEMS:
        raise OSError(errno.EOPNOTSUPP, "Kernel filesystem resources are not supported")
    reopened = os.open(f"/proc/self/fd/{fd}", flags | os.O_CLOEXEC | os.O_NONBLOCK)
    current = os.fstat(reopened)
    if (original.st_dev, original.st_ino, original.st_mode) != (current.st_dev, current.st_ino, current.st_mode):
        os.close(reopened)
        raise OSError(errno.ESTALE, "Descriptor identity changed")
    return reopened


class FilesystemWorker:
    def __init__(self, channel: socket.socket, pid: int):
        self.channel = channel
        self.pid = pid
        self.lock = threading.Lock()
        self.sequence = 0
        self.closed = False
        self.channel.settimeout(30)

    @classmethod
    def start(cls, program: Path, binding: dict[str, Any]) -> FilesystemWorker:
        identity = program.lstat()
        if identity.st_uid != 0 or identity.st_mode & 0o022 or not stat.S_ISREG(identity.st_mode):
            raise HostError("invalid_worker", "Filesystem worker must be an immutable root-owned native binary")
        with program.open("rb") as executable:
            if executable.read(4) != b"\x7fELF":
                raise HostError("invalid_worker", "Protected filesystem worker is not a native ELF executable")
        pidfd = os.pidfd_open(binding["initPid"])
        root = namespace = -1
        parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        worker: FilesystemWorker | None = None
        try:
            process = Path("/proc") / str(binding["initPid"])
            root = os.open(process / "root", os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
            namespace = os.open(process / "ns/mnt", os.O_RDONLY | os.O_CLOEXEC)
            root_stat = os.fstat(root)
            if ([root_stat.st_dev, root_stat.st_ino] != binding["rootIdentity"] or
                    os.fstat(namespace).st_ino != binding["namespaces"]["mnt"] or
                    select.select([pidfd], [], [], 0)[0]):
                raise HostError("environment_changed", "Task changed before filesystem authority was pinned")
            # posix_spawn avoids executing Python callbacks after fork in a
            # multithreaded supervisor. Only the private socket crosses exec.
            actions = [(os.POSIX_SPAWN_DUP2, child.fileno(), 3),
                       (os.POSIX_SPAWN_OPEN, 0, "/dev/null", os.O_RDONLY, 0),
                       (os.POSIX_SPAWN_OPEN, 1, "/dev/null", os.O_WRONLY, 0),
                       (os.POSIX_SPAWN_OPEN, 2, "/dev/null", os.O_WRONLY, 0)]
            pid = os.posix_spawn(str(program), [str(program)], {"PATH": "/usr/bin:/bin"}, file_actions=actions)
            worker = cls(parent, pid)
            child.close()
            parent.sendmsg([b"AFS1"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [root, namespace]))])
            hello = worker._receive(0)
            if hello != _u32(WORKER_PROTOCOL_VERSION):
                raise HostError("invalid_worker", "Protected filesystem worker protocol does not match its supervisor")
            if select.select([pidfd], [], [], 0)[0]:
                raise HostError("environment_changed", "Filesystem worker bootstrap was not established")
            if os.stat(f"/proc/{pid}/ns/pid").st_ino != os.stat("/proc/self/ns/pid").st_ino:
                raise HostError("invalid_worker", "Filesystem worker joined a task PID namespace")
            return worker
        except BaseException:
            if worker is not None:
                worker.close()
            else:
                parent.close()
            raise
        finally:
            child.close()
            for fd in (root, namespace, pidfd):
                if fd >= 0:
                    os.close(fd)

    def _receive(self, request_id: int, descriptor: bool = False) -> Any:
        while True:
            data, ancillary, flags, _ = self.channel.recvmsg(PACKET_LIMIT, socket.CMSG_SPACE(4 * 4), socket.MSG_CMSG_CLOEXEC)
            fds = array.array("i")
            try:
                for level, kind, value in ancillary:
                    if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                        fds.frombytes(value[:len(value) - len(value) % fds.itemsize])
                if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or len(data) < 12:
                    raise HostError("worker_protocol", "Filesystem worker closed or returned a truncated packet")
                sequence, status, mutation = struct.unpack("!III", data[:12])
                if sequence != request_id:
                    raise HostError("worker_protocol", "Filesystem worker response identity does not match")
                if status == REOPEN_STATUS:
                    if len(fds) != 1 or len(data) != 12:
                        raise HostError("worker_protocol", "Invalid native descriptor reopen request")
                    reopened = -1
                    try:
                        reopened = _reopen(fds[0], mutation)
                        self.channel.sendmsg([_u32(sequence) + _u32(0)],
                                             [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [reopened]))])
                    except OSError as error:
                        self.channel.sendall(_u32(sequence) + _u32(error.errno or errno.EIO))
                    finally:
                        if reopened >= 0:
                            os.close(reopened)
                    continue
                if descriptor and status == 0:
                    if len(fds) != 1:
                        raise HostError("worker_protocol", "Native export omitted its held descriptor")
                    return data[12:], fds.pop()
                if fds:
                    raise HostError("worker_protocol", "Unexpected descriptors in filesystem response")
                if status != 0:
                    raise FilesystemError(status, mutation != 0)
                return data[12:]
            finally:
                for fd in fds:
                    os.close(fd)

    def call(self, operation: int, payload: bytes = b"", *, descriptor: bool = False) -> Any:
        with self.lock:
            if self.closed:
                raise HostError("worker_unavailable", "Original filesystem worker is closed")
            self.sequence += 1
            packet = _u32(self.sequence) + _u32(operation) + payload
            if len(packet) > PACKET_LIMIT:
                raise HostError("invalid_request", "Filesystem request exceeds its packet bound")
            try:
                self.channel.sendall(packet)
                return self._receive(self.sequence, descriptor)
            except OSError as error:
                raise HostError("unknown_outcome", "Filesystem worker acknowledgement is unavailable") from error

    def bind(self, path: str, kind: int = KIND_FILE, base: int = 0) -> dict[str, Any]:
        data = self.call(2, _u32(base) + _u32(kind) + _string(path))
        return {"handle": struct.unpack("!I", data[:4])[0], "stats": _stats(data[8:])}

    def read(self, handle: int, offset: int, maximum: int = CHUNK_LIMIT) -> bytes:
        return self.call(3, _u32(handle) + _u32(offset) + _u32(maximum))

    def stat(self, handle: int) -> dict[str, Any]:
        return _stats(self.call(4, _u32(handle)))

    def inspect_path(self, path: str, follow_symlinks: bool = True) -> dict[str, Any]:
        if type(follow_symlinks) is not bool:
            raise HostError("invalid_request", "Filesystem symlink policy must be a boolean")
        return _stats(self.call(23, _u32(int(follow_symlinks)) + _string(path)))

    def describe_path(self, path: str, follow_symlinks: bool = True) -> dict[str, Any]:
        if type(follow_symlinks) is not bool:
            raise HostError("invalid_request", "Filesystem symlink policy must be a boolean")
        return _description(self.call(24, _u32(int(follow_symlinks)) + _string(path)))

    def describe_handle(self, handle: int) -> dict[str, Any]:
        return _description(self.call(25, _u32(handle)))

    def release(self, handle: int) -> None:
        self.call(5, _u32(handle))

    def list(self, handle: int, maximum: int = 128) -> list[dict[str, Any]]:
        data = self.call(6, _u32(handle) + _u32(maximum))
        count = struct.unpack("!I", data[:4])[0]
        result = []
        offset = 4
        for _ in range(count):
            length = struct.unpack("!I", data[offset:offset + 4])[0]
            name = data[offset + 4:offset + 4 + length].decode("utf-8")
            offset += 4 + length
            kind = struct.unpack("!I", data[offset:offset + 4])[0]
            offset += 4
            result.append({"name": name, "type": kind})
        if offset != len(data):
            raise HostError("worker_protocol", "Invalid directory listing response")
        return result

    def capture(self, path: str) -> dict[str, Any]:
        data = self.call(7, _u32(0) + _u32(KIND_FILE) + _string(path))
        handle, existed, missing_parents = struct.unpack("!III", data[:12])
        if existed not in (0, 1) or missing_parents not in (0, 1) or (existed and missing_parents):
            raise HostError("worker_protocol", "Invalid captured ancestor state")
        return {"handle": handle, "existed": existed != 0, "missingParents": missing_parents != 0,
                "stats": _stats(data[12:])}

    def expected(self, handle: int, offset: int, maximum: int = CHUNK_LIMIT) -> bytes:
        return self.call(8, _u32(handle) + _u32(offset) + _u32(maximum))

    def stage(self) -> int:
        return struct.unpack("!I", self.call(9))[0]

    def append(self, handle: int, offset: int, content: bytes) -> None:
        self.call(10, _u32(handle) + _u32(offset) + content)

    def seal(self, handle: int) -> None:
        self.call(11, _u32(handle))

    def stage_content(self, content: bytes) -> int:
        handle = self.stage()
        try:
            for offset in range(0, len(content), CHUNK_LIMIT):
                self.append(handle, offset, content[offset:offset + CHUNK_LIMIT])
            self.seal(handle)
            return handle
        except BaseException:
            self.release(handle)
            raise

    def assert_state(self, handle: int, expected: int) -> None:
        self.call(12, _u32(handle) + _u32(expected))

    def assert_original(self, handle: int) -> None:
        self.call(15, _u32(handle))

    def bind_entry(self, base: int, name: str) -> dict[str, Any]:
        data = self.call(16, _u32(base) + _string(name))
        return {"handle": struct.unpack("!I", data[:4])[0], "stats": _stats(data[4:])}

    def readlink(self, handle: int) -> bytes:
        return self.call(17, _u32(handle))

    def remove_symlink(self, handle: int, quarantine: str) -> None:
        self.call(18, _u32(handle) + _string(quarantine))

    def remove_directory(self, handle: int, quarantine: str) -> None:
        self.call(19, _u32(handle) + _string(quarantine))

    def create_directory(self, handle: int, name: str, mode: int) -> None:
        self.call(26, _u32(handle) + _u32(mode) + _string(name))

    def rename_file(self, handle: int, target: str, expected: int) -> dict[str, Any]:
        return _stats(self.call(20, _u32(handle) + _string(target) + _u32(expected)))

    def export_handle(self, handle: int, kind: int) -> tuple[int, dict[str, Any]]:
        return self._export_handle(handle, kind, False)

    def export_stream(self, handle: int) -> tuple[int, dict[str, Any]]:
        """Read-only live task log; bind its inode while permitting append progress."""
        return self._export_handle(handle, KIND_FILE, True)

    def _export_handle(self, handle: int, kind: int, streaming: bool) -> tuple[int, dict[str, Any]]:
        data, fd = self.call(22 if streaming else 21, _u32(handle) + _u32(kind), descriptor=True)
        try:
            metadata = _stats(data)
            device, inode, mode, size, modified, changed = struct.unpack("!QQIQqq", data)
            actual = os.fstat(fd)
            if (metadata["dev"] != str(actual.st_dev) or metadata["ino"] != str(actual.st_ino) or
                    metadata["mode"] != str(actual.st_mode) or
                    (kind == KIND_FILE and not streaming and (size, modified, changed) !=
                     (actual.st_size, actual.st_mtime_ns, actual.st_ctime_ns)) or
                    not (stat.S_ISREG(actual.st_mode) if kind == KIND_FILE else stat.S_ISDIR(actual.st_mode))):
                raise HostError("worker_protocol", "Native export does not match its held identity")
            return fd, {"dev": str(device), "ino": str(inode), "mode": mode, "size": size,
                        "mtimeNs": str(modified), "ctimeNs": str(changed)}
        except BaseException:
            os.close(fd)
            raise

    def write(self, handle: int, expected: int, content: int) -> dict[str, Any]:
        return _stats(self.call(13, _u32(handle) + _u32(expected) + _u32(content)))

    def remove(self, handle: int, expected: int) -> None:
        self.call(14, _u32(handle) + _u32(expected))

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            self.channel.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.channel.close()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                pid, _ = os.waitpid(self.pid, os.WNOHANG)
                if pid != 0:
                    return
            except ChildProcessError:
                return
            time.sleep(.01)
        raise HostError("worker_cleanup_unproven", "Filesystem worker did not exit after its private channel closed")
