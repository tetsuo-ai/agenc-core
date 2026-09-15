"""Incremental Docker stream framing and durable, non-consuming output cursors."""

from __future__ import annotations

import base64
import os
from pathlib import Path
from typing import Any

from leases import LeaseStore
from protocol import HostError


def create_output_file(path: Path, *, readable: bool = False) -> int:
    """Publish the host evidence inode durably before task dispatch can begin."""
    fd = os.open(path, (os.O_RDWR if readable else os.O_WRONLY) | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return fd
    except BaseException:
        os.close(fd)
        raise


class OutputIndex:
    def __init__(self, terminal: bool):
        self.terminal = terminal
        self.offset = 0
        self.header = bytearray()
        self.remaining = 0
        self.stream = 1

    def feed(self, content: bytes) -> list[tuple[int, int, int]]:
        """Index only bytes already fsynced to the operational output file."""
        entries = []
        if self.terminal:
            if content:
                entries.append((self.offset, len(content), 1))
            self.offset += len(content)
            return entries
        position = 0
        while position < len(content):
            if self.remaining == 0:
                count = min(8 - len(self.header), len(content) - position)
                self.header.extend(content[position:position + count])
                position += count
                self.offset += count
                if len(self.header) != 8:
                    continue
                if self.header[0] not in (1, 2) or self.header[1:4] != b"\0\0\0":
                    raise HostError("output_protocol", "Docker returned an invalid output frame")
                self.stream = self.header[0]
                self.remaining = int.from_bytes(self.header[4:8], "big")
                self.header.clear()
                if self.remaining > 256 * 1024 * 1024:
                    raise HostError("output_protocol", "Docker output frame exceeds retained output bound")
            count = min(self.remaining, len(content) - position)
            if count:
                entries.append((self.offset, count, self.stream))
                self.offset += count
                position += count
                self.remaining -= count
        return entries

    def finish(self) -> None:
        if self.header or self.remaining:
            raise HostError("output_protocol", "Docker disconnected in an incomplete output frame")


def record_output(store: LeaseStore, operation: str, entries: list[tuple[int, int, int]]) -> None:
    if not entries:
        return
    with store.lock:
        store.db.execute("BEGIN IMMEDIATE")
        try:
            store.db.executemany("INSERT INTO output_frames VALUES(?,?,?,?)",
                                 [(operation, *entry) for entry in entries])
            store.db.execute("COMMIT")
        except BaseException:
            store.db.execute("ROLLBACK")
            raise


def read_output(store: LeaseStore, root: Path, operation: str, offset: int, maximum: int) -> dict[str, Any]:
    if type(offset) is not int or offset < 0 or type(maximum) is not int or not 1 <= maximum <= 262144:
        raise HostError("invalid_request", "Invalid bounded output cursor")
    with store.lock:
        # Rows are bounded independently from bytes to keep zero/small writes
        # from creating an unbounded response or memory allocation.
        previous = store.db.execute("SELECT offset,length FROM output_frames WHERE operation_id=? "
                                    "ORDER BY offset DESC LIMIT 1", (operation,)).fetchone()
        end = 0 if previous is None else previous["offset"] + previous["length"]
        if offset > end:
            raise HostError("invalid_request", "Output cursor exceeds retained evidence")
        rows = store.db.execute("SELECT offset,length,stream FROM output_frames WHERE operation_id=? "
                               "AND offset>=COALESCE((SELECT offset FROM output_frames WHERE operation_id=? "
                               "AND offset<=? ORDER BY offset DESC LIMIT 1),0) "
                               "ORDER BY offset LIMIT 512", (operation, operation, offset)).fetchall()
    if not rows:
        return {"stdout": "", "stderr": "", "nextOffset": offset}
    stdout, stderr = bytearray(), bytearray()
    cursor = offset
    fd = os.open(root / (operation + ".output"), os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        for row in rows:
            begin = max(cursor, row["offset"])
            size = min(row["offset"] + row["length"] - begin, maximum - len(stdout) - len(stderr))
            if size <= 0:
                continue
            content = os.pread(fd, size, begin)
            if len(content) != size:
                raise HostError("output_unavailable", "Indexed operational output is incomplete")
            (stdout if row["stream"] == 1 else stderr).extend(content)
            cursor = begin + size
            if len(stdout) + len(stderr) == maximum:
                break
    finally:
        os.close(fd)
    return {"stdout": base64.b64encode(stdout).decode("ascii"),
            "stderr": base64.b64encode(stderr).decode("ascii"), "nextOffset": cursor}
