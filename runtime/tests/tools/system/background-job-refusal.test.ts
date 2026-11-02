import { describe, expect, test } from "vitest";
import {
  findUnwaitedBackgroundJob,
  isPosixShell,
  parseShellStructure,
  unwaitedBackgroundJobMessage,
  type UnwaitedBackgroundJob,
} from "../../../src/tools/system/background-job-refusal.js";

// The rule (lead decision after three reviews of PR 3355): a command is
// judged only when it is a flat list of simple commands (no subshell, brace
// group, case, if, loop, function, or command or process substitution; a
// backgrounded pipeline is fine), and refused only when its last command doing
// real work is a background job, followed by nothing but echo, printf, true,
// :, sleep or disown. Every example of the three reviews is here with the
// earlier rounds' cases and the Terminal-Bench commands (AgenC 0.19.19 and
// 0.19.24) that motivated the scan. "accepted false negative" marks a job that
// is trailing but nested, which the rule lets run on purpose: the cleanup stops
// it and the result says so.
const CASES: readonly (readonly [command: string, refused: UnwaitedBackgroundJob["kind"] | undefined, why: string])[] = [
  ["mkfifo request; cat request & printf 'hello\\n' >request; sleep 1", undefined, "redirected producer feeds a waiting reader"],
  ["server & printf 'GET / HTTP/1.0\\r\\n\\r\\n' >/dev/tcp/127.0.0.1/8080", undefined, "redirected builtin is a same-command client"],
  ["server & >request echo hello", undefined, "leading functional redirection"],
  ["server & : >ready", undefined, "redirection itself does work"],
  ["server & echo 'literal > text'", "trailing", "quoted redirection is not functional"],
  // Flat lists whose last real work is a background job: refused.
  ["nohup python3 train.py > /tmp/log 2>&1 &", "nohup", "nothing after it"],
  ["cat > /tmp/exp.py <<'EOF'\nimport os & sys\nx = a & b\nEOF\nnohup python3 /tmp/exp.py A '{\"dim\":50}' > /tmp/expA.log 2>&1 &\nnohup python3 /tmp/exp.py B > /tmp/expB.log 2>&1 &\necho started", "nohup", "train-fasttext Chi3Pzn: only echo after the second job"],
  ["cd /app/work && nohup python3 - > B.log 2>&1 <<'EOF' &\nimport fasttext\nm = fasttext.train_supervised(input='train.txt')\nEOF", "nohup", "train-fasttext j4WfVbg: its own here-document is no command"],
  ["python3 a.py > a.log 2>&1 &", "trailing", "nothing after it"],
  ["python3 a.py & python3 b.py &", "trailing", "the second job is last"],
  ["python train.py 2>&1 | tee train.log &", "trailing", "a backgrounded pipeline"],
  ["sleep 30 &", "trailing", "a job is a candidate whatever it runs"],
  ["./server &\necho $! > pid", undefined, "accepted false negative: redirected output can do work"],
  ["python a.py & # started", "trailing", "a comment is nothing"],
  ["./server & disown", "disown", "disown is no work"],
  ["FOO=1 /usr/bin/nohup ./job &", "nohup", "assignment and path"],
  ["nohup ./train.sh > log 2>&1 & sleep 5; echo started", "nohup", "sleep and echo are no work"],
  ["touch started-anyway; setsid ./server > s.log 2>&1 < /dev/null &\nprintf 'launched\\n'", "setsid", "printf is no work"],
  ["cat <<< \"hello\"; sleep 30 &", "trailing", "review 1: here-string, then a trailing job"],
  ["cat <<< 'a & b' && nohup ./job > log &", "nohup", "here-string with a quoted &"],
  ["grep -q x <<< \"$v\"; cat > f <<EOF\nx & y\nEOF\nnohup ./p > p.log 2>&1 &", "nohup", "here-string and here-document"],
  ["read -r a b <<<\"$line\"; ./worker & echo started", "trailing", "here-string without a space"],
  // Flat lists whose last real work runs after the job: allowed.
  ["cd /app && nohup python3 pystan_analysis.py > /tmp/run.log 2>&1 & echo started; sleep 60; tail -c 400 /tmp/run.log", undefined, "rstan AgbWbf9: tail is last"],
  ["setsid nohup python3 -m http.server 8080 >/var/log/w.log 2>&1 < /dev/null & sleep 1; pgrep -af http.server; cat /var/log/w.log", undefined, "configure-git 6gFyQwS: cat is last"],
  ["cd /tmp/CompCert && nohup make -j2 all > /tmp/compcert-build.log 2>&1 & echo \"PID:$!\"; sleep 45; tail -20 /tmp/compcert-build.log", undefined, "compile-compcert 9VYHKdh: tail is last"],
  ["server & sleep 1; curl -sf localhost:8000; kill $!", undefined, "kill is last"],
  ["server & pid=$!; sleep 0.5; curl -s http://127.0.0.1:3000/health; kill $pid", undefined, "kill is last"],
  ["node server.js & sleep 2 && curl localhost:3000", undefined, "curl after &&"],
  ["server & npm test", undefined, "a test run"],
  ["server & pid=$!", undefined, "an assignment counts as work (no false refusal)"],
  ["a & b & wait", undefined, "wait is work"],
  ["nohup a & nohup b & wait", undefined, "wait is work"],
  ["server & wait | cat; echo done", undefined, "a pipeline doing work"],
  ["sleep 0.1 & sleep 0.1 & wait; echo waited", undefined, "wait, then echo"],
  ["server & cat > notes.txt <<'EOF'\nstarted & running\nEOF", undefined, "cat is last"],
  // Nested forms are never judged: allowed, trailing or not.
  ["(sleep 30 &)", undefined, "review 1: accepted false negative (subshell)"],
  ["{ sleep 30 & }", undefined, "review 1: accepted false negative (brace group)"],
  ["cat <(nohup printf hello &)", undefined, "review 1: process substitution"],
  ["{ sleep 0.1 & } && wait", undefined, "review 2: brace group"],
  ["(python3 -m http.server 8000 &) && sleep 1 && curl -sf localhost:8000", undefined, "review 2: subshell, curl after"],
  ["f() { sleep 30 & }; echo defined", undefined, "review 2: function definition"],
  ["(nohup sleep 30 &); wait", undefined, "review 2: accepted false negative (the wait cannot reach it)"],
  ["nohup sleep 30 & (wait)", undefined, "review 2: accepted false negative (subshell wait)"],
  ["sleep 0.2 & case ready in ready) wait ;; esac", undefined, "review 3 item 1: case"],
  ["server & case ready in ready) npm test ;; esac", undefined, "review 3 item 1: case"],
  ["sleep 30 & { wait; } | true", undefined, "review 3 item 2: accepted false negative (pipeline brace group)"],
  ["{ sleep 30 & } | true; wait", undefined, "review 3 item 2: accepted false negative"],
  ["sleep 30 & f() { :; }", undefined, "review 3 item 3: accepted false negative (function after the job)"],
  ["pid=$({ nohup sleep 30 & } >/dev/null 2>&1; echo $!)", undefined, "review 3 item 4: accepted false negative (substitution)"],
  ["( cd /app && make -j8 ) &", undefined, "accepted false negative (backgrounded subshell)"],
  ["if true; then echo yes & fi", undefined, "if"],
  ["for f in *.txt; do process \"$f\" & done", undefined, "accepted false negative (loop)"],
  ["for f in *.txt; do process \"$f\" & done; wait", undefined, "loop"],
  ["while read -r u; do curl -s \"$u\" & done < urls.txt; wait", undefined, "loop"],
  ["f() { sleep 30 & }; f &", undefined, "accepted false negative (function)"],
  ["f() { sleep 30 & }; f", undefined, "function"],
  ["function f { sleep 30 & }; echo defined", undefined, "function"],
  ["( nohup ./server > log 2>&1 & )", undefined, "accepted false negative (subshell)"],
  ["{ nohup ./server > log 2>&1 & }; sleep 1; echo up", undefined, "accepted false negative (brace group)"],
  ["cd /app && (setsid python3 app.py > app.log 2>&1 &) ; sleep 0.2; echo started", undefined, "accepted false negative (subshell)"],
  ["pid=$(nohup python3 app.py > app.log 2>&1 & echo $!); echo $pid", undefined, "accepted false negative (substitution)"],
  ["PID=\"$(sleep 30 > /dev/null 2>&1 & echo $!)\"; echo started", undefined, "accepted false negative (substitution)"],
  ["server & echo \"$(curl -s localhost:8000)\"", undefined, "substitution"],
  ["(server & sleep 1; curl -sf localhost:8000; kill $!)", undefined, "subshell"],
  ["(a & b & wait)", undefined, "subshell"],
  ["{ a & b & wait; }", undefined, "brace group"],
  ["{ sleep 30 & }; wait", undefined, "brace group"],
  ["(server &); sleep 1; curl -sf localhost:8000", undefined, "subshell"],
  ["diff <(sort a.txt &) <(sort b.txt)", undefined, "process substitution"],
  ["x=$(sleep 1 & echo hi); echo $x", undefined, "command substitution"],
  ["x=$(nohup y &) ; echo", undefined, "command substitution"],
  ["out=\"$(make 2>&1 & wait)\"", undefined, "command substitution"],
  ["nohup ./job > $(date +%s).log &", undefined, "a substitution in a redirection"],
  ["echo {a,b}.txt && server &", undefined, "brace expansion counts as nested"],
  // No job at all.
  ["make 2>&1 | tail -40", undefined, "2>&1 and a pipe"],
  ["echo \"a & b\" && ls", undefined, "quoted &"],
  ["echo 'nohup x &'", undefined, "quoted"],
  ["ls &>/dev/null", undefined, "&>"],
  ["cmd >&2", undefined, ">&2"],
  ["echo \\& done", undefined, "escaped &"],
  ["(( a & b )); echo", undefined, "arithmetic"],
  ["echo ${x//&/and}", undefined, "parameter expansion"],
  ["cat <<EOF\nnohup x &\nEOF", undefined, "here-document body"],
  ["ls # nohup foo &", undefined, "comment"],
  ["cat <<< \"a & b\"", undefined, "here-string"],
  ["bc <<< \"2^10\" && echo ok", undefined, "here-string"],
  ["while read -r l; do echo \"$l\"; done <<< \"$(ls)\"", undefined, "here-string with a substitution"],
  ["f() { echo hi; }; f", undefined, "function"],
  ["arr=(a b c); echo ${arr[@]}", undefined, "array"],
  ["find . -name x -exec rm {} \;", undefined, "braces as an argument"],
  ["case \"$1\" in start) echo s ;; *) echo d ;; esac", undefined, "case"],
  ["( case $x in a) echo a ;; (b) echo b ;; esac )", undefined, "case in a subshell"],
  ["for ((i=0; i<3; i++)); do echo $i; done", undefined, "C-style for"],
  ["echo {a,b}.txt && ls", undefined, "brace expansion"],
  // What the scan cannot parse is never refused.
  ["echo 'unterminated &", undefined, "unterminated quote"],
  ["cat <<'EOF'\nnohup x &", undefined, "unterminated here-document"],
  ["x=$(nohup y &", undefined, "unterminated substitution"],
  ["(sleep 30 &", undefined, "unbalanced subshell"],
  ["{ sleep 30 &", undefined, "unclosed brace group"],
  ["echo $(sleep 30 &", undefined, "unterminated substitution"],
];

test.each(CASES)("%j -> %s (%s)", (command, refused) => {
  expect(findUnwaitedBackgroundJob(command)?.kind).toBe(refused);
});

test("masks quoted text, comments and here-document bodies at the same length and records the groups", () => {
  const cmd = "cat > e.py <<'EOF'\nx & y\nEOF\necho \"a&b\" $(c &) # d &\nnohup p &";
  const parsed = parseShellStructure(cmd)!;
  expect(parsed.masked).toHaveLength(cmd.length);
  expect(parsed.masked.slice(parsed.masked.lastIndexOf("\n") + 1)).toBe("nohup p &");
  // The here-document body and its delimiter line are blank: no command.
  expect(parsed.masked.split("\n")[1]).toBe(" ".repeat("x & y\nEOF".length));
  expect(parsed.masked).not.toMatch(/a&b|d &/u);
  expect(parsed.groups.map((group) => [group.kind, cmd.slice(group.start, group.end)]))
    .toEqual([["command-substitution", "c &"]]);
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
