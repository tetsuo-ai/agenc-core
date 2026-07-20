#!/usr/bin/env python3
"""portman — list listening TCP ports and their process names.

Standalone stdlib-only CLI. Prefers parsing /proc (no root required for your
own sockets; other users' PIDs may show as unknown). Falls back to ``ss -lntp``
when /proc is unavailable.

Usage
-----
  # All listening TCP ports (IPv4 + IPv6)
  python3 tools/portman.py

  # Only ports in a range (inclusive)
  python3 tools/portman.py --from 8000 --to 9000

  # Machine-readable output
  python3 tools/portman.py --json

  # Combine filters
  python3 tools/portman.py --from 1 --to 1024 --json

  # Shortcut as executable (after chmod +x)
  ./tools/portman.py -f 3000 -t 3999

Exit status is 0 on success, 2 on bad arguments, 1 on runtime failure.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple


# TCP state 0A = LISTEN in /proc/net/tcp{,6}
_LISTEN = "0A"

# ss line pieces: users:(("name",pid=123,fd=3))
_SS_USERS = re.compile(
    r'users:\(\("([^"]*)",pid=(\d+),fd=\d+\)'
)
_SS_LOCAL = re.compile(
    r"^(?P<state>\S+)\s+\d+\s+\d+\s+(?P<local>\S+)\s+\S+"
)


@dataclass(frozen=True)
class Listener:
    proto: str  # tcp | tcp6
    address: str
    port: int
    pid: Optional[int]
    process: str

    def sort_key(self) -> Tuple[int, str, str]:
        return (self.port, self.address, self.proto)


def _parse_hex_ip_port(field: str, ipv6: bool) -> Optional[Tuple[str, int]]:
    """Parse /proc/net/tcp{,6} local_address field (IP:port, both hex)."""
    try:
        ip_hex, port_hex = field.split(":", 1)
        port = int(port_hex, 16)
    except ValueError:
        return None

    try:
        if not ipv6:
            # little-endian IPv4 dword
            raw = bytes.fromhex(ip_hex)
            if len(raw) != 4:
                return None
            ip = socket.inet_ntop(socket.AF_INET, raw[::-1])
        else:
            # 4 little-endian 32-bit words
            raw = bytes.fromhex(ip_hex)
            if len(raw) != 16:
                return None
            words = [raw[i : i + 4][::-1] for i in range(0, 16, 4)]
            ip = socket.inet_ntop(socket.AF_INET6, b"".join(words))
    except (ValueError, OSError):
        return None
    return ip, port


def _inode_to_pid() -> Dict[int, int]:
    """Map socket inode -> pid by scanning /proc/*/fd."""
    mapping: Dict[int, int] = {}
    proc = Path("/proc")
    try:
        pids = [p for p in proc.iterdir() if p.name.isdigit()]
    except OSError:
        return mapping

    for pdir in pids:
        fd_dir = pdir / "fd"
        try:
            entries = list(fd_dir.iterdir())
        except OSError:
            continue
        pid = int(pdir.name)
        for fd in entries:
            try:
                target = os.readlink(fd)
            except OSError:
                continue
            # socket:[12345]
            if target.startswith("socket:[") and target.endswith("]"):
                try:
                    ino = int(target[len("socket:[") : -1])
                except ValueError:
                    continue
                # first wins; good enough for listing
                mapping.setdefault(ino, pid)
    return mapping


def _pid_comm(pid: int) -> str:
    try:
        text = Path(f"/proc/{pid}/comm").read_text(encoding="utf-8", errors="replace")
        return text.strip() or f"pid:{pid}"
    except OSError:
        try:
            cmdline = Path(f"/proc/{pid}/cmdline").read_bytes()
            if cmdline:
                return cmdline.split(b"\x00", 1)[0].decode("utf-8", "replace") or f"pid:{pid}"
        except OSError:
            pass
    return f"pid:{pid}"


def _read_proc_table(path: Path, ipv6: bool) -> List[Tuple[str, int, int]]:
    """Return list of (address, port, inode) for LISTEN sockets."""
    out: List[Tuple[str, int, int]] = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return out
    if not lines:
        return out
    # skip header
    for line in lines[1:]:
        parts = line.split()
        if len(parts) < 10:
            continue
        local, state, inode_s = parts[1], parts[3], parts[9]
        if state.upper() != _LISTEN:
            continue
        parsed = _parse_hex_ip_port(local, ipv6=ipv6)
        if not parsed:
            continue
        addr, port = parsed
        try:
            inode = int(inode_s)
        except ValueError:
            continue
        out.append((addr, port, inode))
    return out


def listeners_from_proc() -> Optional[List[Listener]]:
    tcp = Path("/proc/net/tcp")
    tcp6 = Path("/proc/net/tcp6")
    if not tcp.is_file() and not tcp6.is_file():
        return None

    inode_pid = _inode_to_pid()
    rows: List[Listener] = []

    for path, ipv6, proto in (
        (tcp, False, "tcp"),
        (tcp6, True, "tcp6"),
    ):
        if not path.is_file():
            continue
        for addr, port, inode in _read_proc_table(path, ipv6=ipv6):
            pid = inode_pid.get(inode)
            if pid is not None:
                name = _pid_comm(pid)
            else:
                name = "-"
            rows.append(
                Listener(
                    proto=proto,
                    address=addr,
                    port=port,
                    pid=pid,
                    process=name,
                )
            )
    return rows


def _split_host_port(local: str) -> Optional[Tuple[str, int]]:
    """Parse ss local address (host:port or [v6]:port)."""
    local = local.strip()
    if local.startswith("["):
        # [fe80::1]:80
        try:
            bracket, port_s = local.rsplit("]:", 1)
            host = bracket[1:]
            return host, int(port_s)
        except ValueError:
            return None
    # *:80 or 0.0.0.0:80 or :::%num may appear without brackets on some ss
    if local.count(":") > 1 and not local.startswith("["):
        # bare ipv6 with :port — last field is port
        try:
            host, port_s = local.rsplit(":", 1)
            return host, int(port_s)
        except ValueError:
            return None
    try:
        host, port_s = local.rsplit(":", 1)
        return host, int(port_s)
    except ValueError:
        return None


def listeners_from_ss() -> List[Listener]:
    try:
        proc = subprocess.run(
            ["ss", "-lntp"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
        raise RuntimeError(f"ss fallback failed: {exc}") from exc

    rows: List[Listener] = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line or line.startswith("State"):
            continue
        m = _SS_LOCAL.match(line)
        if not m:
            continue
        state = m.group("state").upper()
        if "LISTEN" not in state:
            continue
        hp = _split_host_port(m.group("local"))
        if not hp:
            continue
        host, port = hp
        um = _SS_USERS.search(line)
        if um:
            name, pid_s = um.group(1), um.group(2)
            try:
                pid: Optional[int] = int(pid_s)
            except ValueError:
                pid = None
                name = name or "-"
        else:
            pid = None
            name = "-"
        proto = "tcp6" if ":" in host and host.count(":") >= 2 else "tcp"
        if host in ("*", "0.0.0.0", "::"):
            # keep ss wildcard as-is; proto heuristic for * is tcp
            if host == "::":
                proto = "tcp6"
        rows.append(
            Listener(proto=proto, address=host, port=port, pid=pid, process=name or "-")
        )
    return rows


def collect_listeners() -> List[Listener]:
    rows = listeners_from_proc()
    if rows is not None:
        return rows
    return listeners_from_ss()


def filter_range(
    rows: Iterable[Listener], port_from: Optional[int], port_to: Optional[int]
) -> List[Listener]:
    lo = 0 if port_from is None else port_from
    hi = 65535 if port_to is None else port_to
    return [r for r in rows if lo <= r.port <= hi]


def format_table(rows: List[Listener]) -> str:
    headers = ("PROTO", "ADDRESS", "PORT", "PID", "PROCESS")
    data = [
        (
            r.proto,
            r.address,
            str(r.port),
            "-" if r.pid is None else str(r.pid),
            r.process,
        )
        for r in rows
    ]
    widths = [len(h) for h in headers]
    for tup in data:
        for i, cell in enumerate(tup):
            widths[i] = max(widths[i], len(cell))

    def fmt(cells: Tuple[str, ...]) -> str:
        return "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(cells))

    lines = [fmt(headers), fmt(tuple("-" * w for w in widths))]
    lines.extend(fmt(t) for t in data)
    if not data:
        lines.append("(no listening TCP ports in range)")
    return "\n".join(lines) + "\n"


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="portman",
        description="List listening TCP ports with process names (stdlib only).",
    )
    p.add_argument(
        "--from",
        "-f",
        dest="port_from",
        type=int,
        default=None,
        metavar="PORT",
        help="lowest port to include (inclusive)",
    )
    p.add_argument(
        "--to",
        "-t",
        dest="port_to",
        type=int,
        default=None,
        metavar="PORT",
        help="highest port to include (inclusive)",
    )
    p.add_argument(
        "--json",
        action="store_true",
        help="emit JSON array instead of a table",
    )
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    for label, val in (("from", args.port_from), ("to", args.port_to)):
        if val is not None and not (0 <= val <= 65535):
            print(f"portman: invalid --{label} {val} (want 0..65535)", file=sys.stderr)
            return 2
    if (
        args.port_from is not None
        and args.port_to is not None
        and args.port_from > args.port_to
    ):
        print("portman: --from must be <= --to", file=sys.stderr)
        return 2

    try:
        rows = collect_listeners()
    except RuntimeError as exc:
        print(f"portman: {exc}", file=sys.stderr)
        return 1

    rows = filter_range(rows, args.port_from, args.port_to)
    rows.sort(key=lambda r: r.sort_key())

    # de-dupe identical listen endpoints (ipv6 dual-stack noise etc.)
    seen = set()
    unique: List[Listener] = []
    for r in rows:
        key = (r.proto, r.address, r.port, r.pid, r.process)
        if key in seen:
            continue
        seen.add(key)
        unique.append(r)

    if args.json:
        payload = [
            {
                **asdict(r),
                "pid": r.pid,
            }
            for r in unique
        ]
        json.dump(payload, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        sys.stdout.write(format_table(unique))
    return 0


if __name__ == "__main__":
    sys.exit(main())
