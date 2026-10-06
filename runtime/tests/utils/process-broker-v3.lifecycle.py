"""Deterministic death-boundary fixtures; hooks exist only in a temporary copy.

The production broker has no environment-selected fault behavior. Each source
insertion is anchored exactly once, and this fixture runs in a test container.
"""
from pathlib import Path
import ctypes
import fcntl
import importlib.util
import json
import os
import select
import signal
import subprocess
import time
import unittest

spec = importlib.util.spec_from_file_location("protocol", Path(__file__).with_name("process-broker-v3.kernel.py"))
protocol = importlib.util.module_from_spec(spec)
spec.loader.exec_module(protocol)
RECORDS = []
D = protocol.D
broker = protocol.BROKER
WORK = D / "work"
WORK.mkdir()
source = (protocol.ROOT / "native/agenc-process-broker.c").read_text()


def insert_once(before, after):
    global source
    assert source.count(before) == 1, (before, source.count(before))
    source = source.replace(before, after)


insert_once("enum {", r'''
static const char *checkpoint_phase, *checkpoint_marker;
__attribute__((constructor)) static void configure_checkpoint(void) {
  checkpoint_phase = getenv("FIXTURE_CHECKPOINT_PHASE");
  checkpoint_marker = getenv("FIXTURE_CHECKPOINT_MARKER");
}
static void checkpoint(const char *phase) {
  if (!checkpoint_phase || strcmp(phase, checkpoint_phase) != 0) return;
  int fd = open(checkpoint_marker, O_WRONLY | O_CREAT | O_EXCL, 0600);
  char bytes[64];
  int size = snprintf(bytes, sizeof(bytes), "%ld", (long)getpid());
  if (fd < 0 || size <= 0 || write(fd, bytes, (size_t)size) != size || close(fd) != 0) _exit(124);
  if (kill(getpid(), SIGSTOP) != 0) _exit(124);
}
enum {''')
insert_once("      v2_owner_alive() != 0 || v2_descriptor_inventory(maps == 1) != 0) return -1;",
            '      v2_owner_alive() != 0 || v2_descriptor_inventory(maps == 1) != 0) return -1;\n  checkpoint("after-owner-arm");')
insert_once("  if (v3_report_reader < 0 || writer < 0 ||",
            '  checkpoint("before-final-owner-check");\n  if (v3_report_reader < 0 || writer < 0 ||')
insert_once("  pid_t broker = getpid();\n  root_pid = fork();",
            '  checkpoint("after-final-owner-check");\n  pid_t broker = getpid();\n  root_pid = fork();')
insert_once("    char **argv, int snapshot, int reference, int writer, pid_t broker) {",
            '    char **argv, int snapshot, int reference, int writer, pid_t broker) {\n  checkpoint("child-before-death-arm");')
insert_once("      getppid() != broker || setsid() < 0 || v2_pending_stop() != 0) _exit(125);",
            '      (checkpoint("child-after-death-arm"), false) ||\n      getppid() != broker || setsid() < 0 || v2_pending_stop() != 0) _exit(125);')
insert_once('  if (getppid() != broker || write_status("S", 1) != 0 || close(3) != 0) _exit(125);',
            '  checkpoint("child-before-S");\n  if (getppid() != broker || write_status("S", 1) != 0) _exit(125);\n  checkpoint("child-after-S");\n  if (close(3) != 0) _exit(125);')
insert_once('  if (getppid() != broker) _exit(125);',
            '  checkpoint("child-before-exec");\n  if (getppid() != broker) _exit(125);')
fixture_source = D / "broker-checkpoints.c"
fixture_source.write_text(source)
subprocess.run(["cc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", '-DAGENC_NAMESPACE_INIT_IMAGE_HEADER="' + str(protocol.HEADER) + '"', "-o", str(broker), str(fixture_source)], check=True)


def wait_until(predicate, description, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.002)
    raise AssertionError(description)


def read_to_eof(fd):
    deadline = time.monotonic() + 5
    chunks = []
    while time.monotonic() < deadline:
        readable, _, _ = select.select([fd], [], [], .05)
        if not readable:
            continue
        chunk = os.read(fd, 4096)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)
    raise AssertionError("owned output pipe did not close")


def boundary(phase, kill_owner):
    libc = ctypes.CDLL(None, use_errno=True)
    assert libc.prctl(36, 1, 0, 0, 0) == 0  # Observe/reap adopted fixture descendants.
    marker, effects = D / (phase + ".stop"), WORK / (phase + ".effects")
    report_r, report_w = os.pipe()
    out_r, out_w = os.pipe()
    status_r, status_w = os.pipe()
    controller = os.fork()
    if controller == 0:
        try:
            boot_r, boot_w = os.pipe()
            null = os.open("/dev/null", os.O_RDONLY)
            copies = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 40) for fd in [null, out_w, out_w, status_w, boot_r]]
            child = os.fork()
            if child == 0:
                for slot, fd in enumerate(copies):
                    os.dup2(fd, slot)
                os.closerange(5, 4096)
                os.execve(str(broker), [str(broker), "--bootstrap-v3"], {
                    "FIXTURE_CHECKPOINT_PHASE": phase, "FIXTURE_CHECKPOINT_MARKER": str(marker),
                })
            for fd in copies + [null, out_w, status_w, boot_r]:
                os.close(fd)
            os.write(boot_w, protocol.frame(["/bin/sh", "-c", f"printf X >> {effects}; printf READY; exec sleep 60"], mutations=lambda args: args + ["--bind", str(WORK), str(WORK)]))
            os.close(boot_w)
            os.write(report_w, str(child).encode())
            os.close(report_w)
            # Remain the original daemon until the observer chooses its death.
            while True:
                signal.pause()
        finally:
            os._exit(126)
    os.close(report_w)
    os.close(out_w)
    os.close(status_w)
    child = int(os.read(report_r, 64))
    os.close(report_r)
    stopped = None
    reaped = set()
    try:
        if phase.startswith("running-"):
            wait_until(lambda: effects.exists() and effects.stat().st_size == 1, "task effect not reached")
        else:
            wait_until(lambda: marker.exists() and marker.stat().st_size > 0, "checkpoint not reached")
            stopped = int(marker.read_text())
            def is_stopped():
                text = Path(f"/proc/{stopped}/status").read_text()
                return any(line.startswith("State:") and "T (stopped)" in line for line in text.splitlines())
            wait_until(is_stopped, "checkpoint process did not stop")
        os.kill(controller if kill_owner else child, signal.SIGKILL)
        if kill_owner:
            os.waitpid(controller, 0)
            reaped.add(controller)
        else:
            # Killing an armed broker may kill its stopped child immediately.
            wait_until(lambda: not Path(f"/proc/{child}/stat").exists() or
                       Path(f"/proc/{child}/stat").read_text().split(") ", 1)[1].startswith("Z"), "broker did not die")
        try:
            if stopped is not None:
                os.kill(stopped, signal.SIGCONT)
        except ProcessLookupError:
            pass
        output, proof = read_to_eof(out_r), read_to_eof(status_r)
        count = len(effects.read_bytes()) if effects.exists() else 0
        if phase.startswith("running-"):
            assert count == 1, (phase, count)
            assert proof == (protocol.expected(state=1, residual=2, kind=2) if kill_owner else b"S"), (phase, proof)
        elif phase == "after-final-owner-check":
            assert count <= 1, count  # Explicitly in-flight; no false zero-effect promise.
        else:
            assert count == 0, (phase, count)
        if phase in ["after-owner-arm", "before-final-owner-check", "child-before-death-arm", "child-after-death-arm", "child-before-S"]:
            assert b"S" not in proof, (phase, proof)
        if phase.startswith("child-"):
            assert b"C" not in proof  # No broker, hence no cleanup certificate.
        record = {"phase": phase, "effects": count, "stdout": output.decode(), "proof": proof.hex()}
        RECORDS.append(record)
        print(json.dumps(record), flush=True)
    finally:
        # Every PID was obtained from this fixture's forks/checkpoint, never a
        # workload-supplied identifier or a host process enumeration.
        for pid in [controller, child, stopped]:
            if pid is None or pid in reaped:
                continue
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    time.sleep(.002)
            except ChildProcessError:
                break
        else:
            raise AssertionError("fixture descendants did not settle")
        os.close(out_r)
        os.close(status_r)
        assert libc.prctl(36, 0, 0, 0, 0) == 0


class Lifecycle(unittest.TestCase):
    def test_daemon_death_boundaries(self):
        for phase in ["after-owner-arm", "before-final-owner-check", "after-final-owner-check"]:
            with self.subTest(phase=phase):
                boundary(phase, True)

    def test_owner_and_broker_death_after_a_real_task_effect(self):
        boundary("running-owner", True)
        boundary("running-broker", False)

    def test_broker_death_boundaries(self):
        for phase in ["child-before-death-arm", "child-after-death-arm", "child-before-S", "child-after-S", "child-before-exec"]:
            with self.subTest(phase=phase):
                boundary(phase, False)



if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    if os.environ.get("AGENC_BROKER_V3_TEST_RECEIPT"):
        Path(os.environ["AGENC_BROKER_V3_TEST_RECEIPT"]).write_text(json.dumps({
            "passed": result.wasSuccessful(), "records": RECORDS,
        }, indent=2) + "\n")
    raise SystemExit(0 if result.wasSuccessful() else 1)
