import { describe, expect, test } from "vitest";
import {
  findUnwaitedBackgroundJob,
  isPosixShell,
  parseShellStructure,
  unwaitedBackgroundJobMessage,
  type UnwaitedBackgroundJob,
} from "../../../src/tools/system/background-job-refusal.js";

// One rule: a background job is refused only when it is trailing, that is
// when nothing after it in execution order does real work (only echo,
// printf, true, :, sleep, disown, or a wait in another shell may follow) and
// nothing waits for it (a wait in its own shell, or the reader of the
// substitution its output feeds). Every example from both reviews of PR 3355
// is here, with the earlier rounds' cases and the Terminal-Bench commands
// (AgenC 0.19.19 and 0.19.24) that motivated the scan.
const CASES: readonly (readonly [command: string, refused: UnwaitedBackgroundJob["kind"] | undefined, why: string])[] = [
  // Jobs that nothing serves.
  ["nohup python3 train.py > /tmp/log 2>&1 &", "nohup", "nothing after it"],
  ["cat > /tmp/exp.py <<'EOF'\nimport os & sys\nx = a & b\nEOF\nnohup python3 /tmp/exp.py A '{\"dim\":50}' > /tmp/expA.log 2>&1 &\nnohup python3 /tmp/exp.py B > /tmp/expB.log 2>&1 &\necho started", "nohup", "train-fasttext Chi3Pzn: only echo after the second job"],
  ["python3 a.py > a.log 2>&1 &", "trailing", "nothing after it"],
  ["python3 a.py & python3 b.py &", "trailing", "the second job is trailing"],
  ["( cd /app && make -j8 ) &", "trailing", "a backgrounded subshell"],
  ["./server &\necho $! > pid", "trailing", "echo does no work"],
  ["python a.py & # started", "trailing", "a comment is nothing"],
  ["./server & disown", "disown", "disown does no work"],
  ["FOO=1 /usr/bin/nohup ./job &", "nohup", "assignment and path"],
  ["nohup ./train.sh > log 2>&1 & sleep 5; echo started", "nohup", "sleep and echo do no work"],
  ["if true; then echo yes & fi", "trailing", "fi does no work"],
  ["for f in *.txt; do process \"$f\" & done", "trailing", "no wait after the loop"],
  ["f() { sleep 30 & }; f &", "trailing", "a backgrounded call of a function"],
  // Nested jobs (first review).
  ["(sleep 30 &)", "trailing", "review 1: subshell"],
  ["{ sleep 30 & }", "trailing", "review 1: brace group"],
  ["(sleep 30 &); echo started", "trailing", "subshell, then echo"],
  ["( nohup ./server > log 2>&1 & )", "nohup", "subshell"],
  ["{ nohup ./server > log 2>&1 & }; sleep 1; echo up", "nohup", "brace group, then sleep and echo"],
  ["cd /app && (setsid python3 app.py > app.log 2>&1 &) ; sleep 0.2; echo started", "setsid", "subshell, then sleep and echo"],
  ["pid=$(nohup python3 app.py > app.log 2>&1 & echo $!); echo $pid", "nohup", "its output leaves the substitution"],
  ["PID=\"$(sleep 30 > /dev/null 2>&1 & echo $!)\"; echo started", "trailing", "its output leaves the substitution"],
  // A wait in another shell cannot reach the job (second review).
  ["(nohup sleep 30 &); wait", "nohup", "review 2: the wait is in the parent shell"],
  ["nohup sleep 30 & (wait)", "nohup", "review 2: the wait is in a subshell"],
  ["server & wait | cat; echo done", undefined, "cat does work"],
  // Here-strings and here-documents (first review).
  ["cat <<< \"hello\"; sleep 30 &", "trailing", "review 1: here-string, then a trailing job"],
  ["cat <<< 'a & b' && nohup ./job > log &", "nohup", "here-string with a quoted &"],
  ["grep -q x <<< \"$v\"; cat > f <<EOF\nx & y\nEOF\nnohup ./p > p.log 2>&1 &", "nohup", "here-string and here-document"],
  ["read -r a b <<<\"$line\"; ./worker & echo started", "trailing", "here-string without a space"],
  // Jobs that serve later work, or that something waits for.
  ["cd /app && nohup python3 pystan_analysis.py > /tmp/run.log 2>&1 & echo started; sleep 60; tail -c 400 /tmp/run.log", undefined, "rstan AgbWbf9: tail reads its log"],
  ["setsid nohup python3 -m http.server 8080 >/var/log/w.log 2>&1 < /dev/null & sleep 1; pgrep -af http.server; cat /var/log/w.log", undefined, "configure-git 6gFyQwS: pgrep and cat"],
  ["cd /tmp/CompCert && nohup make -j2 all > /tmp/compcert-build.log 2>&1 & echo \"PID:$!\"; sleep 45; tail -20 /tmp/compcert-build.log", undefined, "compile-compcert 9VYHKdh: tail"],
  ["server & sleep 1; curl -sf localhost:8000; kill $!", undefined, "curl"],
  ["server & pid=$!; sleep 0.5; curl -s http://127.0.0.1:3000/health; kill $pid", undefined, "curl"],
  ["node server.js & sleep 2 && curl localhost:3000", undefined, "curl after &&"],
  ["server & npm test", undefined, "a test run"],
  ["server & echo \"$(curl -s localhost:8000)\"", undefined, "curl inside a later substitution"],
  ["a & b & wait", undefined, "wait in its shell"],
  ["nohup a & nohup b & wait", undefined, "wait in its shell"],
  ["for f in *.txt; do process \"$f\" & done; wait", undefined, "wait after the loop"],
  ["while read -r u; do curl -s \"$u\" & done < urls.txt; wait", undefined, "wait after the loop"],
  ["(server & sleep 1; curl -sf localhost:8000; kill $!)", undefined, "curl in the same subshell"],
  ["(a & b & wait)", undefined, "wait in the same subshell"],
  ["{ a & b & wait; }", undefined, "wait in the same shell"],
  ["{ sleep 30 & }; wait", undefined, "a brace group is the same shell"],
  ["{ sleep 0.1 & } && wait", undefined, "review 2: wait after && reaches it"],
  ["(server &); sleep 1; curl -sf localhost:8000", undefined, "curl after the subshell"],
  ["(python3 -m http.server 8000 &) && sleep 1 && curl -sf localhost:8000", undefined, "review 2: curl after &&"],
  ["cat <(nohup printf hello &)", undefined, "review 1: cat reads it to the end"],
  ["diff <(sort a.txt &) <(sort b.txt)", undefined, "diff reads both"],
  ["x=$(sleep 1 & echo hi); echo $x", undefined, "the substitution reads its output"],
  ["x=$(nohup y &) ; echo", undefined, "the substitution reads its output"],
  ["out=\"$(make 2>&1 & wait)\"", undefined, "2>&1 keeps its output; wait"],
  // Function definitions start nothing (second review).
  ["f() { sleep 30 & }; echo defined", undefined, "review 2: only a definition"],
  ["function f { sleep 30 & }; echo defined", undefined, "only a definition"],
  ["f() { sleep 30 & }; f", undefined, "a call that is not backgrounded"],
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
  ["cd /app/work && nohup python3 - > B.log 2>&1 <<'EOF' &\nimport fasttext\nm = fasttext.train_supervised(input='train.txt')\nEOF", "nohup", "train-fasttext j4WfVbg: its own here-document is no command after it"],
  ["server & cat > notes.txt <<'EOF'\nstarted & running\nEOF", undefined, "cat does work"],
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
