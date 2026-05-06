# Tools Parity

Upstream runtime reference: `/home/tetsuo/git/codex` at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`.
Upstream TUI reference: `/home/tetsuo/git/openclaude` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

## TL-02 Edit Tool

Primary source anchors:
- `src/tools/FileEditTool/FileEditTool.ts`
- `src/tools/FileEditTool/utils.ts`
- `src/tools/FileEditTool/prompt.ts`
- `src/tools/FileEditTool/types.ts`
- `src/components/permissions/FileEditPermissionRequest/FileEditPermissionRequest.tsx`
- `src/components/permissions/SedEditPermissionRequest/SedEditPermissionRequest.tsx`
- `src/components/permissions/FilePermissionDialog/FilePermissionDialog.tsx`
- `src/components/permissions/FilePermissionDialog/ideDiffConfig.ts`
- `src/components/FileEditToolDiff.tsx`

Target coverage:
- `runtime/src/tool-registry.ts` registers the visible `Edit` and `MultiEdit` tools in the first-class file surface.
- `runtime/src/tools/system/file-edit.ts` owns the provider-facing edit execution contract: read-before-write, stale-read rejection, exact replacement, `replace_all`, empty-old-string create semantics, notebook rejection, path permission checks, mutation metadata, post-write read snapshots, and LSP change notification.
- Existing-file edits require a full read snapshot. Partial offset/limit reads and stale full reads do not authorize writes; only nonexistent-file creation is exempt from the read gate.
- Empty replacements intentionally follow the donor `old_string + "\n"` deletion rule, including inline matches and `replace_all` behavior.
- Quote-normalized matches follow the donor helper: smart quotes can resolve to the actual file substring, then uniqueness and `replace_all` operate on that concrete substring. Dashes and non-ASCII spaces remain exact text and are not normalized.
- Existing file edits preserve detected UTF-8/UTF-16LE encoding and LF/CRLF line-ending style on disk while matching against LF-normalized read content.
- `runtime/src/tools/FileEditTool/` owns the upstream-shaped TUI/tool rendering contract used by permission and transcript components.
- `runtime/src/tui/components/diff/FileEditToolDiff.tsx` and `runtime/src/tui/components/permissions/{FileEditPermissionRequest,SedEditPermissionRequest,FilePermissionDialog}/` own diff rendering and file-edit permission flow, including full-file preview fallback when raw context scan misses a quote-normalized match and complete capped-file previews for `replace_all`.
- `runtime/src/tui/components/permissions/PermissionRequest.tsx` maps both upstream-shaped file-edit tools and live registered `Edit`/`MultiEdit` runtime tools to `FileEditPermissionRequest`.

Tests:
- `runtime/src/tools/system/file-edit.test.ts`
- `runtime/src/permissions/path-validation.test.ts`
- `runtime/src/tui/components/diff/diff-renderer.test.tsx`
- `runtime/src/tui/parity/permission-bridge.permission-request-absorb.test.ts`

Intentional reductions:
- AgenC exposes one provider-facing execution path through `runtime/src/tools/system/file-edit.ts`; the upstream-shaped `runtime/src/tools/FileEditTool/` module remains the TUI/rendering and permission compatibility surface.
- The visible file-edit result is AgenC's plain-text `ToolResult` envelope plus mutation metadata, not a product-specific tool-result block.

## TL-01 Bash Tool

Primary source anchors:
- `codex-rs/core/src/tools/handlers/shell.rs`
- `codex-rs/core/src/tools/runtimes/shell.rs`
- `codex-rs/shell-command/src/parse_command.rs`
- `codex-rs/shell-command/src/command_safety/is_dangerous_command.rs`
- `codex-rs/execpolicy/src/parser.rs`
- `codex-rs/execpolicy/src/policy.rs`
- `codex-rs/execpolicy/src/rule.rs`
- `src/tools/BashTool/BashTool.tsx`
- `src/tools/BashTool/UI.tsx`
- `src/tools/BashTool/BashToolResultMessage.tsx`
- `src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx`
- `src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx`

Target coverage:
- `runtime/src/tool-registry.ts` owns the model-facing shell catalog. `exec_command` and `write_stdin` are visible by default; `system.bash` is registered as the deferred bash fallback.
- `runtime/src/tools/system/exec-command.ts`, `runtime/src/tools/system/write-stdin.ts`, and `runtime/src/unified-exec/process-manager.ts` own durable shell execution, process lifecycle, stdin continuation, sandbox threading, and output formatting.
- `runtime/src/tools/system/bash.ts` owns the dual-mode bash fallback for command-plus-args and shell-string invocations.
- `runtime/src/sandbox/execpolicy/` owns prefix and network execution-policy parsing/evaluation.
- `runtime/src/permissions/bash.ts` and `runtime/src/tui/components/permissions/BashPermissionRequest/` own bash permission decisions and prompt options.
- `runtime/src/tools/BashTool/` and `runtime/src/tui/tool-rendering.tsx` own bash command/result rendering.

Tests:
- `runtime/src/tool-registry.test.ts`
- `runtime/src/tools/system/exec-command.test.ts`
- `runtime/src/tools/system/bash.test.ts`
- `runtime/src/tools/system/bash.i78.test.ts`
- `runtime/src/unified-exec/process-manager.test.ts`
- `runtime/src/sandbox/execpolicy/execpolicy.test.ts`
- `runtime/src/permissions/bash.test.ts`
- `runtime/src/tools/BashTool/bashPermissions.test.ts`
- `runtime/src/tools/tool-rendering-bash.test.tsx`

Intentional reductions:
- The primary visible terminal surface remains `exec_command` plus `write_stdin`. The dual-mode `system.bash` runner is present but deferred to avoid duplicate visible shell tools.
- AgenC does not carry product-branded shell UI labels from the reference implementations.
- TL-01's formal checklist dependency is C-01c for process hardening. The execution-policy behavior named in the TL-01 row is already present on main through completed C-01d and PE-* surfaces, so this item completes registry/catalog evidence without adding a second policy engine.
