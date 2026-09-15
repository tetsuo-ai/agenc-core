"""Receive runc's kernel process identity, independent of command stdio."""

from __future__ import annotations

import array
import os
import select
import socket
import threading
from pathlib import Path
from typing import Callable

from protocol import HostError, peer_credentials


class PidfdReceipt:
    def __init__(self, path: Path, on_started: Callable[[int], None],
                 on_exit: Callable[[], None], on_error: Callable[[Exception], None]):
        self.path = path
        self.on_started = on_started
        self.on_exit = on_exit
        self.on_error = on_error
        self.stopped = threading.Event()
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(str(path))
        os.chmod(path, 0o600)
        self.listener.listen(1)
        self.listener.settimeout(0.2)
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self) -> None:
        descriptors = array.array("i")
        try:
            while not self.stopped.is_set():
                try:
                    channel, _ = self.listener.accept()
                    break
                except socket.timeout:
                    continue
            else:
                return
            with channel:
                channel.settimeout(10)
                if peer_credentials(channel)[1] != 0:
                    raise HostError("invalid_peer", "Pidfd receipt requires host root")
                _, ancillary, flags, _ = channel.recvmsg(4096, socket.CMSG_SPACE(16))
                for level, kind, data in ancillary:
                    if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                        descriptors.frombytes(data[:len(data) - len(data) % descriptors.itemsize])
                if flags & (socket.MSG_CTRUNC | socket.MSG_TRUNC) or len(descriptors) != 1:
                    raise HostError("invalid_pidfd", "Expected exactly one kernel pidfd")
                fd = descriptors[0]
                os.set_inheritable(fd, False)
                metadata = Path(f"/proc/self/fdinfo/{fd}").read_text()
                entries = dict(line.split(":", 1) for line in metadata.splitlines() if ":" in line)
                if "Pid" not in entries:
                    raise HostError("invalid_pidfd", "Runtime did not supply a pidfd")
                pid = int(entries["Pid"].strip())
                # -1 is a valid already-exited pidfd: rapid exit must not invent
                # a launch failure or fall back to an unpinned numeric PID.
                self.on_started(pid)
                while not self.stopped.is_set():
                    if select.select([fd], [], [], 0.2)[0]:
                        self.on_exit()
                        return
        except Exception as error:
            if not self.stopped.is_set():
                self.on_error(error)
        finally:
            for fd in descriptors:
                os.close(fd)

    def close(self) -> None:
        self.stopped.set()
        self.listener.close()
        if threading.current_thread() is not self.thread:
            self.thread.join(timeout=11)
        self.path.unlink(missing_ok=True)
