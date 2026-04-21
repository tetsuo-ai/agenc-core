/**
 * Wave 5-A: ApprovalOverlay — permission-approval modal for the AgenC TUI.
 *
 * The overlay is pushed onto the overlay stack by {@link InteractiveHandler}
 * whenever the 200 ms classifier grace window falls through to "ask the
 * user". Its job is intentionally narrow:
 *
 *   1. Render a compact, brand-neutral summary of the pending tool call
 *      (header, args preview, workspace path, optional reason). Tool-specific
 *      renderers short-circuit the generic JSON preview for the common
 *      cases (Bash, write_file, edit_file).
 *   2. Own a modal KeybindingContext while mounted (I-72). Chat-level
 *      bindings are suspended so the composer cannot consume approval
 *      keys from underneath the dialog. The previous context is restored
 *      on unmount.
 *   3. Listen for the caller's AbortSignal (I-21). An abort immediately
 *      resolves with `{behavior: 'abort'}` — never with `'deny'` — so the
 *      evaluator's awaiter unsticks with the correct source. The abort
 *      listener unsubscribes on unmount to avoid leaking beyond the modal
 *      lifetime.
 *
 * The four decision paths:
 *   - Enter / 'Y'       → `{behavior: 'allow'}`
 *   - 'A'               → `{behavior: 'allow-session', addRule: true}`
 *   - 'D' / 'N' / Esc   → `{behavior: 'deny'}`
 *   - AbortSignal fire  → `{behavior: 'abort'}`
 *
 * All decisions route through `onResolve` exactly once. A latch
 * (`resolvedRef`) guards against a late key arriving after an abort has
 * already been delivered and vice versa; the parent
 * {@link InteractiveHandler} also guards via its `resolveOnce` slot, but
 * we keep the local latch so this component is defensible on its own in
 * tests that don't mount a handler.
 *
 * @module
 */

import React, { useCallback, useEffect, useRef } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import type { Color } from "../ink/styles.js";
import { theme } from "../theme.js";
import {
  useKeybinding,
  useSetKeybindingContext,
} from "../keybindings/KeybindingContext.js";

// ───────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────

export type ApprovalBehavior = "allow" | "allow-session" | "deny" | "abort";

export interface ApprovalDecision {
  readonly behavior: ApprovalBehavior;
  /** When `behavior === 'allow-session'`, whether to persist an allow rule. */
  readonly addRule?: boolean;
}

export interface ApprovalOverlayRequest {
  /** Tool name (e.g. `"Bash"` or `"system.writeFile"`). */
  readonly tool: string;
  /** Arguments passed to the tool; rendered truncated. */
  readonly args: Record<string, unknown>;
  /** Session CWD for the modal footer. */
  readonly workspacePath: string;
  /** Optional human-readable justification for the ask. */
  readonly reason?: string;
  /** I-44 turn stamp (surfaced for test assertions; not used in render). */
  readonly turnId: string;
}

export interface ApprovalOverlayProps {
  readonly request: ApprovalOverlayRequest;
  readonly onResolve: (decision: ApprovalDecision) => void;
  readonly abortSignal: AbortSignal;
}

// ───────────────────────────────────────────────────────────────────────
// Rendering helpers — kept pure so the sub-components are unit-testable
// without mounting the full overlay.
// ───────────────────────────────────────────────────────────────────────

/** Number of visible lines before `…` truncation in generic renderers. */
const MAX_PREVIEW_LINES = 10;

/** Number of lines in the args JSON preview. */
const MAX_ARGS_LINES = 4;

function truncateLines(source: string, maxLines: number): string {
  if (typeof source !== "string" || source.length === 0) return "";
  const lines = source.split("\n");
  if (lines.length <= maxLines) return source;
  return `${lines.slice(0, maxLines).join("\n")}\n…`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "<unserializable>";
  }
}

function coerceString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ───────────────────────────────────────────────────────────────────────
// Tool-specific renderers (exported for direct test coverage)
// ───────────────────────────────────────────────────────────────────────

/** `Bash` / `system.bash` request — renders the verbatim command. */
export const BashRequest: React.FC<{ args: unknown }> = ({ args }) => {
  const command =
    args && typeof args === "object"
      ? coerceString((args as Record<string, unknown>).command)
      : "";
  const preview = truncateLines(command, MAX_PREVIEW_LINES);
  return (
    <Box flexDirection="column">
      <Text dim>  command:</Text>
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text>{preview.length > 0 ? preview : "(empty)"}</Text>
      </Box>
    </Box>
  );
};

/** `write_file` / `system.writeFile` — shows path + truncated content. */
export const WriteFileRequest: React.FC<{ args: unknown }> = ({ args }) => {
  const record = (args ?? {}) as Record<string, unknown>;
  const path = coerceString(record.path);
  const content = coerceString(record.content);
  const preview = truncateLines(content, MAX_PREVIEW_LINES);
  return (
    <Box flexDirection="column">
      <Text dim>{`  path: ${path || "(none)"}`}</Text>
      <Text dim>  content:</Text>
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text>{preview.length > 0 ? preview : "(empty)"}</Text>
      </Box>
    </Box>
  );
};

/** `edit_file` / `system.editFile` — path + diff line counts. */
export const EditFileRequest: React.FC<{ args: unknown }> = ({ args }) => {
  const record = (args ?? {}) as Record<string, unknown>;
  const path = coerceString(record.path);
  const oldText = coerceString(record.oldText ?? record.old_text);
  const newText = coerceString(record.newText ?? record.new_text);
  const oldLines = oldText.length === 0 ? 0 : oldText.split("\n").length;
  const newLines = newText.length === 0 ? 0 : newText.split("\n").length;
  return (
    <Box flexDirection="column">
      <Text dim>{`  path: ${path || "(none)"}`}</Text>
      <Text dim>{`  diff: -${oldLines} / +${newLines} lines`}</Text>
    </Box>
  );
};

/** Default — generic JSON preview truncated to MAX_ARGS_LINES. */
export const GenericRequest: React.FC<{ args: unknown }> = ({ args }) => {
  const formatted = safeStringify(args ?? {});
  const preview = truncateLines(formatted, MAX_ARGS_LINES);
  return (
    <Box flexDirection="column">
      <Text dim>  args:</Text>
      <Text>{preview}</Text>
    </Box>
  );
};

/** Dispatch table: tool name → renderer. */
function renderToolBody(tool: string, args: unknown): React.ReactElement {
  switch (tool) {
    case "Bash":
    case "system.bash":
      return <BashRequest args={args} />;
    case "write_file":
    case "system.writeFile":
      return <WriteFileRequest args={args} />;
    case "edit_file":
    case "system.editFile":
      return <EditFileRequest args={args} />;
    default:
      return <GenericRequest args={args} />;
  }
}

// ───────────────────────────────────────────────────────────────────────
// ApprovalOverlay
// ───────────────────────────────────────────────────────────────────────

export const ApprovalOverlay: React.FC<ApprovalOverlayProps> = ({
  request,
  onResolve,
  abortSignal,
}) => {
  // Local single-shot latch. The caller (InteractiveHandler) also has
  // a resolveOnce slot, but keeping a component-local latch lets the
  // overlay be used in tests without an enclosing handler and still
  // guarantee `onResolve` fires at most once.
  const resolvedRef = useRef(false);

  const resolveOnce = useCallback(
    (decision: ApprovalDecision) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onResolve(decision);
    },
    [onResolve],
  );

  // ── I-72: take exclusive modal focus on mount, restore 'chat' on unmount
  const setActiveContext = useSetKeybindingContext();
  useEffect(() => {
    setActiveContext("modal");
    return () => {
      setActiveContext("chat");
    };
  }, [setActiveContext]);

  // ── I-21: abort-safe. Subscribe on mount, unsubscribe on unmount.
  useEffect(() => {
    if (!abortSignal) return;
    // If the signal is already aborted by the time we mount, resolve
    // synchronously on the next microtask so React doesn't see a state
    // update during the render phase.
    if (abortSignal.aborted) {
      queueMicrotask(() => resolveOnce({ behavior: "abort" }));
      return;
    }
    const handler = (): void => {
      resolveOnce({ behavior: "abort" });
    };
    abortSignal.addEventListener("abort", handler);
    return () => {
      abortSignal.removeEventListener("abort", handler);
    };
  }, [abortSignal, resolveOnce]);

  // ── Decision handlers wired to modal-context bindings.
  const onAllow = useCallback(() => {
    resolveOnce({ behavior: "allow" });
  }, [resolveOnce]);

  const onAllowSession = useCallback(() => {
    resolveOnce({ behavior: "allow-session", addRule: true });
  }, [resolveOnce]);

  const onDeny = useCallback(() => {
    resolveOnce({ behavior: "deny" });
  }, [resolveOnce]);

  // Enter fires the same path as 'Y'; Escape and 'N' fire the same path
  // as 'D'. We register each binding command explicitly so the provider
  // routes the correct chord.
  useKeybinding("modal:confirm", onAllow, "modal");
  useKeybinding("modal:yes", onAllow, "modal");
  useKeybinding("modal:allowSession", onAllowSession, "modal");
  useKeybinding("modal:deny", onDeny, "modal");
  useKeybinding("modal:no", onDeny, "modal");
  useKeybinding("modal:cancel", onDeny, "modal");

  const body = renderToolBody(request.tool, request.args);
  const warningColor = theme.colors.warning as Color;

  return (
    <Box
      borderStyle="double"
      padding={1}
      flexDirection="column"
      borderColor={warningColor}
    >
      <Text color={warningColor}>
        {`\u26A0 Permission needed: ${request.tool}`}
      </Text>
      {body}
      <Text dim>{`  workspace: ${request.workspacePath}`}</Text>
      {request.reason ? (
        <Text dim>{`  reason: ${request.reason}`}</Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text>[Y] Allow once  (Enter)</Text>
        <Text>[A] Allow this session</Text>
        <Text>[D] Deny  (N / Esc)</Text>
      </Box>
      <Text dim>Ctrl+C = abort</Text>
    </Box>
  );
};

export default ApprovalOverlay;
