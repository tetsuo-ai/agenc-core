import { spawnSync } from "node:child_process";

export type PowerShellParseOutcome =
  | {
      readonly ok: true;
      readonly commands: readonly (readonly string[])[];
    }
  | {
      readonly ok: false;
      readonly reason: "failed" | "parse_error" | "unsupported";
      readonly diagnostics: readonly string[];
    };

export interface PowerShellParseOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_500;

const POWERSHELL_AST_PARSER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$raw = [Console]::In.ReadToEnd()",
  "if ([string]::IsNullOrWhiteSpace($raw)) { exit 2 }",
  "$request = $raw | ConvertFrom-Json",
  "$bytes = [Convert]::FromBase64String([string]$request.payload)",
  "$source = [Text.Encoding]::Unicode.GetString($bytes)",
  "$tokens = $null",
  "$errors = $null",
  "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
  "function Emit($value) { $value | ConvertTo-Json -Compress -Depth 16 }",
  "if ($errors.Count -gt 0) {",
  "  Emit @{ ok = $false; reason = 'parse_error'; diagnostics = @($errors | ForEach-Object { $_.Message }) }",
  "  exit 0",
  "}",
  "$unsupported = $ast.Find({",
  "  param($node)",
  "  $node -is [System.Management.Automation.Language.VariableExpressionAst] -or",
  "  $node -is [System.Management.Automation.Language.SubExpressionAst] -or",
  "  $node -is [System.Management.Automation.Language.UsingExpressionAst] -or",
  "  $node -is [System.Management.Automation.Language.ScriptBlockExpressionAst] -or",
  "  $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst]",
  "}, $true)",
  "if ($null -ne $unsupported) {",
  "  Emit @{ ok = $false; reason = 'unsupported'; diagnostics = @($unsupported.GetType().Name) }",
  "  exit 0",
  "}",
  "function Lower-Element($element) {",
  "  if ($element -is [System.Management.Automation.Language.CommandParameterAst]) {",
  "    $values = @('-' + $element.ParameterName)",
  "    if ($null -ne $element.Argument) {",
  "      $arg = Lower-Element $element.Argument",
  "      if (-not $arg.ok) { return $arg }",
  "      $values += $arg.values",
  "    }",
  "    return @{ ok = $true; values = $values }",
  "  }",
  "  if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst]) {",
  "    return @{ ok = $true; values = @([string]$element.Value) }",
  "  }",
  "  if ($element -is [System.Management.Automation.Language.ConstantExpressionAst]) {",
  "    return @{ ok = $true; values = @([string]$element.Value) }",
  "  }",
  "  return @{ ok = $false; reason = 'unsupported'; diagnostics = @($element.GetType().Name) }",
  "}",
  "$commands = @()",
  "$commandAsts = @($ast.FindAll({",
  "  param($node)",
  "  $node -is [System.Management.Automation.Language.CommandAst]",
  "}, $true))",
  "foreach ($command in $commandAsts) {",
  "  if ($command.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown) {",
  "    Emit @{ ok = $false; reason = 'unsupported'; diagnostics = @('invocation-operator') }",
  "    exit 0",
  "  }",
  "  if ($command.Redirections.Count -gt 0) {",
  "    Emit @{ ok = $false; reason = 'unsupported'; diagnostics = @('redirection') }",
  "    exit 0",
  "  }",
  "  $words = @()",
  "  foreach ($element in $command.CommandElements) {",
  "    $lowered = Lower-Element $element",
  "    if (-not $lowered.ok) { Emit $lowered; exit 0 }",
  "    $words += $lowered.values",
  "  }",
  "  if ($words.Count -gt 0) { $commands += ,@($words) }",
  "}",
  "Emit @{ ok = $true; commands = $commands }",
].join("\n");

export function parsePowerShellScriptWithNativeAst(
  executable: string,
  script: string,
  options: PowerShellParseOptions = {},
): PowerShellParseOutcome {
  const encodedParser = Buffer.from(
    POWERSHELL_AST_PARSER_SCRIPT,
    "utf16le",
  ).toString("base64");
  const payload = Buffer.from(script, "utf16le").toString("base64");
  const request = `${JSON.stringify({ payload })}\n`;
  const result = spawnSync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedParser,
    ],
    {
      encoding: "utf8",
      input: request,
      maxBuffer: 512 * 1024,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
  );

  if (result.error !== undefined) {
    return {
      ok: false,
      reason: "failed",
      diagnostics: [result.error.message],
    };
  }
  if (result.status !== 0) {
    const diagnostics = [result.stderr, result.stdout]
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return {
      ok: false,
      reason: "failed",
      diagnostics:
        diagnostics.length > 0
          ? diagnostics
          : [`PowerShell parser exited with status ${result.status ?? "null"}`],
    };
  }

  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (line === undefined) {
    return {
      ok: false,
      reason: "failed",
      diagnostics: ["PowerShell parser produced no JSON output"],
    };
  }

  try {
    const parsed = JSON.parse(line) as unknown;
    return normalizeParserResponse(parsed);
  } catch (error) {
    return {
      ok: false,
      reason: "failed",
      diagnostics: [
        error instanceof Error ? error.message : String(error),
        line,
      ],
    };
  }
}

function normalizeParserResponse(value: unknown): PowerShellParseOutcome {
  if (!isRecord(value)) {
    return { ok: false, reason: "failed", diagnostics: ["non-object parser response"] };
  }
  if (value.ok === true) {
    const commands = Array.isArray(value.commands)
      ? value.commands
          .filter((command): command is readonly unknown[] => Array.isArray(command))
          .map((command) => command.map((word) => String(word)))
          .filter((command) => command.length > 0)
      : [];
    return { ok: true, commands };
  }

  const reason =
    value.reason === "parse_error" || value.reason === "unsupported"
      ? value.reason
      : "failed";
  const diagnostics = Array.isArray(value.diagnostics)
    ? value.diagnostics.map((entry) => String(entry))
    : [];
  return {
    ok: false,
    reason,
    diagnostics,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
