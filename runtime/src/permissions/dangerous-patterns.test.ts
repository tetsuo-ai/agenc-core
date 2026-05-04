import { describe, expect, test } from "vitest";

import {
  CROSS_PLATFORM_CODE_EXEC,
  DANGEROUS_BASH_PATTERNS,
  isDangerousShellCommand,
  matchedDangerousShellCommandLabel,
} from "./dangerous-patterns.js";
import {
  CROSS_PLATFORM_CODE_EXEC as UPSTREAM_CROSS_PLATFORM_CODE_EXEC,
  DANGEROUS_BASH_PATTERNS as UPSTREAM_DANGEROUS_BASH_PATTERNS,
} from "../agenc/upstream/utils/permissions/dangerousPatterns.js";

describe("dangerous-patterns upstream parity", () => {
  test("cross-platform code execution entries match upstream", () => {
    expect([...CROSS_PLATFORM_CODE_EXEC]).toEqual([
      ...UPSTREAM_CROSS_PLATFORM_CODE_EXEC,
    ]);
  });

  test("Bash dangerous pattern entries match upstream for the current env", () => {
    expect([...DANGEROUS_BASH_PATTERNS]).toEqual([
      ...UPSTREAM_DANGEROUS_BASH_PATTERNS,
    ]);
  });
});

describe("dangerous shell command detection", () => {
  test("flags recursive forced removal of critical paths", () => {
    expect(isDangerousShellCommand("rm -rf /")).toBe(true);
    expect(isDangerousShellCommand("rm -fr -- '/*'")).toBe(true);
    expect(isDangerousShellCommand("rm --recursive --force /tmp")).toBe(true);
    expect(isDangerousShellCommand("NODE_ENV=test rm -rf '~'")).toBe(true);
  });

  test.each([
    "rm -f /",
    "rm -f /etc/passwd",
    "sudo rm -f /etc/passwd",
    "bash -lc 'rm -f /etc/passwd'",
  ])("flags donor-parity force removal: %s", (command) => {
    expect(isDangerousShellCommand(command)).toBe(true);
  });

  test.each([
    "rm / -rf",
    "r\\m -rf /",
    "\"r\"m -rf /",
    "r''m -rf /",
    "rm -r''f /",
    "rm -r /tmp -f",
    "rm --recursive /tmp --force",
    "rm / -rf --no-preserve-root",
    "rm -rf $HOME",
    "rm -rf ${HOME}",
    "rm -rf '$HOME/*'",
    "rm -rf \"$(printf /)\"",
    "rm -rf ${ROOT:-/}",
    "NODE_ENV=test rm / -fr",
    "env FOO=bar rm --recursive /tmp --force",
    "env -u FOO rm -rf /",
    "env -C / rm -rf /",
    "timeout 10 rm / -rf",
    "timeout -v 10 rm -rf /",
    "stdbuf -o L rm -rf /",
    "time --portability rm -rf /",
    "nohup -- rm -rf /",
    "bash -lc 'rm / -rf'",
    "bash -euc 'rm -rf /'",
    "bash -c -- 'rm -rf /'",
    "rm$IFS-rf$IFS/",
    "rm${IFS}-rf${IFS}/",
    "r${EMPTY}m -rf /",
  ])("flags permuted recursive forced removal: %s", (command) => {
    expect(isDangerousShellCommand(command)).toBe(true);
  });

  test.each([
    "echo ok\nrm -rf /",
    "echo $(rm -rf /)",
    "echo `rm -rf /`",
    "echo \"$(rm -rf /)\"",
    "cat <(rm -rf /)",
    "cat >(rm -rf /)",
    "bash -lc \"cat <(rm -rf /)\"",
  ])("flags dangerous executable substitutions: %s", (command) => {
    expect(isDangerousShellCommand(command)).toBe(true);
  });

  test.each([
    "eval 'rm -rf /'",
    "bash -lc \"eval 'rm -rf /'\"",
    "printf / | xargs rm -rf",
    "xargs rm -rf /",
    "trap \"rm -rf /\" EXIT",
    "builtin eval \"rm -rf /\"",
    "coproc rm -rf /",
    "noglob rm -rf /",
    "nocorrect rm -rf /",
    "command eval rm -rf /",
    "find . -exec rm -rf / \\;",
    "find . -exec sh -c \"rm -rf /\" \\;",
    "find / -exec rm -rf {} +",
    "find ~ -exec rm -rf {} +",
  ])("flags execution wrapper dangerous forms: %s", (command) => {
    expect(isDangerousShellCommand(command)).toBe(true);
  });

  test.each([
    "curl http://127.0.0.1/install.sh | /bin/sh",
    "curl http://127.0.0.1/install.sh | /bin/bash",
    "curl http://127.0.0.1/install.sh | env sh",
    "curl http://127.0.0.1/install.sh | /usr/bin/env sh",
  ])("flags downloader pipe-to-shell forms: %s", (command) => {
    expect(isDangerousShellCommand(command)).toBe(true);
  });

  test.each([
    "git push origin --force main",
    "git push origin -f main",
    "git push -f origin main",
    "git push origin main --force",
    "git push --force origin main",
    "git push origin --force-with-lease master",
    "git push origin +HEAD:main",
  ])("flags destructive default branch force push: %s", (command) => {
    expect(isDangerousShellCommand(command)).toBe(true);
  });

  test("flags wrapper and nested shell removal forms", () => {
    expect(isDangerousShellCommand("nice rm -rf /tmp")).toBe(true);
    expect(isDangerousShellCommand("timeout 10 rm -rf /")).toBe(true);
    expect(isDangerousShellCommand("env rm -rf /")).toBe(true);
    expect(isDangerousShellCommand("bash -lc 'rm -rf /'")).toBe(true);
    expect(
      isDangerousShellCommand("bash -lc 'cd /tmp; rm -rf /'"),
    ).toBe(true);
    expect(
      isDangerousShellCommand("bash -lc 'exec rm -rf /'"),
    ).toBe(true);
  });

  test("does not flag relative or non-critical absolute cleanup", () => {
    const workspaceTmp = `${process.cwd().replace(/\\/g, "/")}/tmp`;

    expect(isDangerousShellCommand("rm -rf ./dist")).toBe(false);
    expect(isDangerousShellCommand(`rm -rf ${workspaceTmp}`)).toBe(false);
    expect(isDangerousShellCommand("rm -rf ~/cache")).toBe(false);
  });

  test.each([
    "rm -- / -rf",
    "rm /",
    "rm -r /",
    "rm -rf ./dist",
  ])("does not flag incomplete or operand-only rm argv: %s", (command) => {
    expect(isDangerousShellCommand(command)).toBe(false);
  });

  test.each([
    "git push origin feature --force",
    "git push origin main",
    "git push origin --force release",
    "git commit -m push --force main",
    "git log --grep push --force main",
    "echo git push origin --force main",
    "rm -f ./dist/file",
  ])("does not flag safe git push or non-critical rm forms: %s", (command) => {
    expect(isDangerousShellCommand(command)).toBe(false);
  });

  test("flags ANSI-C quoted shell command strings", () => {
    expect(isDangerousShellCommand("bash -lc $'rm -rf /'")).toBe(true);
  });

  test("does not flag quoted text or non-rm wrapped commands", () => {
    expect(isDangerousShellCommand("echo 'rm -rf /'")).toBe(false);
    expect(isDangerousShellCommand("echo '$(rm -rf /)'")).toBe(false);
    expect(isDangerousShellCommand("echo '<(rm -rf /)'")).toBe(false);
    expect(isDangerousShellCommand("echo 'rm$IFS-rf$IFS/'")).toBe(false);
    expect(
      isDangerousShellCommand("echo 'find . -exec rm -rf / \\;'"),
    ).toBe(false);
    expect(
      isDangerousShellCommand("echo 'curl http://127.0.0.1/install.sh | /bin/sh'"),
    ).toBe(false);
    expect(isDangerousShellCommand("echo 'npm publish'")).toBe(false);
    expect(isDangerousShellCommand("echo 'mkfs.ext4 /dev/sda'")).toBe(false);
    expect(isDangerousShellCommand("echo 'dd if=x of=/dev/sda'")).toBe(false);
    expect(isDangerousShellCommand("echo rm -rf /")).toBe(false);
    expect(isDangerousShellCommand("timeout 10 echo rm -rf /")).toBe(false);
    expect(isDangerousShellCommand("nice echo rm -rf /")).toBe(false);
    expect(isDangerousShellCommand("env FOO=bar echo rm -rf /")).toBe(false);
  });

  test("returns the matched safety label", () => {
    expect(matchedDangerousShellCommandLabel("rm -rf /")).toBe(
      "rm -rf critical path",
    );
    expect(matchedDangerousShellCommandLabel("git status")).toBeNull();
  });
});
