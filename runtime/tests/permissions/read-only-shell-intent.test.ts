import { describe, expect, it } from "vitest";
import { classifyReadOnlyShellIntent } from "../../src/permissions/read-only-shell-intent.js";

describe("read-only shell intent", () => {
  it.each([
    // Shapes models send (from the round-4 qb transcripts).
    "ls -la /workspace && echo \"---README---\" && cat /workspace/README* 2>/dev/null",
    "head -20 /workspace/sales.csv; echo \"---\"; wc -l /workspace/sales.csv",
    "cat /workspace/README.md 2>/dev/null || cat /workspace/README* 2>/dev/null",
    "cd /workspace && git log --oneline -10 && echo \"=== files ===\" && find . -type f -not -path \"./.git/*\" | sort",
    "cd /workspace && for f in src/*.js; do echo \"=== $f ===\"; cat -n \"$f\"; done",
    "cd /workspace && md5sum docs/*.md | awk '{print $1}' | sort | uniq -c",
    "awk -F, 'NR>1 && $4!=\"true\" {s[$1]+=$2*$3} END {for (c in s) printf \"%s %.2f\\n\", c, s[c]}' sales.csv | sort -k2,2nr",
    "cd /workspace && awk -F, '{print $1}' data.csv | sort -t$'\\t' -k2,2gr",
    "git status --porcelain=v1 -b && echo \"---BRANCH---\" && git branch --show-current && git log --oneline -5",
    "git diff --stat main...HEAD; echo \"---BRANCHES---\"; git branch -vv",
    "git stash list && git remote -v && git config --get user.name && git worktree list",
    "node --version && npm --version",
    "cat a.txt | head -50 |& tail -5",
    "sed -n '1,20p' file.txt; sed 's/\\$$//' file.txt; sed -ne '/start/,/end/p' file.txt",
    "grep -rn \"prettyName\" src test; echo \"exit=$?\"",
    "[ -f README.md ] && cat README.md || echo missing",
    "set -euo pipefail; ls -1 src | wc -l",
    "cat a.txt # show the input\nwc -l a.txt",
    "find . -maxdepth 2 \\( -name '*.md' -o -name '*.json' \\) -not -path './node_modules/*' | head -50",
    "ls -la > /dev/null 2>&1; ls nonexistent 2>&1 | head -1",
    "rg -n --hidden 'TODO|FIXME' src | head",
    "xxd file.bin | head; od -c file.bin | head; strings file.bin | head",
    "cd src;",
  ])("admits %s", (command) => {
    expect(classifyReadOnlyShellIntent(command)).toMatchObject({ allowed: true });
  });

  it.each([
    // Writes, explicit or through an option or script.
    "echo x > out.txt", "cat a >> b", "ls 2> errors.log", "cat a | tee b", "cp a b", "mv a b", "rm -rf build",
    "touch marker", "mkdir -p out", "sort -o out.txt in.txt", "sort in.txt --output=out.txt", "uniq in.txt out.txt",
    "sed -i 's/a/b/' f", "sed --in-place 's/a/b/' f", "sed 's/a/b/w out' f", "sed 'w out' f", "sed 's/a/b/e' f",
    "sed -f script.sed f", "awk '{print > \"out\"}' f", "awk '{print | \"sh\"}' f", "awk '{system(\"rm x\")}' f",
    "awk -f prog.awk f", "awk --profile '{print}' f", "awk 'BEGIN{while ((getline l < \"x\") > 0) print l}'",
    "find . -delete", "find . -exec rm {} ;", "find . -fprint out", "xxd -r dump.hex out.bin", "xxd in.bin out.hex",
    "tree -o out.txt", "date -s '2020-01-01'", "file -C -m magic",
    // Programs that write, run others, change state or reach the network.
    "git branch new-feature", "git branch -D old", "git tag v1", "git checkout main", "git switch -c x",
    "git commit -m x", "git stash", "git config user.name x", "git remote add o url", "git remote show origin",
    "git fetch", "git -c core.pager=sh log", "git log --output=log.txt", "git diff --ext-diff", "git $SUB",
    "npm test", "npm install", "node script.js", "python3 -c 'print(1)'", "make", "curl https://example.com",
    "env FOO=1 ls", "FOO=1 ls", "xargs rm", "timeout 10 node app.js", "bash -c 'ls'", "sh script.sh",
    "source env.sh", ". env.sh", "eval ls", "exec ls", "kill 1", "ps aux", "sudo ls", "chmod +x a",
    "tail -f log.txt", "rg --pre sh x", "rg -z x", "./build.sh", "/usr/bin/ls", "command ls",
    // Shell constructs the classification does not model.
    "cat $(ls)", "cat `ls`", "diff <(ls a) <(ls b)", "cat <<EOF\nx\nEOF", "grep x <<< \"$v\"", "ls &",
    "(cd src && ls)", "{ ls; }", "if true; then ls; fi", "while true; do ls; done", "for f in *; do",
    "for PATH in a; do ls; done", "for f in a; do for g in b; do ls; done; done", "ls; done", "do ls",
    "ls >&3", "exec 3<> file", "ls <> file", "cat 'unterminated", "set -- a b", "exit now",
    "sort $OPTS file", "find $DIR -name x", "sed $SCRIPT file", "awk \"$PROG\" f",
  ])("refuses %s", (command) => {
    expect(classifyReadOnlyShellIntent(command)).toMatchObject({ allowed: false });
  });

  it("reports the programs it admitted and a reason for each refusal", () => {
    expect(classifyReadOnlyShellIntent("cd src && ls | sort")).toEqual({ allowed: true, programs: ["cd", "ls", "sort"] });
    expect(classifyReadOnlyShellIntent("ls && rm x")).toEqual({ allowed: false, reason: "rm is not a read-only inspection program" });
    expect(classifyReadOnlyShellIntent("x".repeat(16_385))).toMatchObject({ allowed: false, reason: "the command is too long" });
    expect(classifyReadOnlyShellIntent("  ")).toMatchObject({ allowed: false });
  });
});
