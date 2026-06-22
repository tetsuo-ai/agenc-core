import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readSync, writeSync } from "node:fs";
import { isRecord } from "../utils/record.js";

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

const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_PROTOCOL_BUFFER_BYTES = 512 * 1024;
const POLL_INTERVAL_MS = 5;
const SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));

const POWERSHELL_AST_PARSER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$utf8 = [System.Text.UTF8Encoding]::new($false)",
  "$stdin = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8, $false)",
  "$stdout = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)",
  "$stdout.AutoFlush = $true",
  "function Emit($value) { $stdout.WriteLine(($value | ConvertTo-Json -Compress -Depth 16)) }",
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
  "  if ($element -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {",
  "    if ($element.NestedExpressions.Count -gt 0) {",
  "      return @{ ok = $false; reason = 'unsupported'; diagnostics = @($element.GetType().Name) }",
  "    }",
  "    return @{ ok = $true; values = @([string]$element.Value) }",
  "  }",
  "  if ($element -is [System.Management.Automation.Language.ConstantExpressionAst]) {",
  "    return @{ ok = $true; values = @([string]$element.Value) }",
  "  }",
  "  return @{ ok = $false; reason = 'unsupported'; diagnostics = @($element.GetType().Name) }",
  "}",
  "function Parse-Source($requestId, $source) {",
  "  $tokens = $null",
  "  $errors = $null",
  "  try {",
  "    $ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
  "  } catch {",
  "    return @{ id = $requestId; ok = $false; reason = 'failed'; diagnostics = @($_.Exception.Message) }",
  "  }",
  "  if ($errors.Count -gt 0) {",
  "    return @{ id = $requestId; ok = $false; reason = 'parse_error'; diagnostics = @($errors | ForEach-Object { $_.Message }) }",
  "  }",
  "  $unsupported = $ast.Find({",
  "    param($node)",
  "    $node -is [System.Management.Automation.Language.VariableExpressionAst] -or",
  "    $node -is [System.Management.Automation.Language.SubExpressionAst] -or",
  "    $node -is [System.Management.Automation.Language.UsingExpressionAst] -or",
  "    $node -is [System.Management.Automation.Language.ScriptBlockExpressionAst] -or",
  "    $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst]",
  "  }, $true)",
  "  if ($null -ne $unsupported) {",
  "    return @{ id = $requestId; ok = $false; reason = 'unsupported'; diagnostics = @($unsupported.GetType().Name) }",
  "  }",
  "  $commands = @()",
  "  $commandAsts = @($ast.FindAll({",
  "    param($node)",
  "    $node -is [System.Management.Automation.Language.CommandAst]",
  "  }, $true))",
  "  foreach ($command in $commandAsts) {",
  "    if ($command.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown) {",
  "      return @{ id = $requestId; ok = $false; reason = 'unsupported'; diagnostics = @('invocation-operator') }",
  "    }",
  "    if ($command.Redirections.Count -gt 0) {",
  "      return @{ id = $requestId; ok = $false; reason = 'unsupported'; diagnostics = @('redirection') }",
  "    }",
  "    $words = @()",
  "    foreach ($element in $command.CommandElements) {",
  "      $lowered = Lower-Element $element",
  "      if (-not $lowered.ok) {",
  "        return @{ id = $requestId; ok = $false; reason = $lowered.reason; diagnostics = $lowered.diagnostics }",
  "      }",
  "      $words += $lowered.values",
  "    }",
  "    if ($words.Count -gt 0) { $commands += ,@($words) }",
  "  }",
  "  return @{ id = $requestId; ok = $true; commands = $commands }",
  "}",
  "while (($line = $stdin.ReadLine()) -ne $null) {",
  "  try {",
  "    $request = $line | ConvertFrom-Json",
  "  } catch {",
  "    Emit @{ id = $null; ok = $false; reason = 'failed'; diagnostics = @('invalid request json') }",
  "    continue",
  "  }",
  "  $requestId = $request.id",
  "  $payload = [string]$request.payload",
  "  if ([string]::IsNullOrEmpty($payload)) {",
  "    Emit @{ id = $requestId; ok = $false; reason = 'failed'; diagnostics = @('missing payload') }",
  "    continue",
  "  }",
  "  try {",
  "    $source = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($payload))",
  "  } catch {",
  "    Emit @{ id = $requestId; ok = $false; reason = 'failed'; diagnostics = @($_.Exception.Message) }",
  "    continue",
  "  }",
  "  Emit (Parse-Source $requestId $source)",
  "}",
].join("\n");

const ENCODED_PARSER_SCRIPT = Buffer.from(
  POWERSHELL_AST_PARSER_SCRIPT,
  "utf16le",
).toString("base64");

const parserProcesses = new Map<string, PowerShellParserProcess>();

export function parsePowerShellScriptWithNativeAst(
  executable: string,
  script: string,
  options: PowerShellParseOptions = {},
): PowerShellParseOutcome {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (let attempt = 0; attempt <= 1; attempt++) {
    const process = getOrCreateParserProcess(executable);
    if (!process.ok) {
      return {
        ok: false,
        reason: "failed",
        diagnostics: [process.diagnostic],
      };
    }

    try {
      return process.parser.parse(script, timeoutMs);
    } catch (error) {
      parserProcesses.delete(executable);
      process.parser.dispose();
      if (attempt === 1) {
        return {
          ok: false,
          reason: "failed",
          diagnostics: [error instanceof Error ? error.message : String(error)],
        };
      }
    }
  }

  return {
    ok: false,
    reason: "failed",
    diagnostics: ["PowerShell parser failed after retry"],
  };
}

export function clearPowerShellParserCacheForTests(): void {
  for (const parser of parserProcesses.values()) {
    parser.dispose();
  }
  parserProcesses.clear();
}

function getOrCreateParserProcess(
  executable: string,
):
  | { readonly ok: true; readonly parser: PowerShellParserProcess }
  | { readonly ok: false; readonly diagnostic: string } {
  const existing = parserProcesses.get(executable);
  if (existing !== undefined && existing.isUsable()) {
    return { ok: true, parser: existing };
  }
  if (existing !== undefined) {
    parserProcesses.delete(executable);
    existing.dispose();
  }

  const created = PowerShellParserProcess.create(executable);
  if (!created.ok) return created;
  parserProcesses.set(executable, created.parser);
  return created;
}

class PowerShellParserProcess {
  private stdoutBuffer = "";
  private nextRequestId = 0;
  private processError: Error | null = null;
  private disposed = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly stdinFd: number,
    private readonly stdoutFd: number,
  ) {
    this.child.on("error", (error) => {
      this.processError = error;
    });
    this.child.unref();
    unrefStream(this.child.stdin);
    unrefStream(this.child.stdout);
    unrefStream(this.child.stderr);
  }

  static create(
    executable: string,
  ):
    | { readonly ok: true; readonly parser: PowerShellParserProcess }
    | { readonly ok: false; readonly diagnostic: string } {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          ENCODED_PARSER_SCRIPT,
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch (error) {
      return {
        ok: false,
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    }
    child.on("error", () => {
      // Missing executables surface asynchronously from spawn(); keep a listener
      // even when the pid/fd check below fails so callers get a failed outcome.
    });

    const stdinFd = streamFd(child.stdin);
    const stdoutFd = streamFd(child.stdout);
    if (child.pid === undefined || stdinFd === null || stdoutFd === null) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.pid !== undefined) child.kill();
      return {
        ok: false,
        diagnostic: `failed to spawn PowerShell parser process for ${executable}`,
      };
    }

    return {
      ok: true,
      parser: new PowerShellParserProcess(child, stdinFd, stdoutFd),
    };
  }

  isUsable(): boolean {
    return (
      !this.disposed &&
      this.processError === null &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }

  parse(script: string, timeoutMs: number): PowerShellParseOutcome {
    if (!this.isUsable()) {
      throw new Error("PowerShell parser process is not usable");
    }

    const requestId = this.nextRequestId;
    this.nextRequestId = (this.nextRequestId + 1) >>> 0;
    const payload = Buffer.from(script, "utf16le").toString("base64");
    const request = `${JSON.stringify({ id: requestId, payload })}\n`;
    writeAllSync(this.stdinFd, Buffer.from(request, "utf8"), timeoutMs);

    const line = this.readLine(timeoutMs);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `failed to parse PowerShell parser response: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return normalizeParserResponse(parsed, requestId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    if (this.child.pid !== undefined) this.child.kill();
  }

  private readLine(timeoutMs: number): string {
    const existingLine = this.takeBufferedLine();
    if (existingLine !== null) return existingLine;

    const deadline = Date.now() + timeoutMs;
    const buffer = Buffer.allocUnsafe(4096);
    while (Date.now() <= deadline) {
      this.assertAlive();
      let bytesRead = 0;
      try {
        bytesRead = readSync(this.stdoutFd, buffer, 0, buffer.length, null);
      } catch (error) {
        if (isWouldBlock(error)) {
          sleepSync(POLL_INTERVAL_MS);
          continue;
        }
        throw error;
      }

      if (bytesRead === 0) {
        throw new Error("PowerShell parser closed stdout");
      }
      this.stdoutBuffer += buffer.toString("utf8", 0, bytesRead);
      if (this.stdoutBuffer.length > MAX_PROTOCOL_BUFFER_BYTES) {
        throw new Error("PowerShell parser protocol buffer exceeded limit");
      }

      const line = this.takeBufferedLine();
      if (line !== null) return line;
    }

    throw new Error(`PowerShell parser timed out after ${timeoutMs}ms`);
  }

  private takeBufferedLine(): string | null {
    const index = this.stdoutBuffer.indexOf("\n");
    if (index === -1) return null;
    const line = this.stdoutBuffer.slice(0, index).replace(/\r$/u, "");
    this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
    return line;
  }

  private assertAlive(): void {
    if (this.processError !== null) throw this.processError;
    if (this.child.exitCode !== null) {
      throw new Error(`PowerShell parser exited with status ${this.child.exitCode}`);
    }
    if (this.child.signalCode !== null) {
      throw new Error(`PowerShell parser exited from signal ${this.child.signalCode}`);
    }
  }
}

function writeAllSync(fd: number, buffer: Buffer, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  while (offset < buffer.length && Date.now() <= deadline) {
    try {
      const bytesWritten = writeSync(fd, buffer, offset, buffer.length - offset);
      offset += bytesWritten;
    } catch (error) {
      if (isWouldBlock(error)) {
        sleepSync(POLL_INTERVAL_MS);
        continue;
      }
      throw error;
    }
  }
  if (offset < buffer.length) {
    throw new Error(`PowerShell parser write timed out after ${timeoutMs}ms`);
  }
}

function normalizeParserResponse(
  value: unknown,
  expectedId: number,
): PowerShellParseOutcome {
  if (!isRecord(value)) {
    return { ok: false, reason: "failed", diagnostics: ["non-object parser response"] };
  }
  if (value.id !== expectedId) {
    return {
      ok: false,
      reason: "failed",
      diagnostics: [`parser response id ${String(value.id)} did not match ${expectedId}`],
    };
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

type HandleBackedStream = {
  readonly fd?: number;
  readonly _handle?: {
    readonly fd?: number;
  };
  readonly unref?: () => void;
};

function streamFd(stream: unknown): number | null {
  const candidate = stream as HandleBackedStream;
  return typeof candidate.fd === "number"
    ? candidate.fd
    : typeof candidate._handle?.fd === "number"
      ? candidate._handle.fd
      : null;
}

function unrefStream(stream: unknown): void {
  const candidate = stream as HandleBackedStream;
  candidate.unref?.();
}

function isWouldBlock(error: unknown): boolean {
  return isRecord(error) && (error.code === "EAGAIN" || error.code === "EWOULDBLOCK");
}

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_VIEW, 0, 0, ms);
}
