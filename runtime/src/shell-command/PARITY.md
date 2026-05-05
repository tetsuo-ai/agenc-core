# Shell Command Parity

Upstream reference: `/home/tetsuo/git/codex/codex-rs/shell-command` at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`.

Primary source anchors:
- `codex-rs/shell-command/src/lib.rs`
- `codex-rs/shell-command/src/shell_detect.rs`
- `codex-rs/shell-command/src/bash.rs`
- `codex-rs/shell-command/src/powershell.rs`
- `codex-rs/shell-command/src/parse_command.rs`
- `codex-rs/shell-command/src/command_safety/mod.rs`
- `codex-rs/shell-command/src/command_safety/is_dangerous_command.rs`
- `codex-rs/shell-command/src/command_safety/is_safe_command.rs`
- `codex-rs/shell-command/src/command_safety/powershell_parser.rs`
- `codex-rs/shell-command/src/command_safety/powershell_parser.ps1`
- `codex-rs/shell-command/src/command_safety/windows_dangerous_commands.rs`
- `codex-rs/shell-command/src/command_safety/windows_safe_commands.rs`

This directory owns the TypeScript port of shell command parsing and safety:
- `parser.ts` carries Bash wrapper extraction, PowerShell wrapper extraction, word-only shell command sequence parsing, single-command prefix recovery for heredoc wrappers, approval-cache canonicalization, and read/list/search summaries.
- `safety.ts` carries Unix read-only safelists, dangerous forced-removal detection, Bash-wrapper recursive safety checks, Windows dangerous command detection, and literal PowerShell command safelists.
- `powershell-parser.ts` carries the platform PowerShell AST integration by spawning the real `powershell`/`pwsh` executable with `-EncodedCommand` and a parser script.

ZC-32 coverage lock:
- Bash shell syntax remains fail-closed. AgenC uses a strict literal parser rather than adding a native tree-sitter dependency in this row; unsupported syntax stays opaque and cannot become an automatic safe approval.
- Windows PowerShell safe auto-approval requires the real platform parser to succeed. When the executable is missing or the AST contains dynamic constructs, the safety layer returns false instead of approximating.
- Command-safety lists are intentionally tighter than the older Bash sandbox allowlist: interpreters, package managers, `xargs`, and path-changing git globals are not sandbox-auto-approved.
- URL examples in tests use `agenc.tech`; no sample or unowned domains are introduced.
