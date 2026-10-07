"""Native AGB3 controls. Run in the Linux kernel gate; no optional skips."""
from pathlib import Path
import fcntl
import json
import os
import select
import signal
import struct
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
TEMP = tempfile.TemporaryDirectory(prefix="agenc-broker-v3-")
D = Path(TEMP.name)
DIST = D / "dist"
DIST.mkdir()
BROKER = DIST / "agenc-process-broker"
PLACEHOLDER = DIST / "agenc-namespace-init-entry"
MARKER = b"AGENC_NAMESPACE_INIT_ENTRY_V1\n"
PLACEHOLDER.write_bytes(MARKER)
HELPER = D / "init"
subprocess.run(["cc", "-static", "-Os", "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-o", str(HELPER), str(ROOT / "native/agenc-namespace-init.c")], check=True)
HEADER = D / "image.h"
HEADER.write_text("static const unsigned char agenc_namespace_init_image[] = {" +
                  ",".join(str(x) for x in HELPER.read_bytes()) + "};\n")
subprocess.run(["cc", "-O2", "-std=c11", "-Wall", "-Wextra", "-Werror",
               '-DAGENC_NAMESPACE_INIT_IMAGE_HEADER="' + str(HEADER) + '"',
               "-o", str(BROKER), str(ROOT / "native/agenc-process-broker.c")], check=True)
RECORDS = []


def frame(command, *, bpf=None, mutations=None, env=None):
    args = ["/usr/bin/bwrap", "--new-session", "--die-with-parent",
            "--ro-bind", "/", "/", "--dir", str(D), "--ro-bind", str(DIST), str(DIST),
            "--dev", "/dev", "--unshare-user", "--unshare-pid", "--unshare-net",
            "--proc", "/proc"]
    if bpf is not None:
        args += ["--seccomp", "3"]
    if mutations:
        args = mutations(args)
    args += ["--", *command]
    environment = ["PATH=/usr/bin:/bin", "LANG=C"] if env is None else env
    strings = [args[0], *args, *environment]
    mapping = b"" if bpf is None else struct.pack(">IIII", 5, 3, 1, len(bpf))
    body = mapping + b"".join(value.encode() + b"\0" for value in strings) + (bpf or b"")
    return b"AGB3" + struct.pack(">IIIIII", len(body), len(args), len(environment),
                                  0, int(bpf is not None), os.getpid()) + body + b"\xa5"


def invoke(command, *, bpf=None, mutations=None, cancel=False, payload=None,
           on_ready=None, stdin_data=None, protocol="v3"):
    output_read, output_write = os.pipe()
    status_read, status_write = os.pipe()
    bootstrap_read, bootstrap_write = os.pipe()
    if stdin_data is None:
        null = os.open("/dev/null", os.O_RDONLY)
    else:
        null, input_write = os.pipe()
        assert len(stdin_data) <= 4096
        assert os.write(input_write, stdin_data) == len(stdin_data)
        os.close(input_write)
    source = None
    if bpf is not None:
        source = tempfile.TemporaryFile(dir=D)
        source.write(bpf)
        source.flush()
    sources = [null, output_write, output_write, status_write, bootstrap_read]
    if source is not None:
        sources.append(source.fileno())
    copies = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 40) for fd in sources]
    pid = os.fork()
    if pid == 0:
        try:
            for target, fd in enumerate(copies):
                os.dup2(fd, target)
            os.closerange(len(copies), 4096)
            os.execve(str(BROKER), [str(BROKER), "--bootstrap-" + protocol], {"PATH": "/usr/bin:/bin"})
        finally:
            os._exit(126)
    for fd in [*copies, null, output_write, status_write, bootstrap_read]:
        os.close(fd)
    if source is not None:
        source.close()
    prefix = b""
    try:
        message = frame(command, bpf=bpf, mutations=mutations) if payload is None else payload
        if protocol == "v2":
            message = b"AGB2" + message[4:]
        offset = 0
        while offset < len(message):
            offset += os.write(bootstrap_write, message[offset:])
        os.close(bootstrap_write)
        bootstrap_write = None
        if cancel or on_ready is not None:
            assert select.select([status_read], [], [], 3)[0], "missing readiness"
            prefix = os.read(status_read, 1)
            assert prefix == b"S", prefix
            if on_ready is not None:
                on_ready(pid)
            if cancel:
                os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 10
        while True:
            got, status = os.waitpid(pid, os.WNOHANG)
            if got:
                break
            if time.monotonic() > deadline:
                os.kill(pid, signal.SIGUSR2)
                os.waitpid(pid, 0)
                raise AssertionError("broker did not settle")
            time.sleep(.001)
        collected = []
        for fd in [output_read, status_read]:
            assert select.select([fd], [], [], 3)[0], "missing EOF"
            value = os.read(fd, 16384)
            assert select.select([fd], [], [], 3)[0] and os.read(fd, 1) == b"", "extra output or missing EOF"
            collected.append(value)
        output, proof = collected[0], prefix + collected[1]
        code = os.waitstatus_to_exitcode(status)
        RECORDS.append({"command": command, "code": code, "output": output.decode(errors="replace"), "proof": proof.hex()})
        return code, output, proof
    finally:
        if bootstrap_write is not None:
            os.close(bootstrap_write)
        os.close(output_read)
        os.close(status_read)


def expected(state=0, residual=0, kind=0, code=0):
    return b"SAGC3" + bytes([state, residual, kind, code, 0, 0, 0, 0])


class BrokerV3(unittest.TestCase):
    def test_capability_is_separate_from_legacy(self):
        for flag, text in [("--describe-protocol", b"AGB2 owner-pid seccomp-snapshot-sealed-v1\n"),
                           ("--describe-protocol-v3", b"AGB3 owner-pid sealed-static-init-ro-artifact-v1\n")]:
            self.assertEqual(subprocess.check_output([str(BROKER), flag]), text)

    def test_terminal_outcomes_and_placeholder_preservation(self):
        for command, status, kind, value in [
            (["/bin/true"], 0, 0, 0), (["/bin/bash", "-c", "exit 125"], 125, 0, 125),
            (["/bin/bash", "-c", "exit 143"], 143, 0, 143),
            (["/bin/bash", "-c", "kill -TERM $$"], 143, 1, 15),
        ]:
            with self.subTest(command=command):
                code, output, proof = invoke(command)
                self.assertEqual((code, proof), (status, expected(kind=kind, code=value)), output)
                self.assertEqual(PLACEHOLDER.read_bytes(), MARKER)

    def test_bpf_consumption_and_no_task_descriptor_leak(self):
        allow_all = struct.pack("HBBI", 6, 0, 0, 0x7FFF0000)
        script = "import os; print([fd for fd in range(3,32) if os.path.exists('/proc/self/fd/'+str(fd))])"
        code, output, proof = invoke(["/usr/bin/python3", "-c", script], bpf=allow_all)
        self.assertEqual((code, output, proof), (0, b"[]\n", expected()))

    def test_live_descendant_observation(self):
        script = "import os,signal; r,w=os.pipe(); p=os.fork(); " + \
            "\nif p==0:\n os.close(r);os.setsid();os.write(w,b'R');os.close(w);signal.pause()" + \
            "\nelse:\n os.close(w);assert os.read(r,1)==b'R';os._exit(0)"
        code, output, proof = invoke(["/usr/bin/python3", "-c", script])
        self.assertEqual((code, proof), (0, expected(residual=1)), output)

    def test_graceful_abort_without_helper_result_preserves_cleanup(self):
        code, output, proof = invoke(["/bin/sleep", "60"], cancel=True)
        self.assertEqual((code, proof), (125, expected(state=1, residual=2, kind=2)), output)

    def test_guard_rejects_mount_or_descriptor_overrides_before_dispatch(self):
        mutations = [
            lambda a: a + ["--tmpfs", str(DIST)],
            lambda a: a + ["--bind", str(DIST), str(DIST)],
            lambda a: a + ["--as-pid-1"],
            lambda a: a + ["--ro-bind-data", "6", str(PLACEHOLDER)],
            lambda a: ["/usr/bin/bwrap", "--ro-bind", "/", "/"],
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                code, output, proof = invoke(["/bin/echo", "UNEXPECTED"], mutations=mutation)
                self.assertEqual((code, output, proof), (125, b"", b""))

    def test_forged_or_symlink_placeholder_fails_preparation(self):
        try:
            PLACEHOLDER.write_bytes(b"wrong\n")
            self.assertEqual(invoke(["/bin/true"]), (125, b"", b""))
            PLACEHOLDER.unlink()
            other = D / "marker"
            other.write_bytes(MARKER)
            PLACEHOLDER.symlink_to(other)
            self.assertEqual(invoke(["/bin/true"]), (125, b"", b""))
        finally:
            PLACEHOLDER.unlink(missing_ok=True)
            PLACEHOLDER.write_bytes(MARKER)


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    if os.environ.get("AGENC_BROKER_V3_TEST_RECEIPT"):
        Path(os.environ["AGENC_BROKER_V3_TEST_RECEIPT"]).write_text(json.dumps({
            "passed": result.wasSuccessful(), "records": RECORDS,
        }, indent=2) + "\n")
    raise SystemExit(0 if result.wasSuccessful() else 1)
