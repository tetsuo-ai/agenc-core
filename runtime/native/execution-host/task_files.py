"""Attestations for task-only descriptors captured before launch allocation."""
from __future__ import annotations

import os
import re
import stat
from typing import Any

from protocol import HostError, MAX_SAFE_INTEGER


def validate_files(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= 2:
        raise HostError("invalid_process", "Invalid task descriptor layout")
    previous = 0
    for entry in value:
        if not isinstance(entry, dict) or set(entry) != {"role", "source", "identity"}:
            raise HostError("invalid_process", "Invalid task descriptor attestation")
        role = {"cwd": 1, "stdin": 2}.get(entry["role"]) if isinstance(entry["role"], str) else None
        if role is None or role <= previous:
            raise HostError("invalid_process", "Task descriptor roles are duplicated or out of order")
        previous = role
        source, identity = entry["source"], entry["identity"]
        if (not isinstance(source, dict) or set(source) != {"workerId", "handle"} or
                not isinstance(source["workerId"], str) or re.fullmatch(r"[a-f0-9]{32}", source["workerId"]) is None or
                type(source["handle"]) is not int or not 1 <= source["handle"] <= 0xffffffff or
                not isinstance(identity, dict) or set(identity) != {"dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"}):
            raise HostError("invalid_process", "Task descriptor has no original capability identity")
        for key, signed in (("dev", False), ("ino", False), ("mtimeNs", True), ("ctimeNs", True)):
            part = identity[key]
            if not isinstance(part, str) or re.fullmatch(r"-?(0|[1-9][0-9]{0,19})" if signed else r"0|[1-9][0-9]{0,19}", part) is None:
                raise HostError("invalid_process", "Invalid task descriptor metadata")
            if not (-(1 << 63) <= int(part) < (1 << 63) if signed else 0 <= int(part) < (1 << 64)):
                raise HostError("invalid_process", "Task descriptor metadata exceeds its bound")
        if (type(identity["mode"]) is not int or not 0 <= identity["mode"] <= 0xffffffff or
                type(identity["size"]) is not int or not 0 <= identity["size"] <= MAX_SAFE_INTEGER or
                not (stat.S_ISDIR(identity["mode"]) if role == 1 else stat.S_ISREG(identity["mode"]))):
            raise HostError("invalid_process", "Task descriptor has an unsupported resource type")
    return value


def describe_file(role: str, source: dict[str, Any], fd: int,
                  identity: dict[str, Any] | None = None) -> dict[str, Any]:
    if identity is None:
        value = os.fstat(fd)
        identity = {"dev": str(value.st_dev), "ino": str(value.st_ino), "mode": value.st_mode, "size": value.st_size,
                    "mtimeNs": str(value.st_mtime_ns), "ctimeNs": str(value.st_ctime_ns)}
    result = {"role": role, "source": dict(source), "identity": dict(identity)}
    validate_files([result])
    return result


def has_file(spec: dict[str, Any], role: str) -> bool:
    return any(entry["role"] == role for entry in spec.get("files", []))
