import { describe, expect, test } from "vitest";
import {
  findUnwaitedBackgroundJob,
  isPosixShell,
  maskShellStructure,
  unwaitedBackgroundJobMessage,
} from "../../../src/tools/system/background-job-refusal.js";

// The scan refuses only jobs meant to outlive the command (nohup, setsid,
// disown, a trailing &) that the command neither waits for nor stops, and
// never refuses what it cannot parse. Commands from Terminal-Bench (AgenC
// 0.19.19) trials that lost their runs this way are the first cases.

describe("refused", () => {
  test.each([
    ["nohup python3 train.py > /tmp/log 2>&1 &", "nohup"],
    // rstan AgbWbf9 s55
    ["cd /app && nohup python3 pystan_analysis.py > /tmp/run.log 2>&1 & echo started; sleep 60; tail -c 400 /tmp/run.log", "nohup"],
    // train-fasttext Chi3Pzn s15: a here-document whose body holds `&`, then two nohup jobs
    ["cat > /tmp/exp.py <<'EOF'\nimport os & sys\nx = a & b\nEOF\nnohup python3 /tmp/exp.py A '{\"dim\":50}' > /tmp/expA.log 2>&1 &\nnohup python3 /tmp/exp.py B > /tmp/expB.log 2>&1 &\necho started", "nohup"],
    // configure-git 6gFyQwS
    ["setsid nohup python3 -m http.server 8080 >/var/log/w.log 2>&1 < /dev/null & sleep 1; pgrep -af http.server; cat /var/log/w.log", "setsid"],
    ["python3 a.py > a.log 2>&1 &", "trailing"],
    ["python3 a.py & python3 b.py &", "trailing"],
    ["( cd /app && make -j8 ) &", "trailing"],
    ["./server &\necho $! > pid", "trailing"],
    ["python a.py & # started", "trailing"],
    ["./server & disown", "disown"],
    ["FOO=1 /usr/bin/nohup ./job &", "nohup"],
  ] as const)("%s", (cmd, kind) => {
    expect(findUnwaitedBackgroundJob(cmd)?.kind).toBe(kind);
  });
});

describe("allowed", () => {
  test.each([
    "server & sleep 1; curl -sf localhost:8000; kill $!",
    "server & pid=$!; sleep 0.5; curl -s http://127.0.0.1:3000/health; kill $pid",
    "node server.js & sleep 2 && curl localhost:3000",
    "server & npm test",
    "a & b & wait",
    "nohup a & nohup b & wait",
    "make 2>&1 | tail -40",
    "echo \"a & b\" && ls",
    "echo 'nohup x &'",
    "ls &>/dev/null",
    "cmd >&2",
    "x=$(nohup y &) ; echo",
    "echo \\& done",
    "(( a & b )); echo",
    "echo ${x//&/and}",
    "cat <<EOF\nnohup x &\nEOF",
    "ls # nohup foo &",
    "if true; then echo yes & fi",
  ])("%s", (cmd) => {
    expect(findUnwaitedBackgroundJob(cmd)).toBeUndefined();
  });

  test.each([
    "echo 'unterminated &",
    "cat <<'EOF'\nnohup x &",
    "x=$(nohup y &",
  ])("never refuses what it cannot parse: %s", (cmd) => {
    expect(findUnwaitedBackgroundJob(cmd)).toBeUndefined();
  });
});

test("masks quoted text, substitutions and here-document bodies at the same length", () => {
  const cmd = "cat > e.py <<'EOF'\nx & y\nEOF\necho \"a&b\" $(c &) # d &\nnohup p &";
  const masked = maskShellStructure(cmd)!;
  expect(masked).toHaveLength(cmd.length);
  expect(masked.slice(masked.lastIndexOf("\n") + 1)).toBe("nohup p &");
  expect(masked.split("\n")[1]).toBe("xxxxx");
  expect(masked).not.toMatch(/a&b|c &|d &/u);
});

test("scans POSIX shells only", () => {
  for (const shell of ["/bin/bash", "/bin/sh", "/usr/bin/zsh", "dash", "C:\\Program Files\\Git\\bin\\bash.exe"]) {
    expect(isPosixShell(shell), shell).toBe(true);
  }
  for (const shell of ["cmd.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "pwsh", "fish"]) {
    expect(isPosixShell(shell), shell).toBe(false);
  }
});

test("the refusal names the job, the form and background: true", () => {
  const job = "nohup python3 /tmp/experiment_runner.py A > /tmp/expA.log 2>&1";
  const message = unwaitedBackgroundJobMessage({ kind: "nohup", job });
  // A long job is shown as its first 45 characters.
  expect(message.startsWith(`This command has not started: its job \`${job.slice(0, 45)}...\` (nohup ... &) would be stopped`)).toBe(true);
  expect(message).toContain("background: true");
  expect(message).toContain("detach: true");
});
