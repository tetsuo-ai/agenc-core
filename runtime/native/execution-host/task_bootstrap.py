"""Immutable task launcher and sealed argv/environment descriptor preparation."""

from __future__ import annotations

import contextlib
import fcntl
import os
import stat
import struct
from typing import Any, Iterator

from protocol import HostError, MAX_FRAME_BYTES
from task_files import validate_files

LAUNCHER_PATH = "/opt/agenc-execution/bin/agenc-task-launcher"
ALL_SEALS = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL


def executable_copy(source: int) -> int:
    # Never expose an installed host inode through task /proc/PID/exe or fd/3.
    # A task root could retain an O_PATH descriptor and reopen it for writing
    # after exec releases ETXTBSY. Only a sealed anonymous copy crosses runc.
    try:
        target = os.memfd_create("agenc-task-launcher", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING | 0x0010)  # MFD_EXEC
    except OSError as error:
        if error.errno != 22:  # older kernels without MFD_EXEC; never bypass an access denial
            raise
        target = os.memfd_create("agenc-task-launcher", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    try:
        before = os.fstat(source)
        if not 0 < before.st_size <= 16 * 1024 * 1024:
            raise HostError("invalid_launcher", "Native launcher exceeds its binary size bound")
        offset = 0
        while offset < before.st_size:
            content = memoryview(os.pread(source, min(65536, before.st_size - offset), offset))
            if not content:
                raise HostError("invalid_launcher", "Installed launcher changed while being copied")
            offset += len(content)
            while content:
                written = os.write(target, content)
                if written <= 0:
                    raise HostError("invalid_launcher", "Cannot prepare executable task copy")
                content = content[written:]
        after = os.fstat(source)
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise HostError("invalid_launcher", "Installed launcher changed while being copied")
        os.fchmod(target, 0o555)
        fcntl.fcntl(target, fcntl.F_ADD_SEALS, ALL_SEALS)
        return target
    except BaseException:
        os.close(target)
        raise


def encode_bootstrap(spec: dict[str, Any]) -> bytes:
    files = validate_files(spec["files"]) if "files" in spec else []
    detached_log = spec.get("detachedLogPath")
    result = bytearray(b"AGL3" if detached_log is not None else b"AGL2" if files else b"AGL1")

    def string(value: str) -> None:
        if not isinstance(value, str) or "\0" in value:
            raise HostError("invalid_process", "Task bootstrap strings must not contain NUL")
        content = value.encode("utf-8")
        if len(result) + 4 + len(content) > MAX_FRAME_BYTES:
            raise HostError("invalid_process", "Task bootstrap exceeds its frame bound")
        result.extend(struct.pack("!I", len(content)))
        result.extend(content)

    string(spec["args"][0])
    for entries in ([spec.get("argv0", spec["args"][0]), *spec["args"][1:]], spec["env"]):
        if len(entries) > 65536:
            raise HostError("invalid_process", "Task bootstrap has too many strings")
        result.extend(struct.pack("!I", len(entries)))
        for entry in entries:
            string(entry)
    if files or detached_log is not None:
        result.extend(struct.pack("!I", len(files)))
        for entry in files:
            identity = entry["identity"]
            result.extend(struct.pack("!IQQIQqq", {"cwd": 1, "stdin": 2}[entry["role"]],
                                      int(identity["dev"]), int(identity["ino"]), identity["mode"], identity["size"],
                                      int(identity["mtimeNs"]), int(identity["ctimeNs"])))
    if detached_log is not None:
        if (spec.get("terminal") or any(entry["role"] == "stdin" for entry in files) or
                not isinstance(detached_log, str) or not detached_log.startswith("/") or
                len(detached_log.encode("utf-8")) >= 16384):
            raise HostError("invalid_process", "Detached execution requires a task log and closed non-terminal stdin")
        string(detached_log)
    if len(result) > MAX_FRAME_BYTES:
        raise HostError("invalid_process", "Task bootstrap exceeds its frame bound")
    return bytes(result)


@contextlib.contextmanager
def launch_descriptors(spec: dict[str, Any], launcher_path: str = LAUNCHER_PATH) -> Iterator[tuple[int, int]]:
    # Use high CLOEXEC source descriptors so spawn file actions can install
    # private task fds 3 and 4 without clobbering any adapter descriptors.
    program = payload = -1
    try:
        fd = os.open(launcher_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            metadata = os.fstat(fd)
            if (metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022 or
                    not stat.S_ISREG(metadata.st_mode) or os.pread(fd, 4, 0) != b"\x7fELF"):
                raise HostError("invalid_launcher", "Task launcher must be an immutable native executable")
            copied = executable_copy(fd)
            try:
                program = fcntl.fcntl(copied, fcntl.F_DUPFD_CLOEXEC, 10)
            finally:
                os.close(copied)
        finally:
            os.close(fd)
        fd = os.memfd_create("agenc-task-bootstrap", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
        try:
            content = memoryview(encode_bootstrap(spec))
            while content:
                written = os.write(fd, content)
                if written <= 0:
                    raise HostError("invalid_process", "Cannot prepare private task bootstrap")
                content = content[written:]
            fcntl.fcntl(fd, fcntl.F_ADD_SEALS, ALL_SEALS)
            payload = fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 10)
        finally:
            os.close(fd)
        yield program, payload
    finally:
        for fd in (program, payload):
            if fd >= 0:
                os.close(fd)
