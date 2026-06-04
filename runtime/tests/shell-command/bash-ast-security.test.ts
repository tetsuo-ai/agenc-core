import { beforeAll, describe, expect, test } from "vitest";

import {
  checkSemantics,
  nodeTypeId,
  parseForSecurity,
  parseForSecurityFromAst,
  type ParseForSecurityResult,
  type SimpleCommand,
} from "../../src/utils/bash/ast.js";
import { PARSE_ABORTED } from "../../src/utils/bash/parser.js";
import {
  ensureParserInitialized,
  getParserModule,
  type TsNode,
} from "../../src/utils/bash/bashParser.js";

beforeAll(async () => {
  await ensureParserInitialized();
});

function rootFor(source: string): TsNode {
  const root = getParserModule()?.parse(source, Infinity);
  if (!root) throw new Error(`expected parser root for ${JSON.stringify(source)}`);
  return root;
}

function parseAst(source: string): ParseForSecurityResult {
  return parseForSecurityFromAst(source, rootFor(source));
}

function simple(source: string): SimpleCommand[] {
  const result = parseAst(source);
  expect(result).toMatchObject({ kind: "simple" });
  return result.kind === "simple" ? result.commands : [];
}

function command(argv: string[], extra: Partial<SimpleCommand> = {}): SimpleCommand {
  return {
    argv,
    envVars: [],
    redirects: [],
    text: argv.join(" "),
    ...extra,
  };
}

describe("bash AST security parser", () => {
  test("maps dangerous node types to stable telemetry ids", () => {
    expect(nodeTypeId(undefined)).toBe(-2);
    expect(nodeTypeId("ERROR")).toBe(-1);
    expect(nodeTypeId("command_substitution")).toBeGreaterThan(0);
    expect(nodeTypeId("not-a-known-danger")).toBe(0);
  });

  test("handles empty and unavailable parse paths", async () => {
    await expect(parseForSecurity("")).resolves.toEqual({
      kind: "simple",
      commands: [],
    });

    await expect(parseForSecurity("echo hi")).resolves.toEqual({
      kind: "parse-unavailable",
    });

    expect(parseForSecurityFromAst("echo hi", PARSE_ABORTED)).toEqual({
      kind: "too-complex",
      reason:
        "Parser aborted (timeout or resource limit) \u2014 possible adversarial input",
      nodeType: "PARSE_ABORT",
    });
  });

  test.each([
    [`printf '${String.fromCharCode(1)}'`, "Contains control characters"],
    ["echo hello\u00a0world", "Contains Unicode whitespace"],
    ["cat foo\\ bar", "Contains backslash-escaped whitespace"],
    ["echo ~[name]", "Contains zsh ~[ dynamic directory syntax"],
    ["=curl example.test", "Contains zsh =cmd equals expansion"],
    ["echo {a'}',b}", "Contains brace with quote character"],
  ])("rejects pre-parse differential: %s", (source, reason) => {
    expect(parseAst(source)).toMatchObject({
      kind: "too-complex",
      reason: expect.stringContaining(reason),
    });
  });

  test("extracts command lists, env prefixes, redirects, and static variables", () => {
    expect(
      simple("ROOT=/tmp && FOO=bar printf '%s' \"$ROOT\" >out 2>&1"),
    ).toEqual([
      {
        argv: ["printf", "%s", "/tmp"],
        envVars: [{ name: "FOO", value: "bar" }],
        redirects: [
          { op: ">", target: "out" },
          { op: ">&", target: "1", fd: 2 },
        ],
        text: "printf %s /tmp",
      },
    ]);
  });

  test("keeps scope conservative across pipelines, background, and conditionals", () => {
    expect(parseAst("VAR=/tmp | cat $VAR")).toMatchObject({
      kind: "too-complex",
      nodeType: "simple_expansion",
    });

    expect(parseAst("true || FLAG=--force && rm $FLAG")).toMatchObject({
      kind: "too-complex",
      nodeType: "simple_expansion",
    });

    expect(parseAst("if false; then TARGET=/etc; fi && cat $TARGET")).toMatchObject({
      kind: "too-complex",
      nodeType: "simple_expansion",
    });
  });

  test("extracts negated commands", () => {
    expect(simple("! grep needle file").map((cmd) => cmd.argv)).toEqual([
      ["grep", "needle", "file"],
    ]);
  });

  test("fails closed on unsupported bare subshell parser shapes", () => {
    expect(parseAst("(cd src; pwd)")).toMatchObject({
      kind: "too-complex",
    });
  });

  test("extracts if condition and branch commands", () => {
    expect(
      simple("if test -f lock; then echo yes; else echo no; fi").map(
        (cmd) => cmd.argv,
      ),
    ).toEqual([
      ["test", "-f", "lock"],
      ["echo", "yes"],
      ["echo", "no"],
    ]);
  });

  test("extracts test command expression trees", () => {
    expect(
      simple('VALUE=foo && [[ -n "$VALUE" && ( "$VALUE" == foo || "$VALUE" =~ ^fo+ ) ]]').map(
        (cmd) => cmd.argv,
      ),
    ).toEqual([
      [
        "[[",
        "-n",
        "foo",
        "&&",
        "(",
        "foo",
        "==",
        "foo",
        "||",
        "foo",
        "=~",
        "^fo+ )",
        "",
      ],
    ]);
  });

  test("extracts unset commands", () => {
    expect(simple("unset line").map((cmd) => cmd.argv)).toEqual([
      ["unset", "line"],
    ]);
  });

  test("extracts while read bodies with tracked string-only variables", () => {
    expect(simple('while read line; do echo "line:$line"; done').map((cmd) => cmd.argv)).toEqual([
      ["read", "line"],
      ["echo", "line:__TRACKED_VAR__"],
    ]);
  });

  test("handles declaration commands while rejecting semantic-changing forms", () => {
    expect(
      simple("export FOO=bar NAME; declare -r readonly_name=value; typeset plain").map(
        (cmd) => cmd.argv,
      ),
    ).toEqual([
      ["export", "FOO=bar", "NAME"],
      ["declare", "-r", "readonly_name=value"],
      ["typeset", "plain"],
    ]);

    expect(parseAst("declare -n ref=target")).toMatchObject({
      kind: "too-complex",
      nodeType: "declaration_command",
    });
    expect(parseAst("local 'arr[$(id)]=value'")).toMatchObject({
      kind: "too-complex",
      nodeType: "declaration_command",
    });
  });

  test("handles for loops and rejects unsafe loop-variable usage", () => {
    expect(simple("for item in one two; do echo \"item:$item\"; done").map((cmd) => cmd.argv)).toEqual([
      ["echo", "item:__TRACKED_VAR__"],
    ]);

    expect(parseAst("for item in one two; do rm $item; done")).toMatchObject({
      kind: "too-complex",
      nodeType: "simple_expansion",
    });
    expect(parseAst("for PS4 in prompt; do echo ok; done")).toMatchObject({
      kind: "too-complex",
      nodeType: "for_statement",
    });
  });

  test("validates redirects, quoted heredocs, and here-strings", () => {
    expect(simple("> out")).toEqual([
      {
        argv: [],
        envVars: [],
        redirects: [{ op: ">", target: "out" }],
        text: "> out",
      },
    ]);

    expect(simple("cat <<'EOF'\nplain text\nEOF\n").map((cmd) => cmd.argv)).toEqual([
      ["cat"],
    ]);

    expect(parseAst("cat <<EOF\n$(id)\nEOF\n")).toMatchObject({
      kind: "too-complex",
      reason: "Heredoc with unquoted delimiter undergoes shell expansion",
    });

    expect(simple("cat <<< 'literal input'").map((cmd) => cmd.argv)).toEqual([
      ["cat"],
    ]);
    expect(parseAst('cat <<< "ok\n# hidden"')).toMatchObject({
      kind: "too-complex",
    });
  });

  test("extracts redirect target variants and rejects ambiguous redirect syntax", () => {
    expect(simple("echo hi > 'out file'").at(0)?.redirects).toEqual([
      { op: ">", target: "out file" },
    ]);
    expect(simple('echo hi > "out"file').at(0)?.redirects).toEqual([
      { op: ">", target: "outfile" },
    ]);
    expect(parseAst("echo hi > {a,b}")).toMatchObject({
      kind: "too-complex",
    });
    expect(parseAst("cat <<'EOF' | rm x\nbody\nEOF\n")).toMatchObject({
      kind: "too-complex",
    });
  });

  test("handles strings, command substitutions, safe heredoc substitutions, and arithmetic", () => {
    expect(simple('echo "commit: $(git rev-parse HEAD)"').map((cmd) => cmd.argv)).toEqual([
      ["git", "rev-parse", "HEAD"],
      ["echo", "commit: __CMDSUB_OUTPUT__"],
    ]);

    expect(
      simple("printf '%s' \"$(cat <<'EOF'\nbody\nEOF\n)\"").map((cmd) => cmd.argv),
    ).toEqual([["printf", "%s", "body"]]);

    expect(simple("echo $((1 + 2 * 3))").map((cmd) => cmd.argv)).toEqual([
      ["echo", "$((1 + 2 * 3))"],
    ]);

    expect(parseAst("echo $((value + 1))")).toMatchObject({
      kind: "too-complex",
      nodeType: "arithmetic_expansion",
    });
    expect(parseAst('cd "$(pwd)"')).toMatchObject({
      kind: "too-complex",
      nodeType: "string",
    });
    expect(parseAst('echo " "')).toMatchObject({
      kind: "too-complex",
      nodeType: "string",
    });
  });

  test("handles literal dollar signs, safe env interpolation, and unsafe bare env interpolation", () => {
    expect(simple('echo "$" "home:$HOME"').map((cmd) => cmd.argv)).toEqual([
      ["echo", "$", "home:__TRACKED_VAR__"],
    ]);
    expect(parseAst("cat $HOME")).toMatchObject({
      kind: "too-complex",
      nodeType: "simple_expansion",
    });
  });

  test("rejects assignments that change later expansion semantics", () => {
    expect(simple("A=foo && A+=bar && B=$A && echo $B").map((cmd) => cmd.argv)).toEqual([
      ["echo", "foobar"],
    ]);
    expect(simple('A=$(date) && echo "time:$A"').map((cmd) => cmd.argv)).toEqual([
      ["date"],
      ["echo", "time:__TRACKED_VAR__"],
    ]);
    expect(simple("PS4='+${BASH_SOURCE}:${LINENO}: ' && echo ok").map((cmd) => cmd.argv)).toEqual([
      ["echo", "ok"],
    ]);

    expect(parseAst("IFS=: && echo ok")).toMatchObject({
      kind: "too-complex",
      nodeType: "variable_assignment",
    });
    expect(parseAst("PS4+='$(id)' && echo ok")).toMatchObject({
      kind: "too-complex",
      nodeType: "variable_assignment",
    });
    expect(parseAst("PS4='$(id)' && echo ok")).toMatchObject({
      kind: "too-complex",
      nodeType: "variable_assignment",
    });
    expect(parseAst("TARGET=~/secret && cat $TARGET")).toMatchObject({
      kind: "too-complex",
      nodeType: "variable_assignment",
    });
    expect(parseAst("EMPTY= && $EMPTY eval x")).toMatchObject({
      kind: "too-complex",
      nodeType: "simple_expansion",
    });
  });
});

describe("bash AST semantic checks", () => {
  test("unwraps safe command wrappers before checking dangerous commands", () => {
    expect(checkSemantics([command(["time", "nohup", "eval", "id"])])).toEqual({
      ok: false,
      reason: "'eval' evaluates arguments as shell code",
    });
    expect(
      checkSemantics([command(["timeout", "--foreground", "-k", "5", "10s", "eval", "id"])]),
    ).toEqual({
      ok: false,
      reason: "'eval' evaluates arguments as shell code",
    });
    expect(checkSemantics([command(["nice", "-10", "eval", "id"])])).toEqual({
      ok: false,
      reason: "'eval' evaluates arguments as shell code",
    });
    expect(checkSemantics([command(["env", "A=1", "-u", "B", "eval", "id"])])).toEqual({
      ok: false,
      reason: "'eval' evaluates arguments as shell code",
    });
    expect(checkSemantics([command(["stdbuf", "-o0", "-eL", "eval", "id"])])).toEqual({
      ok: false,
      reason: "'eval' evaluates arguments as shell code",
    });
  });

  test.each([
    [["timeout", "--mystery", "10", "echo"], "timeout with --mystery flag cannot be statically analyzed"],
    [["timeout", ".5", "echo"], "timeout duration '.5' cannot be statically analyzed"],
    [["nice", "$((0-5))", "echo"], "nice argument '$((0-5))' contains expansion"],
    [["env", "-S", "echo hi"], "env with -S flag cannot be statically analyzed"],
    [["stdbuf", "--output", "0", "echo"], "stdbuf with --output flag cannot be statically analyzed"],
  ])("rejects wrapper shape %j", (argv, reason) => {
    expect(checkSemantics([command(argv)])).toMatchObject({
      ok: false,
      reason: expect.stringContaining(reason),
    });
  });

  test("allows inert wrapper commands and supported timeout flag forms", () => {
    expect(
      checkSemantics([
        command(["timeout"]),
        command(["env", "A=1"]),
        command(["stdbuf"]),
        command(["timeout", "--signal", "TERM", "-k5", "1m", "echo", "ok"]),
      ]),
    ).toEqual({ ok: true });
  });

  test.each([
    [command([""]), "Empty command name"],
    [command(["__TRACKED_VAR__"]) , "Command name is runtime-determined"],
    [command(["-fragment"]) , "Command appears to be an incomplete fragment"],
    [command(["for"]) , "Shell keyword 'for' as command name"],
    [command(["zmodload"]) , "Zsh builtin 'zmodload'"],
    [command(["eval", "id"]) , "'eval' evaluates arguments as shell code"],
    [command(["trap", "id", "EXIT"]) , "'trap' evaluates arguments as shell code"],
  ])("rejects dangerous command shape %#", (cmd, reason) => {
    expect(checkSemantics([cmd])).toMatchObject({
      ok: false,
      reason: expect.stringContaining(reason),
    });
  });

  test("allows narrow safe forms of eval-like builtins", () => {
    expect(
      checkSemantics([
        command(["command", "-v", "node"]),
        command(["fc", "-ln"]),
        command(["compgen", "-c"]),
      ]),
    ).toEqual({ ok: true });
  });

  test("rejects subscript-evaluating builtin operands", () => {
    expect(checkSemantics([command(["printf", "-v", "arr[$(id)]", "x"])])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("'printf -v' operand contains array subscript"),
    });
    expect(checkSemantics([command(["printf", "-vx[$(id)]", "x"])])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("'printf -v' (fused) operand contains array subscript"),
    });
    expect(checkSemantics([command(["read", "-rp", "[prompt]", "arr[$(id)]"])])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("'read' positional NAME"),
    });
    expect(checkSemantics([command(["[[", "arr[$(id)]", "-eq", "0"])])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("[[ ... -eq ... ]]"),
    });
  });

  test("rejects newline-comment hiding, jq execution, and proc environ reads", () => {
    expect(checkSemantics([command(["cat", "ok\n# hidden"])])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Newline followed by # inside a quoted argument"),
    });
    expect(
      checkSemantics([
        command(["echo"], { envVars: [{ name: "A", value: "ok\n# hidden" }] }),
      ]),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("inside an env var value"),
    });
    expect(
      checkSemantics([
        command(["cat"], { redirects: [{ op: "<", target: "/proc/self/environ" }] }),
      ]),
    ).toMatchObject({
      ok: false,
      reason: "Accesses /proc/*/environ which may expose secrets",
    });
    expect(checkSemantics([command(["jq", "system(\"id\")"])])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("system() function"),
    });
    expect(checkSemantics([command(["jq", "--rawfile=secret", "x", "."])])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("dangerous flags"),
    });
  });
});
