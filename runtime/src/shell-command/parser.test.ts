import { describe, expect, test } from "vitest";
import {
  CANONICAL_BASH_SCRIPT_PREFIX,
  CANONICAL_POWERSHELL_SCRIPT_PREFIX,
  canonicalizeCommandForApproval,
  extractBashCommand,
  extractPowerShellCommand,
  getFirstWordPrefix,
  getSimpleCommandPrefix,
  parseCommand,
  parseCommandArgvTree,
  parseShellLcSingleCommandPrefix,
  parseShellCommand,
  parseShellWrapperSubcommandsForPermission,
  parseWordOnlyShellSequence,
  splitCommand,
} from "./parser.js";

describe("shell string parsing", () => {
  test("keeps parseShellCommand as a conservative single-command tokenizer", () => {
    expect(parseShellCommand("echo 'hello world'")).toEqual([
      "echo",
      "hello world",
    ]);
    expect(parseShellCommand('echo "a \\"b\\" c"')).toEqual([
      "echo",
      'a "b" c',
    ]);
    expect(parseShellCommand("echo a\\ b")).toEqual(["echo", "a b"]);

    expect(parseShellCommand("ls | grep x")).toBeNull();
    expect(parseShellCommand("echo hi > out")).toBeNull();
    expect(parseShellCommand("echo $(whoami)")).toBeNull();
    expect(parseShellCommand("echo $HOME")).toBeNull();
    expect(parseShellCommand("echo ${HOME}")).toBeNull();
    expect(parseShellCommand('echo "$HOME"')).toBeNull();
    expect(parseShellCommand("echo # comment")).toBeNull();
    expect(parseShellCommand("echo 'unterminated")).toBeNull();
  });

  test("parses word-only sequences separately from single-command parsing", () => {
    expect(parseShellCommand("ls | grep x")).toBeNull();
    expect(parseWordOnlyShellSequence("ls | grep x")).toEqual([
      ["ls"],
      ["grep", "x"],
    ]);
    expect(parseWordOnlyShellSequence("echo hi > out")).toBeNull();
    expect(parseWordOnlyShellSequence("FOO=bar ls")).toBeNull();
    expect(parseWordOnlyShellSequence("cat file &")).toBeNull();
    expect(parseWordOnlyShellSequence("&& cat file")).toBeNull();
    expect(parseWordOnlyShellSequence("cat file &&")).toBeNull();
    expect(parseWordOnlyShellSequence("cat file ;; pwd")).toBeNull();
    expect(parseWordOnlyShellSequence("ls | | wc")).toBeNull();
  });

  test("splitCommand honors quotes and escaped separators", () => {
    expect(splitCommand("echo 'a && b' && pwd")).toEqual([
      "echo 'a && b'",
      "pwd",
    ]);
    expect(splitCommand("find . -exec echo {} \\;")).toEqual([
      "find . -exec echo {} \\;",
    ]);
  });

  test("fails closed across metacharacter and unterminated-quote samples", () => {
    const metacharacters = ["|", "&", ";", ">", "<", "(", ")", "`", "$", "#", "{", "}"];
    for (const char of metacharacters) {
      expect(parseShellCommand(`echo before ${char} after`)).toBeNull();
    }

    const malformedInputs = [
      "echo 'unterminated",
      'echo "unterminated',
      `echo ${"a".repeat(4096)} $HOME`,
      `echo ${"literal ".repeat(512)} > out`,
    ];
    for (const input of malformedInputs) {
      expect(parseShellCommand(input)).toBeNull();
    }
  });

  test("prefix helpers preserve safe env-var behavior", () => {
    expect(getSimpleCommandPrefix("NODE_ENV=test npm run build")).toBe(
      "npm run",
    );
    expect(getSimpleCommandPrefix("FOO=bar npm run build")).toBeNull();
    expect(getFirstWordPrefix("CI=1 rg TODO")).toBe("rg");
    expect(getFirstWordPrefix("bash -c 'rm -rf /'")).toBeNull();
  });

  test("extracts shell-wrapper subcommands only for word-only Bash wrappers", () => {
    expect(parseShellWrapperSubcommandsForPermission("bash -lc 'rg TODO src'"))
      .toEqual(["rg TODO src"]);
    expect(parseShellWrapperSubcommandsForPermission("bash -lc 'echo $HOME'"))
      .toBeNull();
    expect(parseShellWrapperSubcommandsForPermission("rg TODO src")).toBeNull();
  });

  test("recovers a single Bash command prefix before here-doc data", () => {
    expect(
      parseShellLcSingleCommandPrefix([
        "bash",
        "-lc",
        "python3 <<'PY'\nprint('hello')\nPY",
      ]),
    ).toEqual(["python3"]);
    expect(
      parseShellLcSingleCommandPrefix(["bash", "-lc", "cat <<< 'literal'"]),
    ).toEqual(["cat"]);
    expect(
      parseShellLcSingleCommandPrefix(["bash", "-lc", "cd src && cat <<EOF"]),
    ).toBeNull();
    expect(
      parseShellLcSingleCommandPrefix(["bash", "-lc", "FOO=bar cat <<EOF"]),
    ).toBeNull();
  });
});

describe("wrapper extraction and argv tree", () => {
  test("recognizes Bash wrappers by basename and exact arity", () => {
    expect(extractBashCommand(["/bin/bash", "-lc", "ls -la"])).toEqual({
      shell: "/bin/bash",
      flag: "-lc",
      script: "ls -la",
    });
    expect(extractBashCommand(["bash", "-lc", "ls", "extra"])).toBeNull();
  });

  test("recognizes PowerShell wrappers with strict flag behavior", () => {
    expect(
      extractPowerShellCommand([
        "pwsh",
        "-NoProfile",
        "-Command",
        "Get-ChildItem",
      ]),
    ).toEqual({
      shell: "pwsh",
      commandFlag: "-Command",
      script: "Get-ChildItem",
    });
    expect(
      extractPowerShellCommand([
        "pwsh",
        "-NoProfile",
        "-Command",
        "Get-ChildItem",
        "ignored",
      ]),
    ).toBeNull();
    expect(extractPowerShellCommand(["powershell.exe", "-NoExit", "-c", "ls"]))
      .toBeNull();
  });

  test("builds word-only and opaque Bash wrapper trees", () => {
    expect(parseCommandArgvTree(["bash", "-lc", "ls | grep x"])).toEqual({
      type: "bash_wrapper",
      shell: "bash",
      flag: "-lc",
      script: "ls | grep x",
      parsed: {
        type: "word_only_shell_sequence",
        commands: [["ls"], ["grep", "x"]],
      },
    });

    expect(parseCommandArgvTree(["bash", "-lc", "echo hi > out"])).toEqual({
      type: "bash_wrapper",
      shell: "bash",
      flag: "-lc",
      script: "echo hi > out",
      parsed: {
        type: "opaque_shell_script",
        shell: "bash",
        shellMode: "-lc",
        script: "echo hi > out",
      },
    });
  });
});

describe("canonicalizeCommandForApproval", () => {
  test("collapses equivalent Bash wrapper paths for a single word-only command", () => {
    expect(
      canonicalizeCommandForApproval([
        "/bin/bash",
        "-lc",
        "cargo   test -p core",
      ]),
    ).toEqual(["cargo", "test", "-p", "core"]);
    expect(canonicalizeCommandForApproval(["bash", "-c", "cargo test"]))
      .toEqual(["cargo", "test"]);
  });

  test("keeps multi-command and unsafe Bash scripts opaque", () => {
    const script = "echo hi | grep hi";
    expect(canonicalizeCommandForApproval(["bash", "-lc", script])).toEqual([
      CANONICAL_BASH_SCRIPT_PREFIX,
      "-lc",
      script,
    ]);
    expect(canonicalizeCommandForApproval(["bash", "-lc", "echo $(date)"]))
      .toEqual([CANONICAL_BASH_SCRIPT_PREFIX, "-lc", "echo $(date)"]);
    expect(canonicalizeCommandForApproval(["bash", "-lc", "echo $HOME"]))
      .toEqual([CANONICAL_BASH_SCRIPT_PREFIX, "-lc", "echo $HOME"]);
    expect(canonicalizeCommandForApproval(["bash", "-lc", "echo ${ROOT:-/}"]))
      .toEqual([CANONICAL_BASH_SCRIPT_PREFIX, "-lc", "echo ${ROOT:-/}"]);
    expect(canonicalizeCommandForApproval(["bash", "-lc", "FOO=bar ls"]))
      .toEqual([CANONICAL_BASH_SCRIPT_PREFIX, "-lc", "FOO=bar ls"]);
  });

  test("leaves non-wrapper and extra-arg Bash argv unchanged", () => {
    const raw = ["bash", "-lc", "ls", "extra"];
    expect(canonicalizeCommandForApproval(raw)).toEqual(raw);
    expect(canonicalizeCommandForApproval(["cargo", "fmt"])).toEqual([
      "cargo",
      "fmt",
    ]);
  });

  test("uses AgenC-branded opaque PowerShell markers", () => {
    expect(
      canonicalizeCommandForApproval([
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "Get-ChildItem",
      ]),
    ).toEqual([CANONICAL_POWERSHELL_SCRIPT_PREFIX, "Get-ChildItem"]);
  });
});

describe("parseCommand", () => {
  test("emits exact parsed command wire shapes for read/list/search/unknown", () => {
    expect(parseCommand(["cat", "runtime/src/index.ts"])).toEqual([
      {
        type: "read",
        cmd: "cat runtime/src/index.ts",
        name: "index.ts",
        path: "runtime/src/index.ts",
      },
    ]);
    expect(parseCommand(["rg", "--files", "webview/src"])).toEqual([
      {
        type: "list_files",
        cmd: "rg --files webview/src",
        path: "webview",
      },
    ]);
    expect(parseCommand(["git", "grep", "TODO", "src"])).toEqual([
      {
        type: "search",
        cmd: "git grep TODO src",
        query: "TODO",
        path: "src",
      },
    ]);
    expect(parseCommand(["git", "status"])).toEqual([
      { type: "unknown", cmd: "git status" },
    ]);
  });

  test("summarizes known shell-wrapped segments and drops formatting helpers", () => {
    expect(
      parseCommand(["bash", "-lc", 'rg -n "TODO" -S | head -n 20']),
    ).toEqual([
      {
        type: "search",
        cmd: "rg -n TODO -S",
        query: "TODO",
        path: null,
      },
    ]);
  });

  test("collapses shell-wrapped commands to one unknown when any kept segment is unknown", () => {
    const script = "git status | wc -l";
    expect(parseCommand(["bash", "-lc", script])).toEqual([
      { type: "unknown", cmd: script },
    ]);
  });

  test("tracks cd before read commands inside shell wrappers", () => {
    expect(parseCommand(["bash", "-lc", "cd runtime && sed -n '1,5p' src/index.ts"]))
      .toEqual([
        {
          type: "read",
          cmd: "sed -n 1,5p src/index.ts",
          name: "index.ts",
          path: "runtime/src/index.ts",
        },
      ]);
  });
});
