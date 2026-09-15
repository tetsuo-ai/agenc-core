"""Real command-scope qualification inside the disposable nested Docker host.

This is an integration probe for the host runtime, not the complete AgenC
controller/filesystem/canonical-journal end-to-end acceptance test.
"""

from __future__ import annotations

import json
import base64
import errno
import os
import secrets
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, "/opt/agenc-execution/host")

from docker_api import DockerAPI
from filesystem import FilesystemWorker, FilesystemError, KIND_DIRECTORY, KIND_FILE
import filesystem as worker_protocol
from protocol import HostError, LEASE_ENV, peer_credentials, request


def recursive_guard_probe(filesystem, container):
    def task(script):
        return subprocess.run(["docker", "exec", container, "/usr/local/bin/python3", "-c", script],
                              check=True, capture_output=True, timeout=10)

    content = filesystem.stage_content(b"nested binary\x00\xff")
    guard = filesystem.capture("/app/recursive/one/two/file")
    assert guard["missingParents"] and not guard["existed"]
    task("import os; assert not os.path.exists('/app/recursive')")
    filesystem.assert_original(guard["handle"])
    filesystem.write(guard["handle"], 0, content)
    filesystem.assert_state(guard["handle"], content)
    task("assert open('/app/recursive/one/two/file','rb').read() == b'nested binary\\x00\\xff'")
    filesystem.release(guard["handle"])

    occupied = filesystem.capture("/app/claimed/one/file")
    task("import os; os.mkdir('/app/claimed')")
    try:
        filesystem.write(occupied["handle"], 0, content)
        raise AssertionError("A newly occupied ancestor was adopted")
    except FilesystemError as error:
        assert error.code == "path_conflict" and not error.mutation_started
    task("import os; assert not os.path.exists('/app/claimed/one')")
    filesystem.release(occupied["handle"])

    # The private reopen exchange supplies a deterministic window after mkdir
    # and descriptor binding, before the next component can be created.
    original_reopen = worker_protocol._reopen
    partial = filesystem.capture("/app/partial-parent/one/file")
    injected = False
    def fail_directory_sync(fd, flags):
        nonlocal injected
        if stat.S_ISDIR(os.fstat(fd).st_mode) and not injected:
            injected = True
            raise OSError(errno.EIO, "Injected directory acknowledgement failure")
        return original_reopen(fd, flags)
    worker_protocol._reopen = fail_directory_sync
    try:
        try:
            filesystem.write(partial["handle"], 0, content)
            raise AssertionError("Injected directory failure was ignored")
        except FilesystemError as error:
            assert injected and error.mutation_started, error.code
    finally:
        worker_protocol._reopen = original_reopen
        filesystem.release(partial["handle"])
    task("import os; assert os.path.isdir('/app/partial-parent'); assert not os.path.exists('/app/partial-parent/one')")

    swapped = filesystem.capture("/app/swapped-parent/one/file")
    injected = False
    def exchange_parent(fd, flags):
        nonlocal injected
        if stat.S_ISDIR(os.fstat(fd).st_mode) and not injected:
            injected = True
            task("import os; os.rename('/app/swapped-parent','/app/held-parent'); os.mkdir('/app/replacement-parent'); os.symlink('/app/replacement-parent','/app/swapped-parent')")
        return original_reopen(fd, flags)
    worker_protocol._reopen = exchange_parent
    try:
        try:
            filesystem.write(swapped["handle"], 0, content)
            raise AssertionError("A replacement parent redirected creation")
        except FilesystemError as error:
            assert injected and error.code == "path_conflict" and error.mutation_started
    finally:
        worker_protocol._reopen = original_reopen
        filesystem.release(swapped["handle"])
    task("import os; assert os.listdir('/app/replacement-parent') == []; assert os.listdir('/app/held-parent') == []")
    for invalid in ("/app/missing-dot/../file", "/app/missing-trailing/file/"):
        try:
            filesystem.capture(invalid)
            raise AssertionError("Invalid missing-ancestor traversal was captured")
        except FilesystemError as error:
            assert not error.mutation_started
    filesystem.release(content)
    print("Recursive file guards: read-only capture, nested binary create, occupied ancestor refusal, partial-directory effect evidence and held-parent exchange fencing passed", flush=True)


def main() -> None:
    api = DockerAPI()
    inspected = api.inspect("agenc-task")
    configuration = {
        "runcPath": "/opt/agenc-execution/bin/runc-1.5.1",
        "runcSha256": "177df879d50c913eb205e898d5c1c05a18f574053c0ce5524c471208eaf06f6f",
        "stateRoot": "/var/lib/agenc-execution", "socketRoot": "/run/agenc-execution",
        "launchRoot": "/sys/fs/cgroup/agenc-execution-launches",
        "dockerSocket": "/var/run/docker.sock", "controllerUids": [0], "controllerGid": 0,
        "protectedRoots": ["/opt/agenc-execution", "/etc/agenc-execution", "/controller"],
    }
    config_path = Path("/etc/agenc-execution/host.json")
    config_path.write_text(json.dumps(configuration))
    config_path.chmod(0o600)
    log = open("/var/lib/agenc-execution/supervisor.log", "ab", buffering=0)
    # A previous probe is terminal before this fixture is reused. Its sockets
    # are stale filesystem entries, not evidence of a live supervisor.
    for name in ("controller.sock", "runtime.sock"):
        Path("/run/agenc-execution", name).unlink(missing_ok=True)
    supervisor = subprocess.Popen(["/usr/bin/python3", "-B", "/opt/agenc-execution/host/supervisor.py"],
                                  stdout=log, stderr=log)
    filesystem = None
    endpoint = "/run/agenc-execution/controller.sock"
    try:
        deadline = time.monotonic() + 10
        while not Path(endpoint).exists():
            if supervisor.poll() is not None or time.monotonic() > deadline:
                raise AssertionError("Supervisor did not start; inspect supervisor.log")
            time.sleep(0.02)
        binding = request(endpoint, {"method": "bind", "container": "agenc-task"})["binding"]
        assert binding["containerId"] == inspected["Id"]
        assert supervisor.poll() is None
        request(endpoint, {"method": "authorize", "owner": "session-a", "generation": binding["generation"],
                           "authorityRevision": 0})
        print("bound private task generation", binding["generation"], flush=True)
        filesystem = FilesystemWorker.start(Path("/opt/agenc-execution/bin/agenc-filesystem-worker"), binding)
        worker_pid_namespace = os.stat(f"/proc/{filesystem.pid}/ns/pid").st_ino
        assert worker_pid_namespace == os.stat("/proc/self/ns/pid").st_ino
        assert worker_pid_namespace != binding["namespaces"]["pid"]
        worker_status = Path(f"/proc/{filesystem.pid}/status").read_text()
        assert "Seccomp:\t2" in worker_status and "NoNewPrivs:\t1" in worker_status, worker_status
        effective = next(line.split()[1] for line in worker_status.splitlines() if line.startswith("CapEff:"))
        assert int(effective, 16) == 14, effective
        print("native filesystem worker stays outside the task PID namespace", flush=True)
        counter = 0
        run_id = "kernel-probe-" + secrets.token_hex(8)

        def resolved_spec(args):
            env = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                   "HOSTNAME=" + inspected["Config"]["Hostname"]]
            for entry in inspected["Config"]["Env"]:
                name = entry.split("=", 1)[0]
                index = next((i for i, value in enumerate(env) if value.split("=", 1)[0] == name), None)
                if index is None:
                    env.append(entry)
                else:
                    env[index] = entry
            return {"args": args, "cwd": "/", "terminal": False, "env": env,
                    "user": {"uid": 0, "gid": 0}}

        def allocate(args, *, detached=False, owner="session-a", bindings=None):
            nonlocal counter
            counter += 1
            return request(endpoint, {"method": "allocate", "generation": binding["generation"],
                                      "owner": owner, "runId": run_id,
                                      "callId": str(counter), "attempt": 1,
                                      "authorityRevision": 0, "spec": resolved_spec(args), "detached": detached,
                                      **({"bindings": bindings} if bindings is not None else {})})

        def dispatch(lease, args):
            return subprocess.run(["docker", "exec", "--env", LEASE_ENV + "=" + lease["marker"],
                                   inspected["Id"], *args], capture_output=True, timeout=20)

        def inspect(lease):
            return request(endpoint, {"method": "inspect", "owner": "session-a",
                                      "operationId": lease["operationId"]})["operation"]

        def settled(lease):
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                receipt = inspect(lease)
                if receipt["state"] in ("stopped", "quarantined"):
                    assert receipt["cleanup_proven"], receipt
                    return receipt
                time.sleep(0.02)
            raise AssertionError(f"Cleanup did not settle: {inspect(lease)}")

        args = ["/bin/sh", "-c", "printf 'contained\\n'"]
        lease = allocate(args)
        result = dispatch(lease, args)
        assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
        assert result.stdout == b"contained\n", result.stdout
        receipt = settled(lease)
        assert receipt["leader_exited"], receipt
        assert supervisor.poll() is None
        assert filesystem.call(1), "Task cleanup killed the protected filesystem worker"
        print("managed exec, pidfd receipt and strict cleanup passed", flush=True)

        # A revoked, not-yet-claimed lease must execute no task instructions.
        args = ["/bin/sh", "-c", "touch /must-not-execute"]
        lease = allocate(args)
        response = request(endpoint, {"method": "stop", "owner": "session-a",
                                      "operationId": lease["operationId"]})
        assert response["terminated"] and response["cleanupProven"], response
        result = dispatch(lease, args)
        assert result.returncode != 0, result
        verification = subprocess.run(["docker", "exec", inspected["Id"], "/bin/sh", "-c",
                                       "test ! -e /must-not-execute"], capture_output=True, timeout=10)
        assert verification.returncode == 0, verification.stderr
        print("revocation before claim executed no instructions", flush=True)

        # The cleanup program deliberately matches its own filename in /proc.
        # Controller and supervisor live in this daemon host's parent namespace.
        cleanup = ("import os,signal\n"
                   "for entry in os.listdir('/proc'):\n"
                   " if not entry.isdigit(): continue\n"
                   " try:\n"
                   "  data=open('/proc/'+entry+'/cmdline','rb').read()\n"
                   "  if b'agenc-self-cleanup-2477.py' in data: os.kill(int(entry),signal.SIGKILL)\n"
                   " except (OSError,ProcessLookupError): pass\n")
        setup = subprocess.run(["docker", "exec", "-i", inspected["Id"], "/bin/sh", "-c",
                                "cat > /agenc-self-cleanup-2477.py"], input=cleanup.encode(),
                               capture_output=True, timeout=10)
        assert setup.returncode == 0, setup.stderr
        args = ["/usr/local/bin/python3", "/agenc-self-cleanup-2477.py"]
        lease = allocate(args)
        result = dispatch(lease, args)
        assert result.returncode == 137, (result.returncode, result.stdout, result.stderr)
        settled(lease)
        assert supervisor.poll() is None
        assert filesystem.call(1), "Task self-kill terminated the filesystem worker"
        args = ["/bin/sh", "-c", "printf 'subsequent-call-survived\\n'"]
        lease = allocate(args)
        result = dispatch(lease, args)
        assert result.returncode == 0 and result.stdout == b"subsequent-call-survived\n", result
        settled(lease)
        print("task-root filename cleanup and subsequent managed call passed", flush=True)

        daemon = ("import os,time\n"
                  "if os.fork()==0:\n"
                  " os.setsid()\n"
                  " if os.fork()==0:\n"
                  "  open('/forked-service.pid','w').write(str(os.getpid()))\n"
                  "  time.sleep(120)\n"
                  " os._exit(0)\n"
                  "time.sleep(.1)\n")
        args = ["/usr/local/bin/python3", "-c", daemon]
        lease = allocate(args)
        result = dispatch(lease, args)
        assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
        descendant_receipt = settled(lease)
        assert descendant_receipt["residual_processes_terminated"] == 1, descendant_receipt
        verification = subprocess.run(["docker", "exec", inspected["Id"], "/bin/sh", "-c",
                                       "p=$(cat /forked-service.pid); test ! -e /proc/$p/stat || "
                                       "test \"$(cut -d' ' -f3 /proc/$p/stat)\" = Z"],
                                      capture_output=True, timeout=10)
        assert verification.returncode == 0, verification.stderr
        print("double-fork and setsid descendants cleaned after leader exit", flush=True)

        args = ["/usr/local/bin/python3", "-c", "import time; time.sleep(120)"]
        lease = allocate(args)
        command = subprocess.Popen(["docker", "exec", "--env", LEASE_ENV + "=" + lease["marker"],
                                    inspected["Id"], *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 10
            while inspect(lease)["state"] != "running" or inspect(lease)["runtime_exit"] != 0:
                assert time.monotonic() < deadline and command.poll() is None, inspect(lease)
                time.sleep(.01)
            for method in ("inspect", "stop"):
                try:
                    request(endpoint, {"method": method, "operationId": lease["operationId"], "owner": "session-b"})
                    raise AssertionError("Foreign session acquired an owned handle")
                except HostError as error:
                    assert error.code == "owner_denied", error.code
            response = request(endpoint, {"method": "stop", "owner": "session-a",
                                          "operationId": lease["operationId"]})
            assert response["terminated"] and response["cleanupProven"], response
            stdout, stderr = command.communicate(timeout=10)
            # Cancellation can close the adapter after runc returned but before
            # Docker acknowledged exec start. Docker reports that window as an
            # OCI launch failure (128), not the leader's SIGKILL status (137).
            # Neither result may be used to repeat the operation.
            assert command.returncode in (128, 137), (command.returncode, stdout, stderr)
            if command.returncode == 128:
                assert b"OCI runtime exec failed" in stdout + stderr, (stdout, stderr)
            response = request(endpoint, {"method": "stop", "owner": "session-a",
                                          "operationId": lease["operationId"]})
            assert not response["terminated"] and response["cleanupProven"], response
        finally:
            if command.poll() is None:
                command.kill()
                command.communicate(timeout=10)
        print("strict running cancellation, foreign denial and stale stop passed", flush=True)

        # Ordinary Docker services and healthcheck-like execs retain environment
        # lifetime. Managed cancellation must not touch the container parent.
        service = subprocess.run(["docker", "exec", "-d", inspected["Id"], "/bin/sh", "-c",
                                  "echo $$ > /persistent-service.pid; exec sleep 120"],
                                 capture_output=True, timeout=10)
        assert service.returncode == 0, service.stderr
        args = ["/bin/sh", "-c", "exit 0"]
        lease = allocate(args)
        assert dispatch(lease, args).returncode == 0
        settled(lease)
        verification = subprocess.run(["docker", "exec", inspected["Id"], "/bin/sh", "-c",
                                       "kill -0 $(cat /persistent-service.pid)"],
                                      capture_output=True, timeout=10)
        assert verification.returncode == 0, verification.stderr
        print("ordinary Docker service survived managed cleanup", flush=True)

        args = ["/usr/local/bin/python3", "-c",
                "import os,sys; assert dict(os.environ)=={'LC_ALL':'C.UTF-8','EXACT':' α😃 '}, dict(os.environ); "
                "data=sys.stdin.buffer.read(); sys.stdout.buffer.write(data); sys.stderr.buffer.write(b'stderr')"]
        launch = {"method": "launch", "generation": binding["generation"], "owner": "session-a",
                  "runId": run_id, "callId": "supervisor-owned", "attempt": 1,
                  "authorityRevision": 0, "spec": {**resolved_spec(args), "env": ["LC_ALL=C.UTF-8", "EXACT= α😃 "]}}
        lease = request(endpoint, launch)
        content = b"\0\xffbinary\r\n" + " α😃\n ".encode()
        input_request = {"method": "input", "owner": "session-a", "operationId": lease["operationId"],
                         "authorityRevision": 0, "inputId": "input-call-1", "data": base64.b64encode(content).decode(), "eof": True}
        assert request(endpoint, input_request)["acknowledged"]
        assert request(endpoint, input_request)["acknowledged"]
        settled(lease)
        deadline = time.monotonic() + 10
        while not inspect(lease)["output_complete"]:
            assert time.monotonic() < deadline, inspect(lease)
            time.sleep(.02)
        first = request(endpoint, {"method": "output", "owner": "session-a",
                                   "operationId": lease["operationId"], "offset": 0})
        second = request(endpoint, {"method": "output", "owner": "session-a",
                                    "operationId": lease["operationId"], "offset": 0})
        assert first == second, "Inspecting output consumed it"
        raw = base64.b64decode(first["data"])
        stdout, stderr = bytearray(), bytearray()
        while raw:
            assert len(raw) >= 8 and raw[0] in (1, 2), raw
            size = int.from_bytes(raw[4:8], "big")
            assert len(raw) >= size + 8, raw
            (stdout if raw[0] == 1 else stderr).extend(raw[8:8 + size])
            raw = raw[8 + size:]
        assert bytes(stdout) == content and bytes(stderr) == b"stderr", (stdout, stderr)
        cursor = 0
        stdout, stderr = bytearray(), bytearray()
        while True:
            message = {"method": "decoded_output", "owner": "session-a", "operationId": lease["operationId"],
                       "offset": cursor, "maximum": 3}
            part = request(endpoint, message)
            assert part == request(endpoint, message), "Decoded cursor consumed retained evidence"
            if part["nextOffset"] == cursor:
                break
            stdout.extend(base64.b64decode(part["stdout"]))
            stderr.extend(base64.b64decode(part["stderr"]))
            cursor = part["nextOffset"]
        assert bytes(stdout) == content and bytes(stderr) == b"stderr", (stdout, stderr)
        lookup = request(endpoint, {**launch, "method": "lookup"})
        assert lookup["operationId"] == lease["operationId"]
        try:
            request(endpoint, launch)
            raise AssertionError("An existing run/call/attempt was dispatched twice")
        except HostError as error:
            assert error.code == "operation_exists", error.code
        print("supervisor dispatch, binary stdin/EOF, retained output and no replay passed", flush=True)

        terminal_args = ["/usr/local/bin/python3", "-c",
                         "import sys,fcntl,termios,struct; assert sys.stdin.isatty(); "
                         "sys.stdin.readline(); print(struct.unpack('HHHH',fcntl.ioctl(1,termios.TIOCGWINSZ,b'\\0'*8))[:2],flush=True)"]
        terminal_launch = {**launch, "callId": "terminal-resize", "spec": {**resolved_spec(terminal_args), "terminal": True}}
        terminal = request(endpoint, terminal_launch)
        request(endpoint, {"method": "resize", "owner": "session-a", "operationId": terminal["operationId"],
                           "authorityRevision": 0, "columns": 93, "rows": 41})
        request(endpoint, {"method": "input", "owner": "session-a", "operationId": terminal["operationId"],
                           "authorityRevision": 0, "inputId": "terminal-line", "data": base64.b64encode(b"go\n").decode()})
        settled(terminal)
        deadline = time.monotonic() + 10
        while not inspect(terminal)["output_complete"]:
            assert time.monotonic() < deadline, inspect(terminal)
            time.sleep(.02)
        terminal_output = request(endpoint, {"method": "decoded_output", "owner": "session-a",
                                            "operationId": terminal["operationId"], "offset": 0})
        assert b"(41, 93)" in base64.b64decode(terminal_output["stdout"]), terminal_output
        assert terminal_output["stderr"] == "", terminal_output
        print("PTY input, resize and retained terminal output passed", flush=True)

        # sh -c takes its own $0 argument; inspect the kernel argv separately
        # with Python so the alternate executable argv[0] is actually verified.
        argv_args = ["/usr/local/bin/python3", "-c",
                     "import sys; assert open('/proc/self/cmdline','rb').read().split(b'\\0')[0]==b'custom-task'; "
                     "assert sys.argv[1:]==['',' α😃\\n ']; print('exact argv',flush=True)", "", " α😃\n "]
        argv_lease = request(endpoint, {**launch, "callId": "alternate-argv0",
                                       "spec": {**resolved_spec(argv_args), "argv0": "custom-task"}})
        settled(argv_lease)
        deadline = time.monotonic() + 10
        while not inspect(argv_lease)["output_complete"]:
            assert time.monotonic() < deadline, inspect(argv_lease)
            time.sleep(.02)
        assert inspect(argv_lease)["exit_code"] == 0, inspect(argv_lease)
        print("private native bootstrap preserves alternate argv[0] and empty/Unicode arguments", flush=True)

        close_owner = "session-close"
        authority = {"owner": close_owner, "generation": binding["generation"], "authorityRevision": 0}
        request(endpoint, {"method": "authorize", **authority})
        close_launch = {**launch, **authority, "spec": resolved_spec(["/bin/sleep", "120"])}
        command_lease = request(endpoint, {**close_launch, "callId": "close-command"})
        service_lease = request(endpoint, {**close_launch, "callId": "close-service", "detached": True})
        delayed = request(endpoint, {**close_launch, "method": "allocate", "callId": "close-delayed"})

        def close_receipt(lease):
            return request(endpoint, {"method": "inspect", "owner": close_owner,
                                      "operationId": lease["operationId"]})["operation"]

        deadline = time.monotonic() + 10
        while any(close_receipt(value)["state"] != "running" for value in (command_lease, service_lease)):
            assert time.monotonic() < deadline
            time.sleep(.02)
        assert request(endpoint, {"method": "close", **authority})["cleanupProven"]
        assert close_receipt(command_lease)["cleanup_proven"]
        assert close_receipt(delayed)["cleanup_proven"]
        assert not close_receipt(service_lease)["cleanup_proven"] and close_receipt(service_lease)["state"] == "running"
        assert dispatch(delayed, ["/bin/sleep", "120"]).returncode != 0
        for message in ({**close_launch, "callId": "closed-launch"}, {"method": "authorize", **authority}):
            try:
                request(endpoint, message)
                raise AssertionError("Closed authority admitted a new command")
            except HostError as error:
                assert error.code == "invalid_authority", error.code
        assert request(endpoint, {"method": "stop", "owner": close_owner,
                                  "operationId": service_lease["operationId"]})["cleanupProven"]
        print("owner close fences delayed launches, drains commands and preserves detached services", flush=True)

        setup = subprocess.run(["docker", "exec", inspected["Id"], "/bin/sh", "-c",
                                "mkdir -p /app/dir /elsewhere; printf original > /app/dir/file; "
                                "printf absolute > /elsewhere/file; ln -s /elsewhere/file /app/absolute; "
                                "ln -s ../../elsewhere/file /app/dir/relative; "
                                "mkfifo /app/fifo; mknod /app/device c 1 3"], capture_output=True, timeout=10)
        assert setup.returncode == 0, setup.stderr
        assert stat.S_ISDIR(int(filesystem.inspect_path("/app/dir")["mode"]))
        assert stat.S_ISREG(int(filesystem.inspect_path("/app/absolute")["mode"]))
        assert stat.S_ISLNK(int(filesystem.inspect_path("/app/absolute", False)["mode"]))
        assert filesystem.inspect_path("/app/absolute") == filesystem.inspect_path("/elsewhere/file")
        try:
            filesystem.inspect_path("/app/missing")
            raise AssertionError("Missing path metadata was fabricated")
        except FilesystemError as error:
            assert error.code == "not_found", error.code
        directory = filesystem.bind("/app/dir", KIND_DIRECTORY)
        dotted_directory = filesystem.bind("/app/dir/.", KIND_DIRECTORY)
        dotted_parent = filesystem.bind("../absolute", base=dotted_directory["handle"])
        assert filesystem.read(dotted_parent["handle"], 0) == b"absolute"
        original = filesystem.bind("file", base=directory["handle"])
        assert filesystem.read(original["handle"], 0) == b"original"
        absolute = filesystem.bind("../absolute", base=directory["handle"])
        relative = filesystem.bind("relative", base=directory["handle"])
        assert filesystem.read(absolute["handle"], 0) == b"absolute"
        assert filesystem.read(relative["handle"], 0) == b"absolute"
        for path in ("/app/fifo", "/app/device", "/proc/self/status", "/sys/kernel", "/dev/null"):
            for follow in (True, False):
                try:
                    filesystem.inspect_path(path, follow)
                    raise AssertionError(f"Special-resource metadata was accepted: {path}")
                except FilesystemError as error:
                    assert error.code == "unsupported_resource", (path, error.code)
            try:
                filesystem.bind(path)
                raise AssertionError(f"Special resource was accepted: {path}")
            except FilesystemError as error:
                assert error.code == "unsupported_resource", (path, error.code)
        guard = filesystem.capture("/app/dir/file")
        assert filesystem.expected(guard["handle"], 0) == b"original"
        expected = filesystem.stage_content(b"original")
        changed = filesystem.stage_content(b"changed\x00\xff")
        filesystem.assert_state(guard["handle"], expected)
        filesystem.assert_original(guard["handle"])
        filesystem.write(guard["handle"], expected, changed)
        try:
            filesystem.assert_original(guard["handle"])
            raise AssertionError("Changed content passed the original-state assertion")
        except FilesystemError as error:
            assert error.code == "path_conflict" and not error.mutation_started
        shell_view = subprocess.run(["docker", "exec", inspected["Id"], "/bin/cat", "/app/dir/file"],
                                    capture_output=True, timeout=10)
        assert shell_view.returncode == 0 and shell_view.stdout == b"changed\x00\xff", shell_view
        filesystem.assert_state(guard["handle"], changed)
        filesystem.remove(guard["handle"], changed)
        filesystem.assert_state(guard["handle"], 0)
        filesystem.write(guard["handle"], 0, expected)
        filesystem.assert_state(guard["handle"], expected)
        try:
            filesystem.assert_original(guard["handle"])
            raise AssertionError("A recreated file with equal bytes passed the original inode assertion")
        except FilesystemError as error:
            assert error.code == "path_conflict" and not error.mutation_started
        unlinked = filesystem.capture("/app/dir/file")
        subprocess.run(["docker", "exec", inspected["Id"], "/bin/rm", "/app/dir/file"], check=True, timeout=10)
        filesystem.write(unlinked["handle"], 0, changed)
        filesystem.assert_state(unlinked["handle"], changed)
        filesystem.write(unlinked["handle"], changed, expected)
        filesystem.assert_state(unlinked["handle"], expected)
        # Subsequent parent-swap qualification must use the latest target inode.
        filesystem.release(guard["handle"])
        guard = filesystem.capture("/app/dir/file")
        print("shared shell/file view, absolute symlinks, binary mutation and special-resource rejection passed", flush=True)
        recursive_guard_probe(filesystem, inspected["Id"])

        stream_path = "/app/live-stream-log"
        subprocess.run(["docker", "exec", inspected["Id"], "/usr/local/bin/python3", "-c",
                        "open('/app/live-stream-log','wb').write(b'first')"], check=True, timeout=10)
        live_file = filesystem.bind(stream_path)
        subprocess.run(["docker", "exec", inspected["Id"], "/usr/local/bin/python3", "-c",
                        "open('/app/live-stream-log','ab').write(b'second')"], check=True, timeout=10)
        try:
            filesystem.export_handle(live_file["handle"], KIND_FILE)
            raise AssertionError("Version-bound input export accepted appended content")
        except HostError as error:
            assert error.code == "path_conflict", error.code
        stream_fd, _ = filesystem.export_stream(live_file["handle"])
        try:
            assert os.pread(stream_fd, 20, 0) == b"firstsecond"
            try:
                os.write(stream_fd, b"not authorized")
                raise AssertionError("Live stream descriptor retained write authority")
            except OSError as error:
                assert error.errno == 9, error
            subprocess.run(["docker", "exec", inspected["Id"], "/usr/local/bin/python3", "-c",
                            "import os;os.rename('/app/live-stream-log','/app/live-stream-held');"
                            "open('/app/live-stream-log','wb').write(b'replacement');"
                            "open('/app/live-stream-held','ab').write(b'third')"], check=True, timeout=10)
            assert os.pread(stream_fd, 20, 0) == b"firstsecondthird"
        finally:
            os.close(stream_fd)
            filesystem.release(live_file["handle"])
        print("Protected live-log export retains read-only inode identity through append and replacement; version-bound input remains strict", flush=True)

        swap = subprocess.run(["docker", "exec", inspected["Id"], "/bin/sh", "-c",
                               "mv /app/dir /app/moved; mkdir /app/dir; printf replacement > /app/dir/file"],
                              capture_output=True, timeout=10)
        assert swap.returncode == 0, swap.stderr
        held = filesystem.bind("file", base=directory["handle"])
        assert filesystem.read(held["handle"], 0) == b"original", "Bound directory followed a swapped parent pathname"
        try:
            filesystem.write(guard["handle"], expected, changed)
            raise AssertionError("Mutation accepted an exchanged parent")
        except FilesystemError as error:
            assert error.code == "path_conflict" and not error.mutation_started, error.code
        replacement = filesystem.bind("/app/dir/file")
        assert filesystem.read(replacement["handle"], 0) == b"replacement"
        filesystem.release(replacement["handle"])
        try:
            filesystem.read(replacement["handle"], 0)
            raise AssertionError("Released filesystem capability remained usable")
        except FilesystemError as error:
            assert error.code == "path_conflict", error.code
        print("held directory identity, parent-swap rejection and stale capabilities passed", flush=True)

        connection = {"method": "filesystem", "owner": "session-a", "generation": binding["generation"],
                      "authorityRevision": 0}
        worker_id = request(endpoint, {**connection, "operation": "connect"})["workerId"]
        def fs_rpc(operation, arguments=None, **extra):
            return request(endpoint, {**connection, "workerId": worker_id, "operation": operation,
                                      "arguments": arguments or {}, **extra})
        remote_guard = fs_rpc("capture", {"path": "/app/remote-file"})
        assert stat.S_ISLNK(int(fs_rpc("inspect_path", {"path": "/app/absolute", "followSymlinks": False})["stats"]["mode"]))
        for invalid in (None, 0, "false"):
            try:
                fs_rpc("inspect_path", {"path": "/app/absolute", "followSymlinks": invalid})
                raise AssertionError("Invalid symlink policy was accepted")
            except HostError as error:
                assert error.code == "invalid_request", error.code
        staged = fs_rpc("stage")["handle"]
        fs_rpc("append", {"handle": staged, "offset": 0, "data": base64.b64encode(b"remote mutation").decode()})
        fs_rpc("seal", {"handle": staged})
        effect = {"runId": run_id, "callId": "filesystem-write", "attempt": 1}
        mutation = {"handle": remote_guard["handle"], "expected": 0, "content": staged}
        fs_rpc("write", mutation, effect=effect)
        receipt = request(endpoint, {"method": "filesystem_effect", "owner": "session-a",
                                     "generation": binding["generation"], "effect": effect})["effect"]
        assert receipt["state"] == "acknowledged" and receipt["result"]["ok"], receipt
        try:
            fs_rpc("write", mutation, effect=effect)
            raise AssertionError("Filesystem mutation was replayed")
        except HostError as error:
            assert error.code == "operation_exists", error.code
        remote_file = fs_rpc("bind", {"path": "/app/remote-file", "kind": "file"})
        assert base64.b64decode(fs_rpc("read", {"handle": remote_file["handle"], "offset": 0})["data"]) == b"remote mutation"
        request(endpoint, {"method": "authorize", "owner": "session-b", "generation": binding["generation"], "authorityRevision": 0})
        request(endpoint, {**connection, "owner": "session-b", "operation": "connect"})
        try:
            request(endpoint, {**connection, "owner": "session-b", "workerId": worker_id,
                               "operation": "read", "arguments": {"handle": remote_file["handle"], "offset": 0}})
            raise AssertionError("Foreign session read another worker's capability")
        except HostError as error:
            assert error.code == "stale_capability", error.code
        try:
            request(endpoint, {**connection, "owner": "session-b", "workerId": worker_id,
                               "operation": "inspect_path", "arguments": {"path": "/app/remote-file"}})
            raise AssertionError("Foreign session inspected another worker's task path")
        except HostError as error:
            assert error.code == "stale_capability", error.code
        print("owner-scoped filesystem RPC, durable mutation receipt and no mutation replay passed", flush=True)

        # Pause at allocation, before Docker creates an exec. Releasing the
        # original capabilities must leave the lease's own held descriptors.
        subprocess.run(["docker", "exec", inspected["Id"], "/usr/local/bin/python3", "-c",
                        "import os; os.mkdir('/app/handoff'); open('/app/handoff/input','wb').write(b'held\\x00\\xff')"],
                       check=True, timeout=10)
        def handoff_bindings():
            directory = fs_rpc("bind", {"path": "/app/handoff", "kind": "directory"})
            source = fs_rpc("bind", {"path": "/app/handoff/input", "kind": "file"})
            return {"cwd": {"workerId": worker_id, "handle": directory["handle"]},
                    "stdin": {"workerId": worker_id, "handle": source["handle"]}}, source["stats"]

        def release_bindings(bound):
            for source in bound.values():
                fs_rpc("release", {"handle": source["handle"]})

        def retained_source_count(identity):
            count = 0
            for entry in Path(f"/proc/{supervisor.pid}/fd").iterdir():
                try:
                    value = entry.stat()
                    count += (str(value.st_dev), str(value.st_ino)) == (identity["dev"], identity["ino"])
                except FileNotFoundError:
                    pass  # Other RPC connections can finish during enumeration.
            return count

        bound, source_identity = handoff_bindings()
        args = ["/usr/local/bin/python3", "-c",
                "import os,sys; assert os.getcwd()=='/app/handoff-moved'; sys.stdout.buffer.write(sys.stdin.buffer.read())"]
        lease = allocate(args, bindings=bound)
        release_bindings(bound)
        assert retained_source_count(source_identity) == 1, "Lease did not retain its own file description"
        subprocess.run(["docker", "exec", inspected["Id"], "/usr/local/bin/python3", "-c",
                        "import os; os.rename('/app/handoff','/app/handoff-moved'); os.mkdir('/app/handoff'); "
                        "open('/app/handoff/input','wb').write(b'replacement')"], check=True, timeout=10)
        result = dispatch(lease, args)
        assert result.returncode == 0 and result.stdout == b"held\x00\xff", (result.returncode, result.stdout, result.stderr)
        settled(lease)
        assert retained_source_count(source_identity) == 0, "Claim left an unowned host descriptor"

        # Both ordinary and detached allocations are revocable before claim.
        # Empty command cgroups alone cannot release in-flight launch authority.
        for detached in (False, True):
            bound, source_identity = handoff_bindings()
            args = ["/bin/sh", "-c", "touch /bound-must-not-execute"]
            if detached:
                try:
                    allocate(args, bindings=bound, detached=True)
                    raise AssertionError("Detached service accepted bound stdin")
                except HostError as error:
                    assert error.code == "invalid_process", error.code
            lease = allocate(args, bindings={"cwd": bound["cwd"]} if detached else bound, detached=detached)
            release_bindings(bound)
            assert retained_source_count(source_identity) == (0 if detached else 1)
            stopped = request(endpoint, {"method": "stop", "owner": "session-a", "operationId": lease["operationId"]})
            assert stopped["terminated"] and stopped["cleanupProven"], stopped
            assert retained_source_count(source_identity) == 0, "Revocation leaked a task file descriptor"
            assert dispatch(lease, args).returncode != 0, "Revoked file handoff executed target instructions"

        # A retained inode does not authorize input changed after allocation.
        bound, source_identity = handoff_bindings()
        args = ["/bin/sh", "-c", "touch /bound-must-not-execute"]
        lease = allocate(args, bindings=bound)
        release_bindings(bound)
        subprocess.run(["docker", "exec", inspected["Id"], "/usr/local/bin/python3", "-c",
                        "open('/app/handoff/input','wb').write(b'changed after allocation')"], check=True, timeout=10)
        result = dispatch(lease, args)
        assert result.returncode != 0, result
        settled(lease)
        assert retained_source_count(source_identity) == 0
        verification = subprocess.run(["docker", "exec", inspected["Id"], "/bin/sh", "-c",
                                       "test ! -e /bound-must-not-execute"], capture_output=True, timeout=10)
        assert verification.returncode == 0, verification.stderr

        bound, _ = handoff_bindings()
        try:
            allocate(args, bindings=bound, owner="session-b")
            raise AssertionError("Foreign owner acquired held task descriptors")
        except HostError as error:
            assert error.code == "stale_capability", error.code
        release_bindings(bound)
        try:
            allocate(args, bindings=bound)
            raise AssertionError("A released task capability was reacquired")
        except HostError as error:
            assert error.code == "path_conflict", error.code
        print("native held-file launch: parent swap, released capabilities, strict revocation, changed input and ownership passed", flush=True)

        request(endpoint, {"method": "authorize", "owner": "session-a", "generation": binding["generation"],
                           "authorityRevision": 1})
        connection["authorityRevision"] = 1
        replacement_worker = request(endpoint, {**connection, "operation": "connect"})["workerId"]
        assert replacement_worker != worker_id
        try:
            fs_rpc("read", {"handle": remote_file["handle"], "offset": 0})
            raise AssertionError("A capability from the previous authority revision was accepted")
        except HostError as error:
            assert error.code == "stale_capability", error.code
        worker_id = replacement_worker
        print("authority revision invalidates filesystem worker capabilities", flush=True)

        second = subprocess.run(["docker", "run", "-d", "--runtime=agenc-runc", "--network=none",
                                 "--security-opt=apparmor=unconfined", "--name=agenc-task-2",
                                 inspected["Config"]["Image"], "sleep", "infinity"], capture_output=True, timeout=20)
        assert second.returncode == 0, second.stderr
        binding2 = request(endpoint, {"method": "bind", "container": "agenc-task-2"})["binding"]
        assert binding2["generation"] != binding["generation"]
        request(endpoint, {"method": "authorize", "owner": "session-two", "generation": binding2["generation"],
                           "authorityRevision": 0})
        connection2 = {"method": "filesystem", "owner": "session-two", "generation": binding2["generation"],
                       "authorityRevision": 0}
        worker2 = request(endpoint, {**connection2, "operation": "connect"})["workerId"]
        for target, content in ((inspected["Id"], "environment-one"), (binding2["containerId"], "environment-two")):
            setup = subprocess.run(["docker", "exec", target, "/bin/sh", "-c",
                                    "mkdir -p /app; printf '%s' \"$1\" > /app/shared.txt", "fixture", content],
                                   capture_output=True, timeout=10)
            assert setup.returncode == 0, setup.stderr
        first_file = fs_rpc("bind", {"path": "/app/shared.txt", "kind": "file"})
        second_file = request(endpoint, {**connection2, "workerId": worker2, "operation": "bind",
                                         "arguments": {"path": "/app/shared.txt", "kind": "file"}})
        assert base64.b64decode(fs_rpc("read", {"handle": first_file["handle"], "offset": 0})["data"]) == b"environment-one"
        second_read = {**connection2, "workerId": worker2, "operation": "read",
                       "arguments": {"handle": second_file["handle"], "offset": 0}}
        assert base64.b64decode(request(endpoint, second_read)["data"]) == b"environment-two"
        print("separate environments retain independent /app workspaces", flush=True)
        broad = ["/usr/local/bin/python3", "-c", "import os,signal; os.kill(-1,signal.SIGKILL)"]
        broad_lease = request(endpoint, {**launch, "callId": "broad-signal", "authorityRevision": 1,
                                         "spec": resolved_spec(broad)})
        settled(broad_lease)
        assert supervisor.poll() is None and filesystem.call(1)
        assert base64.b64decode(fs_rpc("read", {"handle": first_file["handle"], "offset": 0})["data"]) == b"environment-one"
        print("broad task-root SIGKILL leaves the controller, supervisor and filesystem workers alive", flush=True)
        killed = subprocess.run(["docker", "kill", binding2["containerId"]], capture_output=True, timeout=10)
        assert killed.returncode == 0, killed.stderr
        try:
            request(endpoint, second_read)
            raise AssertionError("Filesystem capability survived environment death")
        except HostError as error:
            assert error.code == "environment_dead", error.code
        assert api.inspect(binding2["containerId"])["State"]["Running"] is False
        assert supervisor.poll() is None
        print("environment death invalidates filesystem access without reprovisioning", flush=True)

        controller_root = "/opt/agenc-execution/probe-node"
        Path("/controller").mkdir(mode=0o700, exist_ok=True)
        subprocess.run([controller_root + "/ld-linux-x86-64.so.2", "--library-path", controller_root,
                        controller_root + "/node", controller_root + "/controller-probe.mjs"],
                       check=True, timeout=90, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        assert supervisor.poll() is None and filesystem.call(1)

        recovery_controller = [controller_root + "/ld-linux-x86-64.so.2", "--library-path", controller_root,
                               controller_root + "/node", controller_root + "/controller-probe.mjs"]
        crashed = subprocess.run([*recovery_controller, "--managed-recovery-start"], timeout=30,
                                 env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        assert crashed.returncode == -signal.SIGKILL, crashed.returncode
        recovery = json.loads(Path("/controller/managed-recovery.json").read_text())["state"]
        with sqlite3.connect("file:/var/lib/agenc-execution/receipts.sqlite?mode=ro", uri=True) as receipts:
            def original_inputs():
                return receipts.execute("SELECT input_id,digest,state FROM inputs WHERE operation_id=? ORDER BY input_id",
                                        (recovery["entries"][0]["operationId"],)).fetchall()
            inputs_before = original_inputs()
            assert len(inputs_before) == 1 and inputs_before[0][2] == "acknowledged", inputs_before
            subprocess.run([*recovery_controller, "--managed-recovery-restore"], check=True, timeout=30,
                           env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
            assert original_inputs() == inputs_before, "Recovery repeated input or EOF"
            assert receipts.execute("SELECT count(*) FROM operations WHERE owner=?", (recovery["ownerId"],)).fetchone()[0] == 1
        assert supervisor.poll() is None and filesystem.call(1)
        print("Controller crash recovery retained exactly one launch and one original EOF receipt", flush=True)

        service = json.loads(Path("/controller/detached-restart.json").read_text())
        service_request = {"owner": service["owner"], "operationId": service["operationId"],
                           "processHandleNamespace": service["binding"]["processHandleNamespace"]}
        original_service = request(endpoint, {**service_request, "method": "inspect"})["operation"]
        assert original_service["session_id"] == service["sessionId"]
        original_output = request(endpoint, {**service_request, "method": "decoded_output", "offset": 0})
        offset = original_output["nextOffset"]
        fork_request = {**service_request, "operationId": service["fork"]["operationId"]}
        fork_offset = 0
        for restart_index, abrupt in enumerate((False, True, True)):
            replaced_log = restart_index == 2
            if replaced_log:
                retained_prefix = request(endpoint, {"method": "decoded_output", **service_request, "offset": 0, "maximum": offset})
                replacement = subprocess.run(["docker", "exec", inspected["Id"], "/usr/local/bin/python3", "-c",
                    "import os,sys\nos.unlink(sys.argv[1]);open(sys.argv[1],'wb').write(b'forged replacement')", service["logPath"]],
                    capture_output=True, timeout=10)
                assert replacement.returncode == 0, replacement.stderr
            if abrupt:
                supervisor.kill()
            else:
                supervisor.terminate()
            supervisor.wait(timeout=15)
            # Verification is an ordinary Docker operation inside this fixture;
            # no task command is dispatched again through its managed identity.
            verification = subprocess.run(["docker", "exec", inspected["Id"], "/usr/local/bin/python3", "-c",
                "import os,sys,time\np=int(sys.argv[1]);log=sys.argv[2]\n"
                "output='/proc/'+str(p)+'/fd/1'\nassert os.path.exists('/proc/'+str(p))\n"
                "assert os.path.samefile(output,log)==(sys.argv[4]=='original')\n"
                "before=os.stat(output).st_size\ntime.sleep(.15)\nassert os.stat(output).st_size>before\n"
                "assert open(sys.argv[3]).read()=='started\\n'", str(service["pid"]), service["logPath"], service["startsPath"],
                "replacement" if replaced_log else "original"],
                capture_output=True, timeout=10)
            assert verification.returncode == 0, verification.stderr
            supervisor = subprocess.Popen(["/usr/bin/python3", "-B", "/opt/agenc-execution/host/supervisor.py"], stdout=log, stderr=log)
            deadline = time.monotonic() + 15
            while True:
                assert supervisor.poll() is None and time.monotonic() < deadline, "Restarted supervisor did not become ready"
                try:
                    capabilities = request(endpoint, {"method": "capabilities", **service_request}, timeout=1)
                    break
                except (HostError, OSError):
                    time.sleep(.02)
            assert capabilities["processHandleNamespace"] == service["binding"]["processHandleNamespace"]
            original = request(endpoint, {"method": "lookup", **service_request, "generation": service["binding"]["generation"],
                                         "runId": service["runId"], "callId": service["callId"], "attempt": service["attempt"]})
            assert original["operationId"] == service["operationId"]
            restored = request(endpoint, {"method": "inspect", **service_request})["operation"]
            assert restored["session_id"] == service["sessionId"] and not restored["cleanup_proven"], restored
            assert restored["detachedService"]["pid"] == service["pid"], restored
            fork_receipt = request(endpoint, {"method": "inspect", **fork_request})["operation"]
            assert fork_receipt["session_id"] == service["fork"]["sessionId"] and fork_receipt["exit_code"] == 0, fork_receipt
            assert fork_receipt["leader_exited"] and not fork_receipt["cleanup_proven"] and not fork_receipt["output_complete"], fork_receipt
            assert "pid" not in fork_receipt["detachedService"], fork_receipt
            fork_output = request(endpoint, {"method": "decoded_output", **fork_request, "offset": fork_offset})
            assert b"fork-heartbeat" in base64.b64decode(fork_output["stdout"]), fork_output
            fork_offset = fork_output["nextOffset"]
            verification = subprocess.run(["docker", "exec", inspected["Id"], "/usr/local/bin/python3", "-c",
                "import os,sys\nassert os.path.exists('/proc/'+sys.argv[1])\nassert open(sys.argv[2]).read()=='started\\n'",
                str(service["fork"]["pid"]), service["fork"]["startsPath"]], capture_output=True, timeout=10)
            assert verification.returncode == 0, verification.stderr
            if replaced_log:
                assert request(endpoint, {"method": "decoded_output", **service_request, "offset": 0, "maximum": offset}) == retained_prefix
                try:
                    request(endpoint, {"method": "decoded_output", **service_request, "offset": offset})
                    raise AssertionError("Replacement task log was accepted as original output")
                except HostError as error:
                    assert error.code == "output_unavailable", error.code
            else:
                output = request(endpoint, {"method": "decoded_output", **service_request, "offset": offset})
                assert output["nextOffset"] > offset and b"heartbeat:" in base64.b64decode(output["stdout"]), output
                offset = output["nextOffset"]
            assert filesystem.call(1)
        Path("/var/lib/agenc-execution/detached-restart-receipt.json").write_text(json.dumps(restored))
        assert request(endpoint, {"method": "stop", **service_request})["cleanupProven"]
        assert request(endpoint, {"method": "stop", **fork_request})["cleanupProven"]
        print("Detached services and double-fork/setsid descendants retain task PID/log across owner close and supervisor restarts; original handles/cursors recover without replay, retained host output survives task-log replacement", flush=True)

        failure_args = ["/usr/local/bin/python3", "-c", "import time; print('before daemon failure',flush=True); time.sleep(120)"]
        failure_launch = {**launch, "callId": "daemon-failure", "authorityRevision": 1, "spec": resolved_spec(failure_args)}
        failure_lease = request(endpoint, failure_launch)
        output_request = {"method": "decoded_output", "owner": "session-a",
                          "operationId": failure_lease["operationId"], "offset": 0}
        deadline = time.monotonic() + 10
        while b"before daemon failure" not in base64.b64decode(request(endpoint, output_request)["stdout"]):
            assert time.monotonic() < deadline, inspect(failure_lease)
            time.sleep(.02)
        # This endpoint and PID are inside the disposable host, whose PID 1 is
        # an independent fixture keeper. No outer Docker control socket exists.
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
            channel.connect(api.socket_path)
            daemon_pid, _, _ = peer_credentials(channel)
            assert daemon_pid not in (1, os.getpid(), supervisor.pid)
            assert Path(f"/proc/{daemon_pid}/comm").read_text().strip() == "dockerd"
            os.kill(daemon_pid, signal.SIGKILL)
        deadline = time.monotonic() + 15
        while not inspect(failure_lease)["failure"] or not inspect(failure_lease)["cleanup_proven"]:
            assert time.monotonic() < deadline, inspect(failure_lease)
            time.sleep(.02)
        failure_receipt = inspect(failure_lease)
        assert not failure_receipt["output_complete"] and failure_receipt["exit_code"] is None, failure_receipt
        assert b"before daemon failure" in base64.b64decode(request(endpoint, output_request)["stdout"])
        assert request(endpoint, {**failure_launch, "method": "lookup"})["operationId"] == failure_lease["operationId"]
        assert supervisor.poll() is None and filesystem.call(1)
        print("Docker daemon death preserves supervisor, worker, original output and explicit incomplete outcome", flush=True)
    finally:
        if filesystem is not None:
            filesystem.close()
        supervisor.terminate()
        supervisor.wait(timeout=15)
        log.close()


if __name__ == "__main__":
    main()
