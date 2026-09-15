"""Provision, qualify and remove a disposable Docker daemon host.

Run from the repository root with Python 3.11+ on a Linux Docker/cgroup-v2 host.
No outer daemon configuration is changed and no outer control socket is mounted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

TASK_IMAGE = "python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de"


def command(*argv: str, capture: bool = False, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(argv, check=True, text=True, capture_output=capture, timeout=timeout)


def stage_controller(node: Path, destination: Path, runtime: Path) -> None:
    """Copy the operator's qualified Node and its loader into the disposable host.

    The daemon image is musl-based; a private glibc loader keeps the existing
    runtime test version without changing the daemon host's system libraries.
    Only this known controller executable is passed to ldd, never task content.
    """
    version = command(str(node), "--version", capture=True).stdout.strip()
    match = re.fullmatch(r"v26\.(\d+)\.(\d+)", version)
    if match is None or int(match[1]) < 5:
        raise RuntimeError("Controller backend qualification requires Node >=26.5.0 <27.0.0")
    destination.mkdir()
    shutil.copy2(node, destination / "node")
    dependencies = command("ldd", str(node), capture=True).stdout
    libraries = re.findall(r"(?:=>\s*)?(/[^\s]+)", dependencies)
    for library in libraries:
        source = Path(library)
        if not source.is_file():
            raise RuntimeError("Controller library is unavailable: " + library)
        shutil.copy2(source.resolve(), destination / source.name)
    if not (destination / "ld-linux-x86-64.so.2").is_file():
        raise RuntimeError("Controller qualification requires its private Linux x86_64 glibc loader")
    command(str(node), str(runtime / "tests/execution-host/build-controller-probe.mjs"),
            str(destination / "controller-probe.mjs"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--log-dir", type=Path, required=True)
    parser.add_argument("--worker-binary", type=Path)
    parser.add_argument("--launcher-binary", type=Path)
    parser.add_argument("--controller-node", type=Path, default=shutil.which("node"))
    parser.add_argument("--ripgrep-binary", type=Path, default=shutil.which("rg"),
                        help="Operator-provided Linux x86_64 ripgrep, runnable in the task image (a static binary is suitable)")
    arguments = parser.parse_args()
    logs = arguments.log_dir.resolve()
    logs.mkdir(parents=True, exist_ok=True)
    runtime = Path(__file__).resolve().parents[2]
    if arguments.controller_node is None:
        raise RuntimeError("Controller backend qualification requires Node; unavailable fixtures do not skip")
    if arguments.ripgrep_binary is None:
        raise RuntimeError("Bound search qualification requires a real ripgrep executable; unavailable fixtures do not skip")
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("This qualification fixture requires Linux x86_64; unsupported fixtures do not skip")
    before = json.loads(command("docker", "info", "--format", "{{json .}}", capture=True).stdout)
    if before["CgroupVersion"] != "2":
        raise RuntimeError("Kernel qualification requires cgroup v2")
    tag = "agenc-execution-host-fixture:" + secrets.token_hex(8)
    task_tag = "agenc-execution-task-fixture:" + secrets.token_hex(8)
    container: str | None = None
    try:
        # Legacy Docker builders ignore Dockerfile-specific ignore files. Use
        # an explicit minimal context so neither unrelated workspace data nor
        # changing dist artifacts enter the daemon's build transport.
        with tempfile.TemporaryDirectory(prefix="agenc-execution-build-") as temporary:
            context = Path(temporary)
            (context / "native/execution-host").mkdir(parents=True)
            (context / "tests/execution-host").mkdir(parents=True)
            for source in (runtime / "native/execution-host").glob("*.py"):
                shutil.copyfile(source, context / "native/execution-host" / source.name)
            for name in ("agenc-filesystem-worker.c", "agenc-task-launcher.c"):
                shutil.copyfile(runtime / "native" / name, context / "native" / name)
            shutil.copyfile(runtime / "tests/execution-host/fixture-entry.py", context / "tests/execution-host/fixture-entry.py")
            shutil.copyfile(runtime / "tests/execution-host/Dockerfile", context / "Dockerfile")
            with open(logs / "build.log", "w") as output:
                subprocess.run(["docker", "build", "-t", tag, str(context)],
                               check=True, stdout=output, stderr=subprocess.STDOUT, timeout=300)
        command("docker", "pull", TASK_IMAGE)
        image_id = command("docker", "image", "inspect", TASK_IMAGE, "--format", "{{.Id}}", capture=True).stdout.strip()
        command("docker", "tag", image_id, task_tag)
        container = command(
            "docker", "run", "-d", "--privileged", "--cgroupns=private", "--network=none",
            "--label", "agenc.fixture=execution-2477", "--entrypoint=/usr/local/bin/dind", tag, "/bin/sleep", "infinity", capture=True).stdout.strip()
        initialized = time.monotonic() + 15
        while True:
            ready = subprocess.run(["docker", "exec", container, "/bin/sh", "-c",
                                   '[ "$(cat /proc/1/comm)" = sleep ]'], capture_output=True, timeout=10)
            if ready.returncode == 0:
                break
            state = json.loads(command("docker", "inspect", container, "--format", "{{json .State}}", capture=True).stdout)
            if not state["Running"] or time.monotonic() >= initialized:
                raise RuntimeError("Disposable host did not initialize its nested cgroup hierarchy")
            time.sleep(.1)
        # The disposable host stays alive if its Docker daemon dies. This lets
        # the controller/supervisor retain evidence through daemon-failure tests.
        command("docker", "exec", "-d", container, "/bin/sh", "-c",
            'exec dockerd "$@" > /var/lib/agenc-execution/docker-daemon.log 2>&1', "fixture-dockerd",
            "--host=unix:///var/run/docker.sock", "--iptables=false", "--ip6tables=false",
            "--bridge=none", "--ip-forward=false",
            "--add-runtime=agenc-runc=/opt/agenc-execution/bin/agenc-runc")
        deadline = time.monotonic() + 60
        while True:
            inspected = json.loads(command("docker", "inspect", container, "--format", "{{json .State}}", capture=True).stdout)
            if not inspected["Running"]:
                raise RuntimeError("Disposable Docker daemon exited during startup")
            ready = subprocess.run(["docker", "exec", container, "docker", "info"],
                                   capture_output=True, timeout=10)
            if ready.returncode == 0:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("Disposable Docker daemon did not become ready")
            time.sleep(0.2)
        with tempfile.TemporaryDirectory(prefix="agenc-execution-image-") as temporary:
            archive = str(Path(temporary) / "task-image.tar")
            command("docker", "save", task_tag, "-o", archive)
            command("docker", "cp", archive, container + ":/task-image.tar")
            command("docker", "exec", container, "docker", "load", "-i", "/task-image.tar")
        command("docker", "exec", container, "docker", "run", "-d", "--runtime=agenc-runc",
                "--network=none", "--security-opt=apparmor=unconfined", "--name=agenc-task",
                task_tag, "sleep", "infinity")
        ripgrep = arguments.ripgrep_binary.resolve()
        command("docker", "cp", str(ripgrep), container + ":/opt/agenc-execution/probe-rg")
        command("docker", "exec", container, "docker", "cp", "/opt/agenc-execution/probe-rg", "agenc-task:/usr/local/bin/rg")
        command("docker", "exec", container, "docker", "exec", "agenc-task", "chmod", "755", "/usr/local/bin/rg")
        version = command("docker", "exec", container, "docker", "exec", "agenc-task", "/usr/local/bin/rg", "--version", capture=True)
        (logs / "ripgrep.txt").write_text("sha256=" + hashlib.sha256(ripgrep.read_bytes()).hexdigest() + "\n" + version.stdout)
        if arguments.worker_binary is not None:
            command("docker", "cp", str(arguments.worker_binary.resolve()), container + ":/opt/agenc-execution/bin/agenc-filesystem-worker")
            command("docker", "exec", container, "chown", "0:0", "/opt/agenc-execution/bin/agenc-filesystem-worker")
            command("docker", "exec", container, "chmod", "755", "/opt/agenc-execution/bin/agenc-filesystem-worker")
        if arguments.launcher_binary is not None:
            command("docker", "cp", str(arguments.launcher_binary.resolve()), container + ":/opt/agenc-execution/bin/agenc-task-launcher")
            command("docker", "exec", container, "chown", "0:0", "/opt/agenc-execution/bin/agenc-task-launcher")
            command("docker", "exec", container, "chmod", "755", "/opt/agenc-execution/bin/agenc-task-launcher")
        with tempfile.TemporaryDirectory(prefix="agenc-execution-controller-") as temporary:
            controller = Path(temporary) / "probe-node"
            stage_controller(arguments.controller_node.resolve(), controller, runtime)
            command("docker", "cp", str(controller), container + ":/opt/agenc-execution/probe-node")
        command("docker", "cp", str(runtime / "tests/execution-host/kernel_probe.py"), container + ":/kernel_probe.py")
        with open(logs / "kernel-probe.log", "w") as output:
            probe = subprocess.run(["docker", "exec", container, "python3", "-B", "/kernel_probe.py"],
                                   text=True, stdout=output, stderr=subprocess.STDOUT, timeout=180)
        print((logs / "kernel-probe.log").read_text(), end="", flush=True)
        probe.check_returncode()
    finally:
        if container is not None:
            with open(logs / "docker-host.log", "w") as output:
                subprocess.run(["docker", "logs", container], stdout=output, stderr=subprocess.STDOUT, timeout=10)
            subprocess.run(["docker", "cp", container + ":/var/lib/agenc-execution", str(logs / "receipts")],
                           capture_output=True, timeout=30)
            command("docker", "rm", "-f", "-v", container)
        subprocess.run(["docker", "image", "rm", tag], capture_output=True, timeout=30)
        subprocess.run(["docker", "image", "rm", task_tag], capture_output=True, timeout=30)
        after = json.loads(command("docker", "info", "--format", "{{json .}}", capture=True).stdout)
        if before["DefaultRuntime"] != after["DefaultRuntime"] or before["Runtimes"] != after["Runtimes"]:
            raise RuntimeError("Outer Docker runtime configuration changed during fixture execution")


if __name__ == "__main__":
    main()
