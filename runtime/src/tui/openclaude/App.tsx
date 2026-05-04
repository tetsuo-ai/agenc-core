import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { App as UpstreamApp } from "../../agenc/upstream/components/App.js";
import { Messages } from "../components/Messages.js";
import PromptInput from "../components/PromptInput/PromptInput.js";
import { PromptOverlayProvider } from "../context/promptOverlayContext.js";
import { KeybindingSetup } from "../keybindings/KeybindingProviderSetup.js";
import {
  getDefaultAppState,
  useAppState,
  useSetAppState,
} from "../state/AppState.js";
import {
  Box,
  useApp,
  useTerminalFocus,
  useTerminalTitle,
} from "../ink.js";
import type { LLMMessage } from "../../llm/types.js";
import type { ToolPermissionContext } from "../../permissions/types.js";
import { createBridgeTools } from "./tool-stubs.js";
import { useSessionTranscript } from "./use-session-transcript.js";
import { useToolJSX } from "./use-tool-jsx.js";
import {
  AgenCPermissionOverlay as PermissionOverlay,
  buildToolUseConfirmQueue,
  usePermissionBridge,
} from "./permission-bridge.js";
import {
  ElicitationOverlay,
  useElicitationBridge,
} from "../elicitation-bridge.js";
import { submitViaElicitationBridge } from "../elicitation-submit-routing.js";
import { loadUpstreamCommandList } from "../../agenc/adapters/upstream-commands.js";
import { loadUpstreamAgentList } from "../../agenc/adapters/upstream-agent-list.js";
import { buildPendingProviderSwitch } from "../../agenc/adapters/upstream-model-switch.js";
import { pastedContentsToLLMMessage } from "../../agenc/adapters/upstream-attachments.js";
import type { Command } from "../../agenc/upstream/commands.js";
import type { AgentDefinition } from "../../agenc/upstream/tools/AgentTool/loadAgentsDir.js";
import type { AgenCTuiProps } from "../session-types.js";

function initialPermissionContext(
  props: AgenCTuiProps,
): ToolPermissionContext {
  return props.session.services.permissionModeRegistry.current();
}

function startupModel(props: AgenCTuiProps): string | null {
  return (
    props.model ??
    props.session.sessionConfiguration?.collaborationMode?.model ??
    null
  );
}

function initialState(props: AgenCTuiProps): any {
  return {
    ...getDefaultAppState(),
    mainLoopModel: startupModel(props),
    mainLoopModelForSession: startupModel(props),
    toolPermissionContext: initialPermissionContext(props),
  };
}

function useSyncedPermissionContext(session: AgenCTuiProps["session"]) {
  const toolPermissionContext = useAppState((s) => s.toolPermissionContext);
  const setAppState = useSetAppState();
  useEffect(() => {
    return session.services.permissionModeRegistry.subscribeToModeChange?.(() => {
      const next = session.services.permissionModeRegistry.current();
      setAppState((prev) => ({
        ...prev,
        toolPermissionContext: next,
      }));
    });
  }, [session, setAppState]);

  const setToolPermissionContext = useCallback(
    (next: ToolPermissionContext) => {
      setAppState((prev) => ({
        ...prev,
        toolPermissionContext: next,
      }));
      void Promise.resolve(
        session.services.permissionModeRegistry.update?.(next),
      ).catch(() => {});
    },
    [session, setAppState],
  );

  return [toolPermissionContext, setToolPermissionContext] as const;
}

function useInitialSubmit(
  session: AgenCTuiProps["session"],
  submit: (input: string) => Promise<void>,
  initialPrompt: string | undefined,
  initialUserMessages: readonly LLMMessage[] | undefined,
): void {
  const submitted = useRef(false);
  useEffect(() => {
    if (submitted.current) return;
    const hasPrompt = typeof initialPrompt === "string" && initialPrompt.length > 0;
    const startupMessages = initialUserMessages ?? [];
    if (!hasPrompt && startupMessages.length === 0) return;
    submitted.current = true;
    for (const message of startupMessages) {
      session.enqueueIdleInput?.(message);
    }
    if (hasPrompt) {
      void submit(initialPrompt).catch(() => {});
    } else {
      void session.submit?.("", { displayUserMessage: null }).catch(() => {});
    }
  }, [initialPrompt, initialUserMessages, session, submit]);
}

const TITLE_ANIMATION_FRAMES = ["⠂", "⠐"];
const TITLE_STATIC_PREFIX = "✳";
const TITLE_ANIMATION_INTERVAL_MS = 960;

/**
 * Ports upstream `src/ink/hooks/use-terminal-title.ts` and the terminal-title
 * leaf from `src/screens/REPL.tsx` onto the live AgenC TUI shell.
 *
 * Shape difference from upstream:
 *   - AgenC does not yet carry upstream session rename or generated-title
 *     state in this bridge, so the title is derived from the active
 *     provider/model when available and otherwise falls back to the product
 *     name.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Generated title extraction and session rename persistence; those need
 *     their own runtime state bridge before they can be live behavior.
 *   - Terminal tab status integration; this port only owns OSC title writes.
 */
function AnimatedTerminalTitle({
  isAnimating,
  title,
  disabled = false,
  noPrefix = false,
}: {
  readonly isAnimating: boolean;
  readonly title: string;
  readonly disabled?: boolean;
  readonly noPrefix?: boolean;
}): null {
  const terminalFocused = useTerminalFocus();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (disabled || noPrefix || !isAnimating || !terminalFocused) return;
    const interval = setInterval(() => {
      setFrame((current) => (current + 1) % TITLE_ANIMATION_FRAMES.length);
    }, TITLE_ANIMATION_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [disabled, isAnimating, noPrefix, terminalFocused]);

  const prefix = isAnimating
    ? TITLE_ANIMATION_FRAMES[frame] ?? TITLE_STATIC_PREFIX
    : TITLE_STATIC_PREFIX;
  useTerminalTitle(disabled ? null : noPrefix ? title : `${prefix} ${title}`);
  return null;
}

function terminalTitle(props: Parameters<typeof startupModel>[0]): string {
  const provider = props.session.sessionConfiguration?.provider?.slug?.trim();
  const model = startupModel(props)?.trim();
  if (provider && model) return `AgenC ${provider}/${model}`;
  if (model) return `AgenC ${model}`;
  return "AgenC";
}

function AgenCTuiShell(props: AgenCTuiProps): React.ReactElement {
  const { exit } = useApp();
  const [input, setInput] = useState(props.initialComposerText ?? "");
  const [mode, setMode] = useState<any>("prompt");
  const [stashedPrompt, setStashedPrompt] = useState<any>(undefined);
  const [submitCount, setSubmitCount] = useState(0);
  const [pastedContents, setPastedContents] = useState<Record<number, any>>({});
  const [vimMode, setVimMode] = useState<any>("insert");
  const [showBashesDialog, setShowBashesDialog] = useState<string | boolean>(false);
  const [isSearchingHistory, setIsSearchingHistory] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const setAppState = useSetAppState();
  const [toolPermissionContext, setToolPermissionContext] =
    useSyncedPermissionContext(props.session);
  const transcript = useSessionTranscript(
    props.session,
    props.initialUserMessages ?? [],
  );
  const [toolJSX, setToolJSX] = useToolJSX();
  const setModel = useCallback(
    (next: string) => {
      setAppState((prev) => ({
        ...prev,
        mainLoopModel: next,
        mainLoopModelForSession: next,
      }));
      const switchSpec = buildPendingProviderSwitch(props.session, next);
      if (switchSpec !== null) {
        props.session.setPendingProviderSwitch?.(switchSpec);
      }
    },
    [setAppState, props.session],
  );
  const setExpandedView = useCallback(
    (next: "none" | "tasks") => {
      setAppState((prev) => ({
        ...prev,
        expandedView: next,
      }));
    },
    [setAppState],
  );
  const permissionRequests = usePermissionBridge(
    props.session,
    setModel,
    setExpandedView,
  );
  const elicitation = useElicitationBridge(props.session);
  const toolNames = useMemo(() => {
    const names = new Set(transcript.toolNames);
    const firstPermission = permissionRequests[0];
    if (firstPermission) names.add(firstPermission.ctx.toolName);
    return names;
  }, [permissionRequests, transcript.toolNames]);
  const tools = useMemo(() => createBridgeTools(toolNames), [toolNames]);

  const submit = useCallback(
    async (value: string) => {
      const text = value.trim();
      const hasAttachments = Object.keys(pastedContents).length > 0;
      if (text.length === 0 && !hasAttachments) return;
      setSubmitCount((count) => count + 1);
      setInput("");
      if (hasAttachments) {
        const attachmentsMessage = pastedContentsToLLMMessage(pastedContents);
        if (attachmentsMessage !== null) {
          props.session.enqueueIdleInput?.(attachmentsMessage);
        }
      }
      setPastedContents({});
      await props.session.submit?.(value);
    },
    [pastedContents, props.session],
  );
  useInitialSubmit(
    props.session,
    submit,
    props.initialPrompt,
    props.initialUserMessages,
  );

  const getToolUseContext = useCallback(
    () =>
      ({
        abortController:
          props.session.abortController ?? new AbortController(),
        getToolPermissionContext: async () => toolPermissionContext,
        options: {},
        tools,
        setToolJSX,
      }) as any,
    [props.session.abortController, toolPermissionContext, tools, setToolJSX],
  );

  const commands = useMemo(() => loadUpstreamCommandList(), []);
  const agents = useMemo(() => loadUpstreamAgentList(), []);
  const mcpClients = useMemo(
    () => props.session.listMcpClients?.() ?? [],
    [props.session],
  );
  const toolUseConfirmQueue = useMemo(
    () => buildToolUseConfirmQueue(permissionRequests, tools),
    [permissionRequests, tools],
  );
  const title = useMemo(() => terminalTitle(props), [props]);
  const titleIsAnimating =
    transcript.isStreaming &&
    permissionRequests.length === 0 &&
    elicitation.prompt === null &&
    toolJSX === null;

  return (
    <Box flexDirection="column" width="100%">
      <AnimatedTerminalTitle isAnimating={titleIsAnimating} title={title} />
      <Messages
        messages={transcript.messages as any[]}
        tools={tools as any}
        commands={commands as unknown as Command[]}
        verbose={false}
        toolJSX={toolJSX as any}
        toolUseConfirmQueue={toolUseConfirmQueue as never[]}
        inProgressToolUseIDs={new Set(transcript.inProgressToolUseIDs)}
        isMessageSelectorVisible={false}
        conversationId={props.session.conversationId}
        screen={"prompt" as any}
        streamingToolUses={transcript.streamingToolUses}
        isLoading={transcript.isStreaming}
        streamingText={transcript.streamingText}
        hidePastThinking={false}
      />
      {toolJSX !== null ? (
        <Box flexDirection="column" width="100%">
          {toolJSX.jsx}
        </Box>
      ) : null}
      <PermissionOverlay
        request={permissionRequests[0]}
        tools={tools}
      />
      <ElicitationOverlay prompt={elicitation.prompt} />
      <PromptInput
        debug={false}
        ideSelection={undefined}
        toolPermissionContext={toolPermissionContext as any}
        setToolPermissionContext={setToolPermissionContext as any}
        apiKeyStatus={"valid" as any}
        commands={commands as unknown as Command[]}
        agents={agents as unknown as AgentDefinition[]}
        isLoading={transcript.isStreaming}
        verbose={false}
        messages={transcript.messages as any[]}
        onAutoUpdaterResult={() => {}}
        autoUpdaterResult={null}
        input={input}
        onInputChange={setInput}
        mode={mode}
        onModeChange={setMode}
        stashedPrompt={stashedPrompt}
        setStashedPrompt={setStashedPrompt}
        submitCount={submitCount}
        onShowMessageSelector={() => {}}
        mcpClients={mcpClients as never}
        pastedContents={pastedContents}
        setPastedContents={setPastedContents}
        vimMode={vimMode}
        setVimMode={setVimMode}
        showBashesDialog={showBashesDialog}
        setShowBashesDialog={setShowBashesDialog}
        onExit={exit}
        getToolUseContext={getToolUseContext}
        onSubmit={(value, helpers) =>
          submitViaElicitationBridge(elicitation, submit, value, helpers)
        }
        isSearchingHistory={isSearchingHistory}
        setIsSearchingHistory={setIsSearchingHistory}
        helpOpen={helpOpen}
        setHelpOpen={setHelpOpen}
      />
    </Box>
  );
}

export function AgenCTuiApp(
  props: AgenCTuiProps,
): React.ReactElement {
  const initial = useMemo(() => initialState(props), []);
  return (
    <UpstreamApp
      initialState={initial}
      getFpsMetrics={() => undefined}
    >
      <PromptOverlayProvider>
        <KeybindingSetup>
          <AgenCTuiShell {...props} />
        </KeybindingSetup>
      </PromptOverlayProvider>
    </UpstreamApp>
  );
}
