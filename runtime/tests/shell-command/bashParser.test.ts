import { describe, expect, test } from "vitest";

import {
  ensureParserInitialized,
  getParserModule,
  type TsNode,
} from "../../src/utils/bash/bashParser.js";

function parse(source: string): TsNode {
  const root = getParserModule()?.parse(source, Infinity);
  if (root === null || root === undefined) {
    throw new Error(`expected bash parser to parse ${JSON.stringify(source)}`);
  }
  return root;
}

function collectTypes(node: TsNode, out: string[] = []): string[] {
  out.push(node.type);
  for (const child of node.children) collectTypes(child, out);
  return out;
}

function findNode(
  node: TsNode,
  predicate: (candidate: TsNode) => boolean,
): TsNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return undefined;
}

describe("pure TypeScript bash parser", () => {
  test("keeps the compatibility initialization API ready", async () => {
    await expect(ensureParserInitialized()).resolves.toBeUndefined();
    expect(getParserModule()).not.toBeNull();
  });

  test.each([
    {
      name: "lists, pipelines, redirects, and assignments",
      source: 'FOO=bar echo "$FOO" && printf %s done | cat -n >out 2>&1',
      types: [
        "list",
        "pipeline",
        "redirected_statement",
        "variable_assignment",
        "string",
        "simple_expansion",
        "file_redirect",
        "file_descriptor",
      ],
    },
    {
      name: "negation, subshells, background separators, and brace groups",
      source: "! grep -q needle file || (cd src; pwd) & { echo one; echo two; } >>log",
      types: [
        "negated_command",
        "list",
        "subshell",
        "&",
        "compound_statement",
        "file_redirect",
      ],
    },
    {
      name: "herestrings and process substitutions",
      source: 'read value <<<"inline $USER"; diff <(printf a) >(printf b)',
      types: [
        "herestring_redirect",
        "string_content",
        "simple_expansion",
        "process_substitution",
        "<(",
        ">(",
      ],
    },
    {
      name: "loops and c-style arithmetic",
      source:
        "while read line; do echo $line; done < input; for ((i=0; i<3; i++)); do echo $i; done",
      types: [
        "while_statement",
        "do_group",
        "file_redirect",
        "c_style_for_statement",
        "binary_expression",
        "postfix_expression",
      ],
    },
    {
      name: "select loops and case items",
      source:
        "select item in a b; do echo $item; done; case $item in a|b) echo ab ;; *) echo other ;; esac",
      types: [
        "for_statement",
        "select",
        "case_statement",
        "case_item",
        "extglob_pattern",
        ";;",
      ],
    },
    {
      name: "function definitions, declarations, arrays, and unset",
      source: "name() { local x=${1:-default}; echo $(date); }; export A=1 B+=two C=(x y); unset -v name array[0]",
      types: [
        "function_definition",
        "declaration_command",
        "expansion",
        "command_substitution",
        "array",
        "unset_command",
        "concatenation",
      ],
    },
    {
      name: "test commands and regex operators",
      source: "[[ -n $x && ( $x == foo || $x =~ ^bar ) ]]; [ ! cmd -v go &>/dev/null ]",
      types: [
        "test_command",
        "unary_expression",
        "parenthesized_expression",
        "regex",
        "redirected_statement",
        "&>",
      ],
    },
    {
      name: "parameter, arithmetic, command, and ansi-c expansions",
      source:
        "echo ${name:-fallback} ${arr[2]//foo/bar} ${#name} $(( a ? b + 1 : c[2] )) `printf hi` $'line\\n'",
      types: [
        "expansion",
        "subscript",
        "regex",
        "arithmetic_expansion",
        "ternary_expression",
        "command_substitution",
        "ansi_c_string",
      ],
    },
  ])("parses $name", ({ source, types }) => {
    const root = parse(source);
    const seen = new Set(collectTypes(root));

    expect(root.type).toBe("program");
    expect(root.text).toBe(source);
    expect(root.startIndex).toBe(0);
    expect(root.endIndex).toBe(Buffer.byteLength(source, "utf8"));
    for (const type of types) {
      expect(seen, `missing node type ${type}`).toContain(type);
    }
  });

  test.each([
    {
      name: "explicit if, elif, and else clauses",
      source: "if true; then echo yes; elif false; then echo maybe; else echo no; fi",
      types: ["if_statement", "if", "then", "elif_clause", "else_clause", "fi"],
    },
    {
      name: "function keyword definitions with optional parens and redirects",
      source: "function f() { echo hi; } >out; function g { echo hi; }",
      types: [
        "function_definition",
        "function",
        "compound_statement",
        "file_redirect",
      ],
    },
    {
      name: "assignment subscripts with normal and special expansions",
      source: "arr[$i]=value arr[$?]=status echo done",
      types: [
        "variable_assignment",
        "subscript",
        "simple_expansion",
        "special_variable_name",
      ],
    },
    {
      name: "brace ranges and brace-like concatenations",
      source: "echo {1..3} {a..c} {foo,bar} {o[k]}",
      types: ["brace_expression", "..", "concatenation", "number"],
    },
    {
      name: "segmented case patterns with quoted fragments",
      source: 'case $x in plain|*"foo"*|\'bar\') echo hit ;; esac',
      types: [
        "case_statement",
        "case_item",
        "string",
        "raw_string",
        "word",
      ],
    },
    {
      name: "segmented parameter expansion patterns",
      source:
        'echo ${file%".txt"} ${file%%\'tmp\'*} ${path#${HOME}/} ${path%$(basename "$path")}',
      types: [
        "expansion",
        "%",
        "%%",
        "#",
        "string",
        "raw_string",
        "regex",
      ],
    },
    {
      name: "base-prefixed arithmetic numbers",
      source: "echo $((0xff + 16#ff + 2#1010 + 8#77))",
      types: ["arithmetic_expansion", "binary_expression", "number"],
    },
  ])("parses additional branch target: $name", ({ source, types }) => {
    const root = parse(source);
    const seen = new Set(collectTypes(root));

    expect(root.type).toBe("program");
    expect(root.text).toBe(source);
    expect(root.endIndex).toBe(Buffer.byteLength(source, "utf8"));
    for (const type of types) {
      expect(seen, `missing node type ${type}`).toContain(type);
    }
  });

  test.each([
    {
      name: "comments, CRLF whitespace, and line continuations",
      source: "# leading\r\nprintf foo\\\r\nbar # trailing\n# done",
      types: ["comment", "command", "command_name", "word"],
    },
    {
      name: "standalone assignments and bare redirects",
      source: "A=1 B+=two; >out; 2>&- 3<&- cat",
      types: [
        "variable_assignments",
        "redirected_statement",
        "file_redirect",
        "file_descriptor",
        ">&-",
        "<&-",
      ],
    },
    {
      name: "redirect operator variants and greedy redirect destinations",
      source: "cmd >|out &>>append >&2 <&0 >file arg tail",
      types: [">|", "&>>", ">&", "<&", "file_redirect", "word"],
    },
    {
      name: "heredoc trailing redirects, pipelines, and tab-stripped quoted bodies",
      source: "cat <<-\\EOF >out | grep x\n\t$HOME literal\n\tEOF\n",
      types: [
        "heredoc_redirect",
        "heredoc_start",
        "file_redirect",
        "pipeline",
        "heredoc_body",
        "heredoc_end",
      ],
    },
    {
      name: "unquoted heredoc body expansion content",
      source: "cat <<EOF\nbefore $USER after $(date) tail\nEOF\n",
      types: [
        "heredoc_body",
        "simple_expansion",
        "command_substitution",
        "heredoc_content",
      ],
    },
    {
      name: "command substitution shorthand and bracket arithmetic",
      source: "echo $(< input) $[a+=1, b<<=2]",
      types: [
        "command_substitution",
        "file_redirect",
        "arithmetic_expansion",
        "binary_expression",
        "+=",
        "<<=",
      ],
    },
    {
      name: "parameter expansion prefixes, transforms, substrings, arrays, and replacements",
      source:
        'echo $1 $_ $! $(cmd) ${!prefix*} ${var@Q} ${name: -2:1} ${var:} ${var:-("x" y)} ${v//"${old}"\\/$(cmd)tail}',
      types: [
        "simple_expansion",
        "special_variable_name",
        "expansion",
        "@",
        "number",
        "array",
        "string",
        "regex",
        "command_substitution",
      ],
    },
    {
      name: "bizarre and zsh-style parameter expansion forms",
      source: "echo ${#!} ${!#} ${!## } ${=name} ${~name} ${#name} ${2+ ${2}}",
      types: ["expansion", "#", "variable_name", "word"],
    },
    {
      name: "arithmetic unary, assignment, bitwise, logical, exponent, and subscript operators",
      source:
        "echo $(( ++i, --j, ~mask, !ok, a**b, x<<=1, y>>=2, z&=3, q^=4, r|=5, a&&b||c, arr[++i] ))",
      types: [
        "arithmetic_expansion",
        "unary_expression",
        "binary_expression",
        "**",
        "<<=",
        ">>=",
        "&=",
        "^=",
        "|=",
        "subscript",
      ],
    },
    {
      name: "c-style for with brace body",
      source: "for ((i=0; i<3; i++)) { echo $i; }",
      types: [
        "c_style_for_statement",
        "compound_statement",
        "variable_assignment",
        "postfix_expression",
      ],
    },
    {
      name: "regular for without explicit in list",
      source: "for item\ndo echo $item\ndone",
      types: ["for_statement", "variable_name", "do_group", "done"],
    },
    {
      name: "case leading parens and fall-through terminators",
      source: "case $x in (-g) ;; foo) echo foo ;& bar|baz) echo bar ;;& esac",
      types: ["case_statement", "case_item", "(", ";&", ";;&", "word"],
    },
    {
      name: "case alternatives with line continuations and quoted segments",
      source: "case $x in foo|\\\n@(bar|baz)|*\"bar\"*) echo hit ;; esac",
      types: [
        "case_statement",
        "case_item",
        "concatenation",
        "string",
        "extglob_pattern",
      ],
    },
    {
      name: "test pattern operators with quoted regex and extglob RHS",
      source:
        '[[ "$x" = foo && "$x" != @(bar|baz) || "$x" =~ "quoted" ]]; [[ ! "x" =~ \' boop \'(.*)$ ]]',
      types: [
        "test_command",
        "binary_expression",
        "=",
        "!=",
        "=~",
        "extglob_pattern",
        "string",
        "regex",
        "unary_expression",
      ],
    },
    {
      name: "declaration command flags, quoted args, arrays, and bare names",
      source: 'readonly -a arr=(one two); declare "FOO=bar" \'$WEIRD\' plain',
      types: [
        "declaration_command",
        "word",
        "variable_assignment",
        "array",
        "string",
        "raw_string",
        "variable_name",
      ],
    },
    {
      name: "unset command preserves quoted arguments for security walkers",
      source: 'unset -v name \'array[$(id)]\' "$quoted"',
      types: ["unset_command", "variable_name", "raw_string", "string"],
    },
    {
      name: "translated strings, bare dollars, and empty backticks",
      source: 'echo $"hello $USER" "cost $ and $x" foo`\n`bar',
      types: ["$", "string", "simple_expansion", "concatenation"],
    },
  ])("parses targeted uncovered branch: $name", ({ source, types }) => {
    const root = parse(source);
    const seen = new Set(collectTypes(root));

    expect(root.type).toBe("program");
    expect(root.text).toBe(source);
    expect(root.endIndex).toBe(Buffer.byteLength(source, "utf8"));
    for (const type of types) {
      expect(seen, `missing node type ${type}`).toContain(type);
    }
  });

  test.each([
    {
      name: "surrogate-pair word byte accounting",
      source: "echo 😀",
      types: ["command", "word"],
    },
    {
      name: "unterminated heredoc still exposes body and synthetic end",
      source: "cat <<EOF\nbody without delimiter",
      types: ["heredoc_redirect", "heredoc_body", "heredoc_end"],
    },
    {
      name: "unterminated double quote preserves parsed expansion",
      source: 'echo "unterminated $USER',
      types: ["string", "simple_expansion"],
    },
    {
      name: "subscript and parameter operator boundary forms",
      source:
        "echo ${arr[((n+1))]} ${arr[@]} ${arr[*]} ${v:?missing} ${v:=default} ${v:+alt} ${v^x} ${v,,X}",
      types: [
        "subscript",
        "compound_statement",
        "word",
        ":?",
        ":=",
        ":+",
        "^",
        ",,",
      ],
    },
    {
      name: "base-prefixed numbers with expansion children",
      source: "echo 10#${base} 16#$(digits)",
      types: ["number", "expansion", "command_substitution"],
    },
    {
      name: "test expressions with missing unary and binary RHS",
      source: "[[ -f ]] || [[ x == ]] || [[ x =~ ]]",
      types: ["test_command", "test_operator", "list"],
    },
    {
      name: "function keyword without a body",
      source: "function f",
      types: ["function_definition", "function", "word"],
    },
    {
      name: "c-style for without body",
      source: "for ((i=0; i<3; i++))",
      types: ["c_style_for_statement", "variable_assignment"],
    },
    {
      name: "empty case body",
      source: "case $x in esac",
      types: ["case_statement", "esac"],
    },
    {
      name: "replacement expansion treats opening parens as replacement words",
      source: "echo ${v/(/(Gentoo ${x}, }",
      types: ["expansion", "regex", "concatenation"],
    },
  ])("recovers targeted parser boundary: $name", ({ source, types }) => {
    const root = parse(source);
    const seen = new Set(collectTypes(root));

    expect(root.type).toBe("program");
    expect(root.text).toBe(source);
    expect(root.endIndex).toBe(Buffer.byteLength(source, "utf8"));
    for (const type of types) {
      expect(seen, `missing node type ${type}`).toContain(type);
    }
  });

  test.each([
    {
      name: "leading newlines before comments",
      source: "\n\n# top\n\n",
      types: ["comment"],
    },
    {
      name: "trailing bare escape recovers as sibling error",
      source: "echo word\\",
      types: ["command", "word", "ERROR"],
    },
    {
      name: "trailing and-or operator",
      source: "echo ok &&",
      types: ["list", "&&"],
    },
    {
      name: "trailing pipeline operator",
      source: "printf ok |",
      types: ["pipeline", "|"],
    },
    {
      name: "lone negation remains visible as a command word",
      source: "!",
      types: ["command", "command_name", "word"],
    },
    {
      name: "synthetic subshell closer at EOF",
      source: "(echo hi",
      types: ["subshell", ")", "command"],
    },
    {
      name: "synthetic brace group closer at EOF",
      source: "{ echo hi",
      types: ["compound_statement", "}", "command"],
    },
    {
      name: "synthetic test closer at EOF",
      source: "[[ x",
      types: ["test_command", "]]", "word"],
    },
    {
      name: "synthetic arithmetic command closer at EOF",
      source: "(( 1 +",
      types: ["compound_statement", "((", "))", "number"],
    },
    {
      name: "assignment plus redirect without command name",
      source: "A=1 >out",
      types: ["command", "variable_assignment", "file_redirect"],
    },
    {
      name: "function definition hoists redirected compound body",
      source: "f() { echo hi; } >out",
      types: ["function_definition", "compound_statement", "file_redirect"],
    },
    {
      name: "single bracket command fallback stops at closing bracket",
      source: "[ foo bar ]",
      types: ["test_command", "word"],
    },
    {
      name: "word immediately followed by paren becomes recoverable error",
      source: "echo foo(bar)",
      types: ["command", "ERROR", "subshell"],
    },
    {
      name: "heredoc and-or child command before body",
      source: "cat <<EOF && die\nbody\nEOF\n",
      types: ["heredoc_redirect", "command", "heredoc_body", "heredoc_end"],
    },
    {
      name: "heredoc terminator artifact becomes error child",
      source: "cat <<EOF ; rm -rf x\nbody\nEOF\n",
      types: ["heredoc_redirect", "ERROR", "heredoc_body", "heredoc_end"],
    },
    {
      name: "heredoc trailing words remain visible to walkers",
      source: "cat <<EOF extra words\nbody\nEOF\n",
      types: ["heredoc_redirect", "word", "heredoc_body", "heredoc_end"],
    },
    {
      name: "redirect close-fd destination and process substitution target",
      source: "exec >&-target > >(cat)",
      types: [">&-", "file_redirect", "process_substitution", ">("],
    },
    {
      name: "unterminated process substitution",
      source: "echo >(cmd",
      types: ["process_substitution", ")", "command"],
    },
    {
      name: "escaped heredoc body suppresses expansions",
      source: "cat <<EOF\n\\$HOME \\`date\\` \\\\ $USER\nEOF\n",
      types: [
        "heredoc_body",
        "simple_expansion",
        "heredoc_content",
        "heredoc_end",
      ],
    },
    {
      name: "dollar before backtick elides to command substitution",
      source: "echo $`date`",
      types: ["command_substitution", "`", "command"],
    },
    {
      name: "brace terminator and standalone bracket fragments",
      source: "echo {; echo } [ :lower: ]",
      types: ["word", ";", "command"],
    },
    {
      name: "rejected brace ranges fall back to word fragments",
      source: "echo {1..a} {ab..cd} {foo",
      types: ["command", "word", "concatenation"],
    },
    {
      name: "double quotes split escaped newline and backtick substitutions",
      source: 'echo "a\\$b\n`date` $ end"',
      types: ["string", "string_content", "command_substitution", "$"],
    },
    {
      name: "bare dollar and special brace variables",
      source: "echo $ ${!} ${9}",
      types: ["$", "expansion", "special_variable_name", "variable_name"],
    },
    {
      name: "empty and negative substring expansion forms",
      source: "echo ${var:\n} ${var:1:-2}",
      types: ["expansion", "variable_name", "number"],
    },
    {
      name: "replacement with command substitution emits split siblings",
      source: "echo ${v/foo/$(cmd)tail}",
      types: ["expansion", "regex", "command_substitution", "word"],
    },
    {
      name: "regex replacements scan nested substitutions opaquely",
      source: 'echo ${v/${outer:-x}/"quoted"/tail}',
      types: ["expansion", "regex", "string"],
    },
    {
      name: "segmented pattern removal skips nested command and brace forms",
      source: "echo ${file%${prefix:-x}$(suffix)'tail'*}",
      types: ["expansion", "regex", "raw_string"],
    },
    {
      name: "regex test rhs tracks parens and brackets",
      source: "[[ $x =~ ^(foo|bar)[0-9]+\\ space$ ]]",
      types: ["test_command", "binary_expression", "regex"],
    },
    {
      name: "extglob test rhs includes substitutions and quotes",
      source: '[[ $x == pre${name}$(cmd)"mid"\'tail\'@(a|b) ]]',
      types: [
        "test_command",
        "binary_expression",
        "expansion",
        "command_substitution",
        "string",
        "raw_string",
      ],
    },
  ])("recovers additional parser edge: $name", ({ source, types }) => {
    const root = parse(source);
    const seen = new Set(collectTypes(root));

    expect(root.type).toBe("program");
    expect(root.endIndex).toBe(Buffer.byteLength(source, "utf8"));
    for (const type of types) {
      expect(seen, `missing node type ${type}`).toContain(type);
    }
  });

  test.each([
    {
      name: "escaped blanks and CRLF continuations in separator whitespace",
      source: "echo \\ foo \\\r\nbar",
      types: ["command", "word"],
    },
    {
      name: "pipe stderr operator",
      source: "echo a |& cat",
      types: ["pipeline", "|&"],
    },
    {
      name: "stray arithmetic closer recovers as top-level error",
      source: "))",
      types: ["ERROR"],
    },
    {
      name: "single assignment without command name",
      source: "A=1",
      types: ["variable_assignment"],
    },
    {
      name: "array assignment with synthetic close",
      source: "A=(",
      types: ["variable_assignment", "array", ")"],
    },
    {
      name: "assignment subscripts preserve numeric and word indexes",
      source: "arr[42]=x arr[name]=y",
      types: ["variable_assignment", "subscript", "number", "word"],
    },
    {
      name: "compound herestring remains outside disallowed redirect",
      source: "{ echo hi; } <<<inline",
      types: ["compound_statement", "herestring_redirect"],
    },
    {
      name: "redirect without a destination remains a file redirect",
      source: "cmd >",
      types: ["redirected_statement", "file_redirect", ">"],
    },
    {
      name: "pre-command redirect takes only one literal destination",
      source: ">out extra",
      types: ["command", "file_redirect", "command_name"],
    },
    {
      name: "redirect target stops before brace closer",
      source: "{ cmd >}",
      types: ["compound_statement", "file_redirect", "}"],
    },
    {
      name: "quoted punctuation heredoc delimiter",
      source: "cat <<'!EOF!'\nbody\n!EOF!\n",
      types: ["heredoc_redirect", "heredoc_start", "heredoc_body"],
    },
    {
      name: "heredoc trailer restores non-redirect digit words",
      source: "cat <<EOF 2abc\nbody\nEOF\n",
      types: ["heredoc_redirect", "word", "heredoc_body"],
    },
    {
      name: "heredoc trailer keeps multi-stage pipeline child",
      source: "cat <<EOF | grep x | wc\nbody\nEOF\n",
      types: ["heredoc_redirect", "pipeline", "|", "heredoc_body"],
    },
    {
      name: "word-mode expansion rest segments every literal form",
      source: "echo ${v:-$'ansi'$USER\"q\"'r'<(cmd)>($(cmd))`date`{a}}",
      types: [
        "expansion",
        "ansi_c_string",
        "simple_expansion",
        "string",
        "raw_string",
        "process_substitution",
        "command_substitution",
        "concatenation",
      ],
    },
    {
      name: "slash regex replacement scans nested forms opaquely",
      source: "echo ${v//foo\\/${bar:-x}$(cmd){a}/tail}",
      types: ["expansion", "regex", "/", "word"],
    },
    {
      name: "pattern removal segmentation handles quotes and escapes",
      source: "echo ${file%\"quoted\"\\x${prefix}$(cmd)'raw'*}",
      types: ["expansion", "string", "raw_string", "regex"],
    },
    {
      name: "unterminated backtick command substitution",
      source: "echo `date",
      types: ["command_substitution", "`", "command"],
    },
    {
      name: "backtick body keeps command separators",
      source: "echo `a; b& c`",
      types: ["command_substitution", ";", "&"],
    },
    {
      name: "c-style for brace body with synthetic close",
      source: "for ((i=0;i<1;i++)) { echo $i",
      types: ["c_style_for_statement", "compound_statement", "}"],
    },
    {
      name: "regular for restores do keyword when separator is absent",
      source: "for item do echo $item; done",
      types: ["for_statement", "do_group", "done"],
    },
    {
      name: "case statement reaches EOF without esac",
      source: "case $x in foo) echo hit",
      types: ["case_statement", "case_item", "command"],
    },
    {
      name: "test command empty primaries",
      source: "[ ] || [[ ]]",
      types: ["test_command", "list"],
    },
    {
      name: "test and-or operators without right-hand sides",
      source: "[[ x || ]] && [[ y && ]]",
      types: ["test_command", "list", "&&"],
    },
    {
      name: "test parenthesized expression and bare negation",
      source: "[[ ( x ) && ! ]]",
      types: ["parenthesized_expression", "!"],
    },
    {
      name: "test less-than and greater-than comparisons",
      source: "[[ a < b && c > d ]]",
      types: ["binary_expression", "<", ">"],
    },
    {
      name: "test equality operators without right-hand sides",
      source: "[[ x = ]] || [[ y == ]]",
      types: ["test_command", "list"],
    },
    {
      name: "regex test rhs stops at newline",
      source: "[[ $x =~ foo\n]]",
      types: ["test_command", "regex"],
    },
    {
      name: "extglob rhs keeps escapes and interior spaces",
      source: "[[ $x == foo\\ bar baz ]]",
      types: ["test_command", "binary_expression", "extglob_pattern"],
    },
    {
      name: "arithmetic operators and incomplete unary operands",
      source:
        "echo $(( a-=1, b*=2, c/=3, d%=4, e==f, g!=h, i<=j, k>=l, m<<n, o>>p, q&r, s|t, u=v, !, ~ ))",
      types: [
        "arithmetic_expansion",
        "binary_expression",
        "-=",
        "*=",
        "/=",
        "%=",
        "==",
        "!=",
        "<=",
        ">=",
        "<<",
        ">>",
        "&",
        "|",
        "=",
        "!",
        "~",
      ],
    },
    {
      name: "arithmetic parenthesis, string, and dollar primaries",
      source: 'echo $(( (1 + $x) * "${y}" ))',
      types: [
        "arithmetic_expansion",
        "parenthesized_expression",
        "simple_expansion",
        "string",
      ],
    },
    {
      name: "arithmetic synthetic parenthesis and subscript closers",
      source: "echo $(( (1 + arr[2 ))",
      types: ["parenthesized_expression", "subscript", "]", ")"],
    },
    {
      name: "c-style for chained assignments and negative head literal",
      source: "for ((a = b = c = -1; a<=c; a++)); do :; done",
      types: [
        "c_style_for_statement",
        "variable_assignment",
        "number",
        "<=",
        "postfix_expression",
      ],
    },
  ])("covers expression parser edge: $name", ({ source, types }) => {
    const root = parse(source);
    const seen = new Set(collectTypes(root));

    expect(root.type).toBe("program");
    expect(root.endIndex).toBe(Buffer.byteLength(source, "utf8"));
    for (const type of types) {
      expect(seen, `missing node type ${type}`).toContain(type);
    }
  });

  test.each([
    {
      name: "empty source returns an empty program",
      source: "",
      types: [],
    },
    {
      name: "stray separator and doubled separator recovery",
      source: "; echo ok ;;",
      types: ["command"],
    },
    {
      name: "plain LF continuation in command lookahead word",
      source: "foo\\\nbar",
      types: ["command", "command_name"],
    },
    {
      name: "assignment subscript with nested brackets",
      source: "arr[a[b]]=x",
      types: ["variable_assignment", "subscript", "word"],
    },
    {
      name: "expansion subscript with synthetic arithmetic close",
      source: "echo ${arr[((n+1]}",
      types: ["expansion", "subscript", "compound_statement", "))"],
    },
    {
      name: "heredoc pipeline with no command after pipe",
      source: "cat <<EOF |\nbody\nEOF\n",
      types: ["heredoc_redirect", "heredoc_body"],
    },
    {
      name: "heredoc body keeps non-expansion escapes as content",
      source: "cat <<EOF\n\\q $USER\nEOF\n",
      types: ["heredoc_body", "simple_expansion", "heredoc_content"],
    },
    {
      name: "word stops before inline redirect operator",
      source: "echo a>b",
      types: ["redirected_statement", "file_redirect", "word"],
    },
    {
      name: "invalid brace expression stays concatenated",
      source: "echo {1..}",
      types: ["command", "concatenation", "word"],
    },
    {
      name: "bracket-only brace-like word fragments",
      source: "echo {[]",
      types: ["command", "concatenation", "word"],
    },
    {
      name: "bracket arithmetic expansion with synthetic close",
      source: "echo $[1+2",
      types: ["arithmetic_expansion", "$[", "]", "binary_expression"],
    },
    {
      name: "command substitution with synthetic close",
      source: "echo $(date",
      types: ["command_substitution", "$(", ")", "command"],
    },
    {
      name: "brace expansion with synthetic close",
      source: "echo ${var",
      types: ["expansion", "${", "}", "variable_name"],
    },
    {
      name: "anchored slash replacements",
      source: "echo ${v//#foo/bar} ${v//%foo/bar}",
      types: ["expansion", "#", "%", "regex", "word"],
    },
    {
      name: "array default consumes trailing newline before close",
      source: "echo ${v:-(x\n)}",
      types: ["expansion", "array", "word"],
    },
    {
      name: "regex replacement handles quoted middle segments",
      source: "echo ${v//a\"b\"${nested:-x}$(cmd){a}/tail}",
      types: ["expansion", "regex", "word"],
    },
    {
      name: "word replacement stops at slash before replacement",
      source: "echo ${v/foo/bar/baz}",
      types: ["expansion", "regex", "/", "word"],
    },
    {
      name: "empty default expansion has no replacement word",
      source: "echo ${v:-}",
      types: ["expansion", ":-", "variable_name"],
    },
    {
      name: "segmented pattern removal scans nested structures",
      source: "echo ${file%${outer${inner}}$(cmd $(nested))\n}",
      types: ["expansion", "regex"],
    },
    {
      name: "backtick with only a separator elides empty body",
      source: "echo `;`",
      types: ["command"],
    },
    {
      name: "for in-list stops on non-word opener",
      source: "for x in (; do echo $x; done",
      types: ["for_statement", "in"],
    },
    {
      name: "case item empty pattern breaks item parsing",
      source: "case $x in ) echo hit ;; esac",
      types: ["case_statement", "case_item"],
    },
    {
      name: "case line continuation before alternative separator",
      source: "case $x in foo\\\n|bar) echo hit ;; esac",
      types: ["case_statement", "case_item", "|"],
    },
    {
      name: "case pattern with dollar and bracket fragments",
      source: "case $x in ${PN}.pot|*.[1357]) echo hit ;; esac",
      types: ["case_statement", "concatenation", "expansion"],
    },
    {
      name: "case pattern escaped and quoted segments",
      source: "case $x in foo\\ bar|*\"q\\\"\"*) echo hit ;; esac",
      types: ["case_statement", "case_item", "string"],
    },
    {
      name: "case extglob pattern stops at newline inside parens",
      source: "case $x in @(foo\n) echo hit ;; esac",
      types: ["case_statement", "extglob_pattern"],
    },
    {
      name: "declaration treats numeric token as word",
      source: "declare 123",
      types: ["declaration_command", "word"],
    },
    {
      name: "unset without parseable argument stops cleanly",
      source: "unset (",
      types: ["unset_command"],
    },
    {
      name: "if statement without then restores missing keyword",
      source: "if true; echo no",
      types: ["if_statement", "command"],
    },
    {
      name: "arithmetic empty and partial ternary forms",
      source: "echo $(( )), $(( a ? b ))",
      types: ["arithmetic_expansion", "ternary_expression", ":"],
    },
    {
      name: "arithmetic remaining binary operators",
      source: "echo $(( a-b, c/d, e%f, g>h, i^j ))",
      types: ["binary_expression", "-", "/", "%", ">", "^"],
    },
    {
      name: "arithmetic prefix increment without operand",
      source: "echo $(( ++ ))",
      types: ["arithmetic_expansion", "++"],
    },
    {
      name: "arithmetic parenthesis with synthetic close at EOF",
      source: "echo $(( (1 + 2",
      types: ["arithmetic_expansion", "parenthesized_expression", ")"],
    },
  ])("covers residual parser edge: $name", ({ source, types }) => {
    const root = parse(source);
    const seen = new Set(collectTypes(root));

    expect(root.type).toBe("program");
    expect(root.endIndex).toBe(Buffer.byteLength(source, "utf8"));
    for (const type of types) {
      expect(seen, `missing node type ${type}`).toContain(type);
    }
  });

  test("tracks UTF-8 byte spans while preserving node text", () => {
    const source = 'echo cafe\u0301 "雪"';
    const root = parse(source);
    const decomposedCafe = findNode(root, (node) => node.text === "cafe\u0301");
    const snowString = findNode(root, (node) => node.text === '"雪"');

    expect(root.endIndex).toBe(Buffer.byteLength(source, "utf8"));
    expect(decomposedCafe?.startIndex).toBe(Buffer.byteLength("echo ", "utf8"));
    expect(decomposedCafe?.endIndex).toBe(
      Buffer.byteLength("echo cafe\u0301", "utf8"),
    );
    expect(snowString?.startIndex).toBe(
      Buffer.byteLength("echo cafe\u0301 ", "utf8"),
    );
    expect(snowString?.endIndex).toBe(Buffer.byteLength(source, "utf8"));
  });

  test("distinguishes quoted and unquoted heredoc bodies", () => {
    const unquoted = parse("cat <<EOF\n$HOME literal\nEOF");
    const quoted = parse('cat <<"EOF"\n$HOME literal\nEOF');
    const unquotedBody = findNode(
      unquoted,
      (node) => node.type === "heredoc_body",
    );
    const quotedBody = findNode(quoted, (node) => node.type === "heredoc_body");

    expect(unquotedBody?.children.map((node) => node.type)).toContain(
      "simple_expansion",
    );
    expect(quotedBody?.children).toEqual([]);
  });

  test("recovers zsh-style parse errors without losing following structure", () => {
    const root = parse("echo =(cmd)");
    const seen = new Set(collectTypes(root));

    expect(seen).toContain("ERROR");
    expect(seen).toContain("subshell");
  });

  test("returns null when the deadline is already exhausted", () => {
    const source = Array.from({ length: 500 }, (_, index) => `echo ${index}`).join(
      "; ",
    );

    expect(getParserModule()?.parse(source, -1)).toBeNull();
  });
});
