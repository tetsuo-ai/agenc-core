#!/usr/bin/env python3
"""Compare two AgenC builds against identical local-model coding fixtures."""

import argparse
import collections
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")
    assert json.loads(path.read_text()) == value


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_check(command, *, timeout):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout,
                                stdin=subprocess.DEVNULL)
        return result.returncode, result.stdout + result.stderr, False
    except subprocess.TimeoutExpired as error:
        def text(value):
            return value.decode(errors="replace") if isinstance(value, bytes) else value or ""
        return 124, text(error.stdout) + text(error.stderr) + "\nVerification timed out.\n", True


def verification_command(prefix, workspace, holdout, arguments):
    command = prefix + ["bwrap", "--unshare-all", "--die-with-parent", "--new-session"]
    for directory in ["/usr", "/lib", "/lib64"]:
        if Path(directory).exists():
            command += ["--ro-bind", directory, directory]
    command += ["--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
                "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
                "--ro-bind", str(workspace), "/workspace",
                "--ro-bind", str(holdout), "/checks/holdout.py", "--chdir", "/workspace",
                "--clearenv", "--setenv", "PATH", "/usr/bin:/bin",
                "--setenv", "HOME", "/tmp", "--setenv", "TMPDIR", "/tmp",
                "--setenv", "LANG", "C.UTF-8", "--setenv", "PYTHONPATH", "/workspace"]
    return command + ["python3", *arguments]



VERIFY_CODE = r"""
import importlib.util, json, sys, unittest
try:
    spec = importlib.util.spec_from_file_location("benchmark_tests", sys.argv[1])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    original_main = unittest.main
    unittest.main = lambda *args, **kwargs: None
    try:
        spec.loader.exec_module(module)
    finally:
        unittest.main = original_main
    suite = unittest.defaultTestLoader.loadTestsFromModule(module)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    expected = int(sys.argv[2])
    passed = result.wasSuccessful() and result.testsRun == expected and not result.skipped
    print("AGENC_CHECK_RESULT=" + json.dumps({"passed": passed, "tests_run": result.testsRun}), flush=True)
    sys.exit(0 if passed else 1)
except BaseException as error:
    if isinstance(error, SystemExit) and error.code == 0:
        raise
    print("Verification error: " + type(error).__name__ + ": " + str(error), file=sys.stderr)
    sys.exit(1)
"""


def verify_suite(prefix, workspace, holdout, suite_path, expected, timeout):
    code, log, timed_out = run_check(verification_command(prefix, workspace, holdout,
        ["-c", VERIFY_CODE, suite_path, str(expected)]), timeout=timeout)
    receipts = []
    for line in log.splitlines():
        if line.startswith("AGENC_CHECK_RESULT="):
            try:
                receipts.append(json.loads(line.split("=", 1)[1]))
            except ValueError:
                pass
    verified = bool(receipts) and receipts[-1] == {"passed": True, "tests_run": expected}
    return (code if code != 0 else 0 if verified else 1), log, timed_out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--home-root", required=True, type=Path, help="Private directory for isolated daemon homes")
    parser.add_argument("--fixtures", required=True, type=Path)
    parser.add_argument("--before", required=True, type=Path, help="Before build's bin/agenc")
    parser.add_argument("--after", type=Path, help="After build's bin/agenc")
    parser.add_argument("--node", required=True, type=Path)
    parser.add_argument("--apparmor-profile")
    parser.add_argument("--base-url", default="http://127.0.0.1:8888/v1")
    parser.add_argument("--model", default="DeepSeek-v4.1-Flash-EXL3")
    parser.add_argument("--context-window", type=int, default=1048576)
    parser.add_argument("--variants", choices=["before", "after", "paired"], default="paired")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--label", default="confirmation")
    parser.add_argument("--experiment", choices=["task-limits", "apply-patch", "combined"], default="task-limits")
    args = parser.parse_args()
    for name in ["root", "home_root", "fixtures", "before", "after", "node"]:
        value = getattr(args, name)
        if value is not None:
            setattr(args, name, value.expanduser().resolve())
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    fixtures = json.loads(args.fixtures.read_text())
    args.root.mkdir(parents=True, exist_ok=True)
    args.home_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    probe = args.root / "probe"
    probe.mkdir(exist_ok=True)
    origin = urlsplit(args.base_url)
    if origin.scheme != "http" or origin.hostname not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("Use a local HTTP model server; this benchmark records no credentials")
    variants = ["before", "after"] if args.variants == "paired" else [args.variants]
    if "after" in variants and args.after is None:
        parser.error("--after is required for after or paired measurements")
    journal = args.root / "runs.jsonl"
    previous = [json.loads(line) for line in journal.read_text().splitlines()] if journal.exists() else []
    workspaces = args.root / "workspaces"
    run_index = max([len(previous)] + [int(path.name) for path in workspaces.glob("*") if path.name.isdigit()])
    active = {"id": None}
    requests = []

    class Proxy(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def forward(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            record = None
            if self.command == "POST" and self.path.endswith("/chat/completions"):
                payload = json.loads(body)
                system = "\n".join(str(m.get("content", "")) for m in payload.get("messages", [])
                                   if m.get("role") in {"system", "developer"})
                record = {"run_id": active["id"], "limited_finish": "Do what was asked and no more:" in system,
                          "system_chars": len(system), "model": payload.get("model"),
                          "temperature": payload.get("temperature"), "max_tokens": payload.get("max_tokens"),
                          "tool_names": [t.get("function", {}).get("name") for t in payload.get("tools", [])]}
                requests.append(record)
            connection = http.client.HTTPConnection(origin.hostname, origin.port or 80, timeout=150)
            try:
                connection.request(self.command, self.path, body=body or None,
                                   headers={"Content-Type": self.headers.get("Content-Type", "application/json")})
                response = connection.getresponse()
                self.send_response(response.status)
                self.send_header("Content-Type", response.getheader("Content-Type", "application/json"))
                self.send_header("Connection", "close")
                self.end_headers()
                if record is not None:
                    record["status"] = response.status
                while chunk := response.read1(16384):
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                self.close_connection = True
                connection.close()

        do_GET = forward
        do_POST = forward

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    commands = {}
    envs = {}
    doctor = {}
    prefix = ["aa-exec", "-p", args.apparmor_profile, "--"] if args.apparmor_profile else []

    try:
        preflight = probe / "verification-preflight.py"
        preflight.write_text("# Fixture for the read-only verifier mount.\n")
        code, log, timed_out = run_check(verification_command(prefix, probe, preflight,
            ["-c", "import os, sqlite3; assert os.getcwd() == '/workspace'; assert os.environ['HOME'] == '/tmp'"]), timeout=15)
        if code != 0 or timed_out:
            raise RuntimeError(f"Isolated verification is unavailable: {log}")
        for variant in variants:
            binary = args.before if variant == "before" else args.after
            command = prefix + [str(args.node), str(binary)]
            home = args.home_root / variant
            home.mkdir(mode=0o700, parents=True, exist_ok=True)
            home.chmod(0o700)
            home.joinpath("config.toml").write_text(
                'config_version = 2\nmodel_provider = "openai-compatible"\n'
                f'model = {json.dumps(args.model)}\n\n[providers.openai-compatible]\n'
                f'base_url = "http://127.0.0.1:{server.server_port}{origin.path}"\n'
                f'context_window_tokens = {args.context_window}\ntimeout_ms = 120000\n')
            home.joinpath("config.toml").chmod(0o600)
            env = {key: os.environ[key] for key in ["HOME", "USER", "LOGNAME", "SHELL", "LANG",
                    "LC_ALL", "LC_CTYPE", "TZ", "TERM", "COLORTERM"] if key in os.environ}
            env.update(AGENC_HOME=str(home),
                       AGENC_LIGHT_TASK_LIMITS="1" if args.experiment in {"task-limits", "combined"} else "0",
                       AGENC_LIGHT_APPLY_PATCH="1" if args.experiment in {"apply-patch", "combined"} else "0",
                       PATH=str(args.node.parent) + ":/usr/bin:/bin:/usr/sbin:/sbin")
            check = subprocess.run(command + ["doctor", "--json"], cwd=probe,
                                   env=env, capture_output=True, text=True, timeout=30)
            if check.returncode != 0:
                raise RuntimeError(f"{variant} doctor failed: {check.stdout} {check.stderr}")
            doctor[variant] = json.loads(check.stdout)
            if doctor[variant].get("sandbox", {}).get("kind") != "ready":
                raise RuntimeError(f"{variant} sandbox is not ready")
            daemon_env = dict(env)
            daemon_env.pop("AGENC_LIGHT_TASK_LIMITS", None)
            daemon_env.pop("AGENC_LIGHT_APPLY_PATCH", None)
            started = subprocess.run(command + ["daemon", "restart"], cwd=probe,
                                     env=daemon_env, capture_output=True, text=True, timeout=45)
            if started.returncode != 0:
                raise RuntimeError(f"{variant} daemon failed: {started.stderr}")
            commands[variant] = command
            envs[variant] = env
        save(args.root / f"{args.label}-doctor.json", doctor)
        measured = []
        for repeat in range(args.repeats):
            order = variants if repeat % 2 == 0 else list(reversed(variants))
            for task, fixture in fixtures.items():
                for variant in order:
                    run_index += 1
                    run_id = f"{run_index:06d}"
                    workspace = args.root / "workspaces" / run_id
                    workspace.mkdir(parents=True)
                    for name, content in fixture["files"].items():
                        path = workspace / name
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text(content)
                    initial_hash = sha(workspace / "test_visible.py")
                    logs = args.root / "logs" / run_id
                    logs.mkdir(parents=True)
                    active["id"] = run_id
                    command = commands[variant] + ["-p", "--output-format", "stream-json",
                        "--permission-mode", "acceptEdits", "--deadline", f'+{fixture["deadline"]}',
                        "--deadline-reserve", "15", fixture["prompt"]]
                    print(json.dumps({"starting": run_id, "variant": variant, "task": task,
                                      "repeat": repeat + 1}), flush=True, file=sys.stderr)
                    start = time.monotonic()
                    with (logs / "events.jsonl").open("w") as out, (logs / "stderr.log").open("w") as err:
                        try:
                            result = subprocess.run(command, cwd=workspace, env=envs[variant],
                                stdout=out, stderr=err, timeout=fixture["deadline"] + 45)
                            exit_code = result.returncode
                        except subprocess.TimeoutExpired as error:
                            save(logs / "timeout.json", {"id": run_id, "variant": variant, "task": task,
                                "wall_seconds": round(time.monotonic() - start, 3),
                                "token_usage": None, "correctness_passed": False,
                                "reason": "Client timed out; aborting comparison and stopping isolated daemons."})
                            raise RuntimeError(f"Client timeout in {run_id}; benchmark aborted to avoid a live daemon turn contaminating later runs") from error
                    elapsed = time.monotonic() - start
                    active["id"] = None
                    events = []
                    for line in (logs / "events.jsonl").read_text().splitlines():
                        try:
                            events.append(json.loads(line))
                        except ValueError:
                            pass
                    final = next((event for event in reversed(events) if event.get("type") == "result"), {})
                    tool_calls = []
                    errors = []
                    for event in events:
                        rpc = event.get("event", {})
                        params = rpc.get("params", {})
                        if rpc.get("method") == "event.tool_request":
                            tool_calls.append(params.get("toolName"))
                        inner = params.get("event", {})
                        payload = inner.get("payload", {})
                        if inner.get("type") == "tool_call_completed" and payload.get("isError"):
                            errors.append({"tool": payload.get("toolName"), "error": str(payload.get("result"))[:1200]})
                    holdout = logs / "holdout.py"
                    holdout.write_text(fixture["heldout"])
                    heldout_code, heldout_log, heldout_timeout = verify_suite(
                        prefix, workspace, holdout, "/checks/holdout.py", fixture["heldout_count"], 45)
                    visible_code, visible_log, visible_timeout = verify_suite(
                        prefix, workspace, holdout, "/workspace/test_visible.py", fixture["visible_count"], 30)
                    (logs / "holdout.log").write_text(heldout_log)
                    (logs / "visible.log").write_text(visible_log)
                    wire = [record for record in requests if record["run_id"] == run_id]
                    try:
                        unchanged = sha(workspace / "test_visible.py") == initial_hash
                    except OSError:
                        unchanged = False
                    wire_valid = bool(wire) and all(record["model"] == args.model and record.get("status") == 200 for record in wire)
                    row = {"id": run_id, "label": args.label, "variant": variant, "task": task,
                        "repeat": repeat + 1, "wall_seconds": round(elapsed, 3), "agenc_exit_code": exit_code,
                        "token_usage": final.get("tokenUsage"), "model_calls": len(wire),
                        "experiment": args.experiment,
                        "limited_finish_on_all_calls": bool(wire) and all(r["limited_finish"] for r in wire),
                        "wire": wire, "tool_calls": dict(collections.Counter(tool_calls)), "tool_errors": errors,
                        "denied_permissions": final.get("deniedPermissionRequestIds", []),
                        "supplied_tests_unchanged": unchanged,
                        "visible_exit_code": visible_code, "heldout_exit_code": heldout_code,
                        "verification_timed_out": visible_timeout or heldout_timeout,
                        "verification_isolation": "bubblewrap: read-only code, private tmp, no network",
                        "wire_valid": wire_valid,
                        "correctness_passed": unchanged and visible_code == 0 and heldout_code == 0,
                        "visible_count": fixture["visible_count"], "heldout_count": fixture["heldout_count"],
                        "final_message": final.get("finalMessage", ""),
                        "sandbox_enabled": doctor[variant]["sandbox"]["kind"] == "ready"}
                    save(logs / "result.json", row)
                    with journal.open("a") as output:
                        output.write(json.dumps(row) + "\n")
                        output.flush()
                        os.fsync(output.fileno())
                    assert json.loads(journal.read_text().splitlines()[-1]) == row
                    measured.append(row)
                    print(json.dumps({"completed": run_id, "variant": variant, "task": task,
                        "seconds": row["wall_seconds"], "usage": row["token_usage"],
                        "calls": row["model_calls"], "limited_finish": row["limited_finish_on_all_calls"],
                        "correctness": row["correctness_passed"], "agenc_exit_code": exit_code}), flush=True, file=sys.stderr)
                    expected_limits = args.experiment in {"task-limits", "combined"} and variant == "after"
                    prompts_match = bool(wire) and all(r["limited_finish"] == expected_limits for r in wire)
                    initial_patch = bool(wire) and "apply_patch" in wire[0]["tool_names"]
                    editor_matches = args.experiment not in {"apply-patch", "combined"} or initial_patch == (variant == "after")
                    if not wire_valid or not prompts_match or not editor_matches:
                        raise RuntimeError(f"Unexpected {variant} wire; the comparison does not isolate {args.experiment}")
        summary = {"runs": measured, "summary": {}}
        for variant in variants:
            for task in fixtures:
                rows = [row for row in measured if row["variant"] == variant and row["task"] == task]
                summary["summary"][f"{variant}/{task}"] = {
                    "total_tokens": [(row["token_usage"] or {}).get("totalTokens") for row in rows],
                    "wall_seconds": [row["wall_seconds"] for row in rows],
                    "model_calls": [row["model_calls"] for row in rows],
                    "correctness_pass_rate": statistics.mean(row["correctness_passed"] for row in rows),
                    "completed_exit_zero": sum(row["agenc_exit_code"] == 0 for row in rows)}
        save(args.root / f"{args.label}-results.json", summary)
        print(json.dumps({"summary": summary["summary"]}, indent=2), flush=True)
    finally:
        cleanup_errors = {}
        try:
            for variant, command in commands.items():
                try:
                    stopped = subprocess.run(command + ["daemon", "stop"], cwd=probe, env=envs[variant],
                                             capture_output=True, timeout=30)
                    if stopped.returncode != 0:
                        cleanup_errors[variant] = stopped.stderr.decode(errors="replace")
                except (OSError, subprocess.TimeoutExpired) as error:
                    cleanup_errors[variant] = str(error)
        finally:
            try:
                server.shutdown()
            finally:
                server.server_close()
        if cleanup_errors:
            save(args.root / "cleanup-errors.json", cleanup_errors)
            print(f"Isolated daemon cleanup failed: {cleanup_errors}", file=sys.stderr)
            if sys.exc_info()[0] is None:
                raise RuntimeError("Isolated daemon cleanup failed; see cleanup-errors.json")


if __name__ == "__main__":
    main()
