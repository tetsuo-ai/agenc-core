"""Bounded host-only RPC. Task stdin and output never carry control messages."""

from __future__ import annotations

import json
import array
import os
import socket
import struct
from typing import Any

MAX_FRAME_BYTES = 2 * 1024 * 1024
LEASE_ENV = "__AGENC_EXECUTION_LEASE_V1"
MAX_IDENTITY_BYTES = 4096  # canonical tool-result call/scope identity bounds
MAX_SAFE_INTEGER = 9007199254740991
MAX_RUNTIME_DESCRIPTORS = 2  # held cwd plus either stdin or the private startup channel


def operation_index(value: Any = 0) -> int:
    if type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER:
        raise HostError("invalid_request", "Invalid subordinate operation index")
    return value


def bounded_identity(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        return len(value.encode("utf-8")) <= MAX_IDENTITY_BYTES
    except UnicodeError:
        return False


class HostError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise HostError("invalid_request", "Duplicate JSON member")
        result[key] = value
    return result


def decode_json(data: bytes) -> Any:
    try:
        return json.loads(data, object_pairs_hook=_unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError, RecursionError) as error:
        raise HostError("invalid_request", "Invalid bounded JSON payload") from error


def encode_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, allow_nan=False,
                      sort_keys=True, separators=(",", ":")).encode("ascii")


def _read_exact(channel: socket.socket, length: int) -> bytes:
    result = bytearray()
    while len(result) < length:
        part = channel.recv(length - len(result))
        if not part:
            raise HostError("transport_closed", "RPC closed before acknowledgement")
        result.extend(part)
    return bytes(result)


def receive(channel: socket.socket) -> dict[str, Any]:
    length, = struct.unpack("!I", _read_exact(channel, 4))
    if not 0 < length <= MAX_FRAME_BYTES:
        raise HostError("invalid_request", "RPC frame exceeds the protocol bound")
    message = decode_json(_read_exact(channel, length))
    if not isinstance(message, dict):
        raise HostError("invalid_request", "RPC request must be an object")
    return message


def send(channel: socket.socket, message: dict[str, Any], descriptors: tuple[int, ...] = ()) -> None:
    payload = encode_json(message)
    if not 0 < len(payload) <= MAX_FRAME_BYTES:
        raise HostError("invalid_request", "RPC frame exceeds the protocol bound")
    frame = struct.pack("!I", len(payload)) + payload
    if len(descriptors) > MAX_RUNTIME_DESCRIPTORS:
        raise HostError("invalid_request", "Runtime descriptor count exceeds its bound")
    if descriptors:
        sent = channel.sendmsg([frame], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", descriptors))])
        if sent <= 0:
            raise HostError("transport_closed", "Runtime descriptor handoff failed")
        channel.sendall(frame[sent:])
    else:
        channel.sendall(frame)


def peer_credentials(channel: socket.socket) -> tuple[int, int, int]:
    """Return kernel-authenticated (pid, uid, gid), never request-supplied IDs."""
    return struct.unpack("3i", channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))


def request(path: str, message: dict[str, Any], timeout: float = 30) -> dict[str, Any]:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
        channel.settimeout(timeout)
        channel.connect(path)
        send(channel, message)
        response = receive(channel)
    if response.get("ok") is not True:
        raise HostError(response.get("code", "host_failure"),
                        response.get("message", "Host operation failed"))
    return response


def receive_descriptors(channel: socket.socket) -> tuple[dict[str, Any], tuple[int, ...]]:
    """Receive a bounded runtime reply, including its first-frame SCM_RIGHTS.

    Every read uses recvmsg so descriptors in later fragments are also counted
    and rejected when unexpected. Partial/error frames close all received fds.
    """
    descriptors: list[int] = []
    try:
        frame = bytearray()
        expected = 4
        while len(frame) < expected:
            part, ancillary, flags, _ = channel.recvmsg(expected - len(frame), socket.CMSG_SPACE(MAX_RUNTIME_DESCRIPTORS * 4), socket.MSG_CMSG_CLOEXEC)
            for level, kind, value in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    received = array.array("i")
                    received.frombytes(value[:len(value) - len(value) % received.itemsize])
                    descriptors.extend(received)
            if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or len(descriptors) > MAX_RUNTIME_DESCRIPTORS:
                raise HostError("invalid_request", "Invalid runtime descriptor handoff")
            if not part:
                raise HostError("transport_closed", "Runtime reply closed before acknowledgement")
            frame.extend(part)
            if expected == 4 and len(frame) == 4:
                length, = struct.unpack("!I", frame)
                if not 0 < length <= MAX_FRAME_BYTES:
                    raise HostError("invalid_request", "Runtime response exceeds its frame bound")
                expected = 4 + length
        response = decode_json(frame[4:])
        if not isinstance(response, dict):
            raise HostError("invalid_request", "Runtime response must be an object")
        if response.get("ok") is not True:
            raise HostError(response.get("code", "host_failure"), response.get("message", "Runtime operation failed"))
        return response, tuple(descriptors)
    except BaseException:
        for fd in descriptors:
            os.close(fd)
        raise


def request_descriptors(path: str, message: dict[str, Any], timeout: float = 30) -> tuple[dict[str, Any], tuple[int, ...]]:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
        channel.settimeout(timeout)
        channel.connect(path)
        send(channel, message)
        return receive_descriptors(channel)
