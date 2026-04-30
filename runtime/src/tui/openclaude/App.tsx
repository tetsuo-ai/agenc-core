import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { App as UpstreamApp } from "../../agenc/upstream/components/App.js";
import { Messages } from "../../agenc/upstream/components/Messages.js";
import PromptInput from "../../agenc/upstream/components/PromptInput/PromptInput.js";
import { PromptOverlayProvider } from "../../agenc/upstream/context/promptOverlayContext.js";
import { KeybindingSetup } from "../../agenc/upstream/keybindings/KeybindingProviderSetup.js";
import {
  getDefaultAppState,
  useAppState,
  useSetAppState,
} from "../../agenc/upstream/state/AppState.js";
import { Box, useApp } from "../../agenc/upstream/ink.js";
import type { LLMMessage } from "../../llm/types.js";
import type { ToolPermissionContext } from "../../permissions/types.js";
import { createBridgeTools } from "./tool-stubs.js";
import { useSessionTranscript } from "./use-session-transcript.js";
import {
  OpenClaudePermissionOverlay,
  usePermissionBridge,
} from "./permission-bridge.js";
import { loadUpstreamCommandList } from "../../agenc/adapters/upstream-commands.js";
import { loadUpstreamAgentList } from "../../agenc/adapters/upstream-agent-list.js";
import { buildPendingProviderSwitch } from "../../agenc/adapters/upstream-model-switch.js";
import type { Command } from "../../agenc/upstream/commands.js";
import type { AgentDefinition } from "../../agenc/upstream/tools/AgentTool/loadAgentsDir.js";
import type { OpenClaudeTuiProps } from "./session-types.js";

function initialPermissionContext(
  props: OpenClaudeTuiProps,
): ToolPermissionContext {
  return props.session.services.permissionModeRegistry.current();
}

function startupModel(props: OpenClaudeTuiProps): string | null {
  return (
    props.model ??
    props.session.sessionConfiguration?.collaborationMode?.model ??
    null
  );
}

function initialState(props: OpenClaudeTuiProps): any {
  return {
    ...getDefaultAppState(),
    mainLoopModel: startupModel(props),
    mainLoopModelForSession: startupModel(props),
    toolPermissionContext: initialPermissionContext(props),
  };
}

function useSyncedPermissionContext(session: OpenClaudeTuiProps["session"]) {
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
  session: OpenClaudeTuiProps["session"],
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
    void submit(hasPrompt ? initialPrompt : "").catch(() => {});
  }, [initialPrompt, initialUserMessages, session, submit]);
}

function OpenClaudeShell(props: OpenClaudeTuiProps): React.ReactElement {
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
      }) as any,
    [props.session.abortController, toolPermissionContext, tools],
  );

  const commands = useMemo(() => loadUpstreamCommandList(), []);
  const agents = useMemo(() => loadUpstreamAgentList(), []);

  return (
    <Box flexDirection="column" width="100%">
      <Messages
        messages={transcript.messages as any[]}
        tools={tools as any}
        commands={commands as unknown as Command[]}
        verbose={false}
        toolJSX={null}
        toolUseConfirmQueue={[]}
        inProgressToolUseIDs={new Set(transcript.inProgressToolUseIDs)}
        isMessageSelectorVisible={false}
        conversationId={"agenc"}
        screen={"prompt" as any}
        streamingToolUses={[]}
        isLoading={transcript.isStreaming}
        streamingText={transcript.streamingText}
        hidePastThinking={false}
      />
      <OpenClaudePermissionOverlay
        request={permissionRequests[0]}
        tools={tools}
      />
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
        mcpClients={[]}
        pastedContents={pastedContents}
        setPastedContents={setPastedContents}
        vimMode={vimMode}
        setVimMode={setVimMode}
        showBashesDialog={showBashesDialog}
        setShowBashesDialog={setShowBashesDialog}
        onExit={exit}
        getToolUseContext={getToolUseContext}
        onSubmit={async (value, helpers) => {
          await submit(value);
          helpers.clearBuffer();
          helpers.resetHistory();
          helpers.setCursorOffset(0);
        }}
        isSearchingHistory={isSearchingHistory}
        setIsSearchingHistory={setIsSearchingHistory}
        helpOpen={helpOpen}
        setHelpOpen={setHelpOpen}
      />
    </Box>
  );
}

export function OpenClaudeTuiApp(
  props: OpenClaudeTuiProps,
): React.ReactElement {
  const initial = useMemo(() => initialState(props), []);
  return (
    <UpstreamApp
      initialState={initial}
      getFpsMetrics={() => undefined}
    >
      <PromptOverlayProvider>
        <KeybindingSetup>
          <OpenClaudeShell {...props} />
        </KeybindingSetup>
      </PromptOverlayProvider>
    </UpstreamApp>
  );
}
