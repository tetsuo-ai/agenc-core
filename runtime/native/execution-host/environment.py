"""Resolve immutable Docker identity and reject unsupported isolation profiles."""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from typing import Any

from protocol import HostError, encode_json

CONTAINER_ID = re.compile(r"[0-9a-f]{64}\Z")


def validate_profile(info: dict[str, Any], container: dict[str, Any],
                     protected_roots: tuple[Path, ...]) -> None:
    host = container["HostConfig"]
    config = container["Config"]
    state = container["State"]

    def require(condition: bool, message: str) -> None:
        if not condition:
            raise HostError("unsupported_environment", message)

    require(info.get("OSType") == "linux" and info.get("CgroupVersion") == "2",
            "Isolated execution requires Linux and cgroup v2")
    require(not any("rootless" in value for value in info.get("SecurityOptions", [])),
            "Rootless Docker is not qualified")
    require(CONTAINER_ID.fullmatch(container.get("Id", "")) is not None,
            "Docker did not return an immutable container ID")
    require(state.get("Running") is True and state.get("Paused") is not True,
            "Task container must be running and unpaused")
    require(host.get("Runtime") == "agenc-runc", "Task container must be created with runtime agenc-runc")
    require(host.get("Privileged") is not True, "Privileged containers are not supported")
    require(host.get("PidMode", "") == "", "Task PID namespace must be private")
    require(host.get("IpcMode", "private") in ("private", ""), "Task IPC namespace must be private")
    require(host.get("UTSMode", "") == "", "Task UTS namespace must be private")
    require(host.get("CgroupnsMode") == "private", "Task cgroup namespace must be private")
    require(host.get("NetworkMode", "") != "host" and
            not host.get("NetworkMode", "").startswith("container:"),
            "Host and shared-container network namespaces are not supported")
    require(host.get("UsernsMode", "") in ("", "host"), "User namespace remapping is not supported")
    require(config.get("User", "") in ("", "0", "0:0", "root", "root:root"),
            "Initial isolated execution supports only task UID/GID 0")
    require(not host.get("CapAdd"), "Additional container capabilities are not qualified")
    require(not host.get("Devices") and not host.get("DeviceRequests"),
            "Container device passthrough is not qualified")
    require(not host.get("VolumesFrom"), "Inherited container mounts are not qualified")
    require(container.get("AppArmorProfile", "") in ("", "unconfined", "docker-default"),
            "Custom AppArmor profiles are not qualified")
    require(not container.get("ProcessLabel") and not container.get("MountLabel"),
            "Custom or SELinux LSM configurations are not qualified")
    allowed_security = {"apparmor=docker-default", "apparmor:docker-default",
                        "apparmor=unconfined", "apparmor:unconfined",
                        "no-new-privileges", "no-new-privileges=true"}
    require(all(value in allowed_security for value in host.get("SecurityOpt") or []),
            "Custom security configurations are not qualified")
    # Bind sources and named volumes are host paths in Docker's resolved view.
    # Resolve symlinks on the host; task paths cannot authorize controller mounts.
    protected = tuple(root.resolve() for root in protected_roots)
    control_paths = (Path("/var/run"), Path("/run"), Path("/proc"), Path("/sys"), Path("/dev"))
    for mount in container.get("Mounts", []):
        source = Path(mount.get("Source", "/")).resolve()
        require(mount.get("Type") in ("bind", "volume", "tmpfs"), "Unsupported mount type")
        if mount.get("Type") == "tmpfs":
            continue
        require(all(not (source == root or source in root.parents or root in source.parents)
                    for root in protected + control_paths),
                "Task mounts overlap controller authority or host control resources")
        require(mount.get("Propagation", "") in ("", "rprivate", "private"),
                "Shared mount propagation is not supported")
        require(not source.is_socket(), "Container-control sockets cannot be mounted into a task")


def resolve_binding(container: dict[str, Any], proc_root: Path = Path("/proc"),
                    cgroup_root: Path = Path("/sys/fs/cgroup")) -> dict[str, Any]:
    pid = container["State"]["Pid"]
    if not isinstance(pid, int) or pid <= 1:
        raise HostError("environment_dead", "Task init is unavailable")
    process = proc_root / str(pid)
    # Start time is after the final ')' because comm may contain spaces and ')'.
    process_stat = (process / "stat").read_text()
    start_time = process_stat[process_stat.rfind(")") + 2:].split()[19]
    uid_map = (process / "uid_map").read_text().split()
    gid_map = (process / "gid_map").read_text().split()
    if uid_map != ["0", "0", "4294967295"] or gid_map != ["0", "0", "4294967295"]:
        raise HostError("unsupported_environment", "User namespace remapping is not supported")
    namespace_ids = {name: os.stat(process / "ns" / name).st_ino
                     for name in ("mnt", "pid", "user", "cgroup", "net", "ipc", "uts")}
    for name in ("mnt", "pid", "cgroup", "net", "ipc", "uts"):
        if namespace_ids[name] == os.stat(proc_root / "self/ns" / name).st_ino:
            raise HostError("unsupported_environment", f"Task {name} namespace is not private")
    lines = (process / "cgroup").read_text().splitlines()
    if len(lines) != 1 or not lines[0].startswith("0::/"):
        raise HostError("unsupported_environment", "Task does not have one cgroup v2 membership")
    relative = lines[0][4:]
    if ".." in Path(relative).parts:
        raise HostError("unsupported_environment", "Invalid task cgroup path")
    cgroup = cgroup_root / relative
    if (cgroup / "cgroup.subtree_control").read_text().strip():
        raise HostError("unsupported_environment", "Task parent cgroup must have empty subtree_control")
    root = os.stat(process / "root")
    identity = {
        "containerId": container["Id"], "startedAt": container["State"]["StartedAt"],
        "initPid": pid, "initStartTime": start_time,
        "bootId": (proc_root / "sys/kernel/random/boot_id").read_text().strip(),
        "namespaces": namespace_ids, "rootIdentity": [root.st_dev, root.st_ino],
        "cgroupPath": str(cgroup),
    }
    return {**identity, "generation": hashlib.sha256(encode_json(identity)).hexdigest()}
