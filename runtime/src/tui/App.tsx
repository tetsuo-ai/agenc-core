/**
 * AgenC TUI root React component.
 *
 * T12 closure: this module replaces the placeholder `[transcript]` /
 * `[composer]` slots with the real, production-wired composition:
 *
 *     <AgenCAppStateProvider>
 *       <KeybindingProvider bindings={...}>
 *         <OverlayProvider>
 *           <TUIRoot />
 *         </OverlayProvider>
 *       </KeybindingProvider>
 *     </AgenCAppStateProvider>
 *
 * `TUIRoot` itself now mounts:
 *   - <Banner> — cockpit status row (mode/model/phase/plan/streaming).
 *   - <MessageList> — transcript derived from `useQuery`'s PhaseEvent
 *     stream through the `eventsToMessages` adapter.
 *   - <Composer> — multi-line prompt input; submit calls
 *     `session.submit?.(...)` when available, cancel calls
 *     `session.abortTerminal?.('user_cancel')`.
 *   - One <InteractiveHandler> per live pending permission request —
 *     these are invisible orchestrators; the visible overlay is
 *     pushed onto the overlay stack from inside the handler.
 *   - The overlay stack itself, rendered after the main column so
 *     modals (approval dialog, etc.) layer on top in document order
 *     (Ink has no true absolute positioning).
 *
 * The real `KeybindingProvider` ships in
 * `runtime/src/tui/keybindings/KeybindingContext.tsx`; the passthrough
 * stub that used to live in `state/AppState.tsx` is retained only as a
 * deprecated alias for legacy imports.
 */

import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import Box from "./ink/components/Box.js";
import { AlternateScreen } from "./ink/components/AlternateScreen.js";
import StdinContext from "./ink/components/StdinContext.js";

import {
  AgenCAppStateProvider,
  useAgenCAppState,
  type ConfigStoreLike,
  type SessionLike as AppStateSessionLike,
} from "./state/AppState.js";
import {
  KeybindingProvider,
  useKeybinding,
} from "./keybindings/KeybindingContext.js";
import type {
  BindingContext,
  BindingMap,
} from "./keybindings/defaultBindings.js";
import { OverlayProvider, useOverlayStack } from "./overlay/OverlayProvider.js";
import {
  ModelSelectionOverlay,
  type ModelSelectionItem,
} from "./overlay/ModelSelectionOverlay.js";
import { Banner } from "./cockpit/Banner.js";
import {
  StatusLineConfig,
  type SessionLike as StatusLineSessionLike,
} from "./cockpit/StatusLineConfig.js";
import { MessageList } from "./transcript/MessageList.js";
import { Composer, type ComposerSession } from "./composer/Composer.js";
import {
  getConfigActionPaletteItems,
  getConfigProfilePaletteItems,
  getExitWorktreePaletteItems,
  getModelPaletteItems,
  getPermissionModePaletteItems,
  getPermissionsActionPaletteItems,
  getProviderPaletteItems,
} from "./composer/palette-sources.js";
import {
  InteractiveHandler,
  type InteractivePermissionRequest,
  type InteractiveResolver,
  type OverlayContextLike,
} from "./permissions/InteractiveHandler.js";
import { useQuery, type SessionLike as QuerySessionLike } from "./hooks/useQuery.js";
import { eventsToMessages } from "./state/events-to-messages.js";
import { isPlanActive, type PlanEvent } from "./state/plan-state.js";
import {
  readPickerCommandIntent,
  type PickerCommandIntent,
} from "./picker-intents.js";
import type { PendingPermissionRequest } from "../permissions/context.js";
import {
  getNextPermissionMode,
  transitionPermissionMode,
  type BypassConsentRequiredError,
} from "../permissions/mode.js";
import type { ToolPermissionContext } from "../permissions/types.js";

// ────────────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────────────

/**
 * Structural type for the `<App>` `session` prop.
 *
 * The three nested consumers (`useQuery`, `InteractiveHandler`,
 * `AgenCAppStateProvider`) each declare their own `SessionLike` with
 * slightly different required/optional shapes for `activeTurn`. The
 * widened `AppStateSessionLike` from `state/AppState.tsx` already
 * declares every hook-only field as optional, which matches
 * `InteractiveHandler`'s expectations and is structurally compatible
 * with `useQuery` as long as the runtime actually wires those fields
 * (the real Session class does; test stubs forward what they need).
 *
 * Rather than force every test stub to declare a non-null `activeTurn`
 * and a required `abortTerminal`, App.tsx narrow-casts to the
 * stricter `useQuery` shape at its single use site. `AppSessionLike`
 * stays the widened alias so consumers like `main.tsx`'s
 * `StdinLossSession` keep passing verbatim.
 */
export type AppSessionLike = AppStateSessionLike;

export interface AppProps {
  readonly session: AppSessionLike;
  readonly configStore: ConfigStoreLike;
  /** Optional binding overrides. Forwarded to the real KeybindingProvider. */
  readonly bindings?: Record<BindingContext, BindingMap>;
  /** Model label shown in the cockpit banner. */
  readonly model?: string;
  /** Optional boot-time prompt forwarded from the CLI TTY router. */
  readonly initialPrompt?: string;
}

// ────────────────────────────────────────────────────────────────────────
// Adapters — wrap the structural `PendingPermissionRequest` in the
// `InteractiveResolver` contract that `<InteractiveHandler>` consumes.
// ────────────────────────────────────────────────────────────────────────

/**
 * Shape we expect on a `PendingPermissionRequest` once the evaluator is
 * wired. The evaluator attaches a `resolveOnce` slot so the TUI can
 * deliver the user's decision back to the awaiter. The shape is checked
 * at runtime because T11's frozen `PendingPermissionRequest` interface
 * does not yet declare the slot.
 */
interface EvaluatorLinkedRequest extends PendingPermissionRequest {
  readonly resolveOnce?: InteractiveResolver;
}

/**
 * Runtime gate for approval requests. Requests without a live
 * `resolveOnce` slot must not render a dead overlay: there is nobody to
 * receive the user's decision, so the safest behavior is to drop the
 * request + emit a warning.
 */
function hasInteractiveResolver(
  request: EvaluatorLinkedRequest,
): request is PendingPermissionRequest & { readonly resolveOnce: InteractiveResolver } {
  return (
    request.resolveOnce !== undefined &&
    typeof request.resolveOnce.claim === "function" &&
    typeof request.resolveOnce.isResolved === "function"
  );
}

function emitSessionWarning(
  session: AppSessionLike,
  cause: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  const nextInternalSubId =
    typeof session.nextInternalSubId === "function"
      ? session.nextInternalSubId.bind(session)
      : null;
  if (typeof session.emit !== "function" || nextInternalSubId === null) {
    session.emit?.({
      kind: `warning:${cause}`,
      cause,
      message,
      ...extra,
    });
    return;
  }
  session.emit({
    id: nextInternalSubId(),
    msg: {
      type: "warning",
      payload: {
        cause,
        message,
        ...extra,
      },
    },
  });
}

function readStatusLineItems(
  configStore: ConfigStoreLike,
): readonly string[] | undefined {
  const snapshot = configStore.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const statusLine = (
    snapshot as {
      readonly statusLine?: { readonly items?: unknown };
    }
  ).statusLine;
  if (!Array.isArray(statusLine?.items)) {
    return undefined;
  }
  const items = statusLine.items.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return items.length > 0 ? items : undefined;
}

function readInitialTokenTotal(session: AppSessionLike): number | undefined {
  const state = (
    session as {
      readonly state?: { unsafePeek?: () => unknown };
    }
  ).state;
  if (typeof state?.unsafePeek !== "function") {
    return undefined;
  }
  try {
    const snapshot = state.unsafePeek() as {
      readonly initialTokenUsage?: { readonly totalTokens?: unknown };
    } | null;
    return typeof snapshot?.initialTokenUsage?.totalTokens === "number"
      ? snapshot.initialTokenUsage.totalTokens
      : undefined;
  } catch {
    return undefined;
  }
}

function buildStatusLineSession(
  session: AppSessionLike,
  mode: string,
  model: string | undefined,
): StatusLineSessionLike {
  const raw = session as {
    readonly conversationId?: unknown;
    readonly model?: unknown;
  };
  return {
    model:
      model ??
      (typeof raw.model === "string" && raw.model.length > 0 ? raw.model : undefined),
    mode,
    sessionId:
      typeof raw.conversationId === "string" && raw.conversationId.length > 0
        ? raw.conversationId
        : undefined,
    tokensUsed: readInitialTokenTotal(session),
  };
}

function normalizePickerProvider(provider: string | undefined): string {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return "xai";
  return normalized === "grok" ? "xai" : normalized;
}

function formatPickerProviderLabel(provider: string): string {
  switch (provider) {
    case "xai":
      return "xAI";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Google Gemini";
    case "openrouter":
      return "OpenRouter";
    case "groq":
      return "Groq";
    case "deepseek":
      return "DeepSeek";
    case "ollama":
      return "Ollama";
    case "lmstudio":
      return "LM Studio";
    default:
      return provider;
  }
}

function toHandlerRequest(
  request: PendingPermissionRequest & {
    readonly resolveOnce: InteractiveResolver;
  },
): InteractivePermissionRequest {
  return {
    requestId: request.requestId,
    toolName: request.toolName,
    toolInput: request.toolInput,
    turnId: request.turnId,
    message: request.message,
    resolveOnce: request.resolveOnce,
  };
}

function hasPermissionModeRegistryUpdate(
  registry: AppStateSessionLike["services"]["permissionModeRegistry"],
): registry is AppStateSessionLike["services"]["permissionModeRegistry"] & {
  update(next: ToolPermissionContext): Promise<void> | void;
} {
  return typeof (registry as { readonly update?: unknown }).update === "function";
}

function isBypassConsentRequiredError(
  value: unknown,
): value is BypassConsentRequiredError {
  return (
    value !== null &&
    typeof value === "object" &&
    "error" in value &&
    (value as { readonly error?: unknown }).error === "bypass_consent_required"
  );
}

// ────────────────────────────────────────────────────────────────────────
// TUIRoot — the real composition
// ────────────────────────────────────────────────────────────────────────

function TUIRoot({
  model,
  initialPrompt,
}: {
  readonly model?: string;
  readonly initialPrompt?: string;
}): React.ReactElement {
  const { mode, session, configStore, pendingRequests, permissionQueueOps } =
    useAgenCAppState();
  // The AppState-side `SessionLike` is intentionally permissive (every
  // hook-only field is optional) so tests can pass a tiny stub. useQuery
  // wants `activeTurn` and `abortTerminal` as required fields; we cast
  // here because the runtime contract (either the real Session or a
  // test stub that implements useQuery's surface) is responsible for
  // providing them. When they're missing, useQuery's internal
  // `warnOnce` path no-ops gracefully.
  const { events, isStreaming, submit } = useQuery(
    session as unknown as QuerySessionLike,
  );
  const initialPromptSubmittedRef = useRef(false);
  const overlay = useOverlayStack();

  // Derive transcript messages from phase events on every render. The
  // adapter is pure and cheap, so useMemo's only job here is to keep
  // referential identity stable for MessageList's sticky-scroll
  // bookkeeping.
  const messages = useMemo(() => eventsToMessages(events), [events]);

  // Plan events ride the event-log transcript stream rather than the
  // PhaseEvent-only path. Filter them out here so the banner can light up
  // plan mode while MessageList renders the dedicated PlanProgress row.
  const planEvents = useMemo<readonly PlanEvent[]>(() => {
    const out: PlanEvent[] = [];
    for (const ev of events as readonly { readonly type?: unknown }[]) {
      const type = (ev as { readonly type?: unknown }).type;
      if (typeof type !== "string" || !type.startsWith("plan_")) continue;
      // Translate event-log style `{type, payload}` rows into the
      // PlanEvent-side `{kind, ...}` shape. Missing payloads leave the
      // event on the cutting-room floor.
      const payload = (ev as { readonly payload?: unknown }).payload;
      if (payload && typeof payload === "object") {
        out.push({ kind: type, ...(payload as object) } as PlanEvent);
      }
    }
    return out;
  }, [events]);
  const hasPlanActive = isPlanActive(planEvents);
  const statusLineItems = useMemo<readonly string[] | undefined>(
    () => readStatusLineItems(configStore),
    [configStore],
  );

  // Overlay context adapter. `InteractiveHandler` wants a minimal
  // `push(node) => dispose` surface; the OverlayProvider exposes
  // `pushOverlay(node) => id` + `popOverlay(id)`. Wrapping once here
  // keeps the contract narrow for the handler.
  const overlayAdapter = useMemo<OverlayContextLike>(
    () => ({
      push: (node: ReactNode) => {
        const id = overlay.pushOverlay(node);
        return () => overlay.popOverlay(id);
      },
    }),
    [overlay],
  );

  // Build the Composer session adapter from whatever the caller passed.
  // Composer needs `cwd` + optional `home`; the wider Session shape
  // provides both when they're set. We fall back to `process.cwd()` so
  // mention validation has something deterministic to work with.
  const composerSession = useMemo<ComposerSession>(
    () => ({
      cwd:
        typeof session.cwd === "string" && session.cwd.length > 0
          ? session.cwd
          : process.cwd(),
      home:
        typeof (session as { readonly home?: unknown }).home === "string"
          ? ((session as { readonly home?: string }).home as string)
          : undefined,
    }),
    [session],
  );
  const statusLineSession = useMemo<StatusLineSessionLike>(
    () => buildStatusLineSession(session, mode, model),
    [mode, model, session],
  );
  const handleCycleMode = useCallback((): void => {
    const registry = session.services.permissionModeRegistry;
    if (!hasPermissionModeRegistryUpdate(registry)) {
      return;
    }
    const current = registry.current() as ToolPermissionContext;
    const nextMode = getNextPermissionMode(current.mode, current);
    let transitioned: ToolPermissionContext | BypassConsentRequiredError;
    try {
      transitioned = transitionPermissionMode(current.mode, nextMode, current, {
        requireBypassConsent: true,
        workspacePath: composerSession.cwd,
      });
    } catch (error) {
      emitSessionWarning(
        session,
        "permission_mode_cycle_failed",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    if (isBypassConsentRequiredError(transitioned)) {
      emitSessionWarning(
        session,
        "bypass_consent_required",
        "Switching to bypassPermissions requires explicit consent. Run /permissions accept-bypass to confirm this workspace will use bypassPermissions mode.",
        {
          workspacePath:
            transitioned.workspacePath ?? composerSession.cwd,
        },
      );
      return;
    }
    void Promise.resolve(registry.update({ ...transitioned, mode: nextMode })).catch(
      (error: unknown) => {
        emitSessionWarning(
          session,
          "permission_mode_cycle_failed",
          error instanceof Error ? error.message : String(error),
        );
      },
    );
  }, [composerSession.cwd, session]);
  useKeybinding("chat:cycleMode", handleCycleMode, "chat");

  const validPendingRequests = useMemo(
    () => pendingRequests.filter(hasInteractiveResolver),
    [pendingRequests],
  );

  const openPickerIntent = useCallback((intent: PickerCommandIntent): void => {
    const config = configStore.current?.();
    const currentProvider = normalizePickerProvider(
      session.sessionConfiguration?.provider?.slug,
    );

    let overlayId = "";
    const closeOverlay = (): void => {
      if (overlayId.length > 0) {
        overlay.popOverlay(overlayId);
      }
    };

    const submitSlashSelection = (command: string): void => {
      closeOverlay();
      void submit(command).catch(() => {
        // Slash-command failures surface through the normal session event path.
      });
    };

    if (intent.kind === "model") {
      const items = getModelPaletteItems({
        provider: currentProvider,
        config,
      }).map<ModelSelectionItem>((item) => ({
        id: item.id,
        label: item.label,
        description: item.description,
        value: item.value,
      }));

      overlayId = overlay.pushOverlay(
        <ModelSelectionOverlay
          title="Select Model"
          subtitle={`Choose a model for ${formatPickerProviderLabel(currentProvider)}.`}
          items={items}
          onSelect={(item) => submitSlashSelection(`/model ${item.label}`)}
          onClose={closeOverlay}
        />,
      );
      return;
    }

    if (intent.kind === "model-provider") {
      const providerItems = getProviderPaletteItems().map<ModelSelectionItem>(
        (item) => ({
          id: item.id,
          label: item.label,
          description: item.description,
          value: item.value,
        }),
      );

      const ProviderStepper = (): React.ReactElement => {
        const [selectedProvider, setSelectedProvider] = useState(currentProvider);
        const [tab, setTab] = useState<"Provider" | "Model">("Provider");

        const providerModels = useMemo(() => {
          const defaults: ModelSelectionItem[] = [
            {
              id: `${selectedProvider}:default`,
              label: "Default recommended",
              description: `Use ${formatPickerProviderLabel(selectedProvider)} default model`,
            },
          ];
          return defaults.concat(
            getModelPaletteItems({
              provider: selectedProvider,
              config,
            }).map((item) => ({
              id: item.id,
              label: item.label,
              description: item.description,
              value: item.value,
            })),
          );
        }, [config, selectedProvider]);

        if (tab === "Provider") {
          return (
            <ModelSelectionOverlay
              title="Select Model Provider"
              subtitle="Choose a provider, then pick a model for it."
              tabs={["Provider", "Model"]}
              activeTab="Provider"
              onTabChange={(nextTab) => {
                if (nextTab === "Model") {
                  setTab("Model");
                }
              }}
              items={providerItems}
              onSelect={(item) => {
                setSelectedProvider(item.id);
                setTab("Model");
              }}
              onClose={closeOverlay}
            />
          );
        }

        return (
          <ModelSelectionOverlay
            title="Select Model Provider"
            subtitle={`Choose a model for ${formatPickerProviderLabel(selectedProvider)}.`}
            tabs={["Provider", "Model"]}
            activeTab="Model"
            onTabChange={(nextTab) => {
              if (nextTab === "Provider") {
                setTab("Provider");
              }
            }}
            items={providerModels}
            onSelect={(item) => {
              const command =
                item.id === `${selectedProvider}:default`
                  ? `/model-provider ${selectedProvider}`
                  : `/model-provider ${selectedProvider} ${item.label}`;
              submitSlashSelection(command);
            }}
            onClose={closeOverlay}
            onBack={() => setTab("Provider")}
          />
        );
      };

      overlayId = overlay.pushOverlay(<ProviderStepper />);
      return;
    }

    if (intent.kind === "permissions") {
      const modeItems = getPermissionModePaletteItems().map<ModelSelectionItem>(
        (item) => ({
          id: item.id,
          label: item.label,
          description: item.description,
          value: item.value,
        }),
      );

      if (intent.stage === "mode") {
        overlayId = overlay.pushOverlay(
          <ModelSelectionOverlay
            title="Permission Mode"
            subtitle="Choose the approval mode for this session."
            items={modeItems}
            onSelect={(item) =>
              submitSlashSelection(`/permissions mode ${item.label}`)}
            onClose={closeOverlay}
          />,
        );
        return;
      }

      const actionItems = getPermissionsActionPaletteItems().map<ModelSelectionItem>(
        (item) => ({
          id: item.id,
          label: item.label,
          description: item.description,
          value: item.value,
        }),
      );

      const PermissionsStepper = (): React.ReactElement => {
        const [tab, setTab] = useState<"Action" | "Mode">("Action");

        if (tab === "Action") {
          return (
            <ModelSelectionOverlay
              title="Permissions"
              subtitle="Inspect permissions, export rules, or change the approval mode."
              tabs={["Action", "Mode"]}
              activeTab="Action"
              onTabChange={(nextTab) => {
                if (nextTab === "Mode") {
                  setTab("Mode");
                }
              }}
              items={actionItems}
              onSelect={(item) => {
                if (item.id === "permissions:mode") {
                  setTab("Mode");
                  return;
                }
                submitSlashSelection(`/permissions ${item.value ?? item.label}`);
              }}
              onClose={closeOverlay}
            />
          );
        }

        return (
          <ModelSelectionOverlay
            title="Permissions"
            subtitle="Choose the approval mode for this session."
            tabs={["Action", "Mode"]}
            activeTab="Mode"
            onTabChange={(nextTab) => {
              if (nextTab === "Action") {
                setTab("Action");
              }
            }}
            items={modeItems}
            onSelect={(item) =>
              submitSlashSelection(`/permissions mode ${item.label}`)}
            onClose={closeOverlay}
            onBack={() => setTab("Action")}
          />
        );
      };

      overlayId = overlay.pushOverlay(<PermissionsStepper />);
      return;
    }

    if (intent.kind === "config") {
      const rootItems = getConfigActionPaletteItems().map<ModelSelectionItem>(
        (item) => ({
          id: item.id,
          label: item.label,
          description: item.description,
          value: item.value,
        }),
      );
      const profileItems = [
        {
          id: "config:profile:show",
          label: "Show active profile",
          description: "Display the current active profile and available profiles",
          value: "profile",
        },
        ...getConfigProfilePaletteItems(config).map<ModelSelectionItem>((item) => ({
          id: item.id,
          label: item.label,
          description: item.description,
          value: item.value,
        })),
      ];

      if (intent.stage === "profile") {
        overlayId = overlay.pushOverlay(
          <ModelSelectionOverlay
            title="Config Profile"
            subtitle="Choose a declared config profile for the next turn."
            items={profileItems}
            onSelect={(item) => {
              const command =
                item.id === "config:profile:show"
                  ? "/config profile"
                  : `/config profile ${item.label}`;
              submitSlashSelection(command);
            }}
            onClose={closeOverlay}
          />,
        );
        return;
      }

      const ConfigStepper = (): React.ReactElement => {
        const [tab, setTab] = useState<"Action" | "Profile">("Action");

        if (tab === "Action") {
          return (
            <ModelSelectionOverlay
              title="Config"
              subtitle="Inspect runtime config, reload it, or switch profiles."
              tabs={["Action", "Profile"]}
              activeTab="Action"
              onTabChange={(nextTab) => {
                if (nextTab === "Profile") {
                  setTab("Profile");
                }
              }}
              items={rootItems}
              onSelect={(item) => {
                if (item.id === "config:profile") {
                  setTab("Profile");
                  return;
                }
                submitSlashSelection(`/config ${item.value ?? item.label}`);
              }}
              onClose={closeOverlay}
            />
          );
        }

        return (
          <ModelSelectionOverlay
            title="Config"
            subtitle="Choose a declared config profile for the next turn."
            tabs={["Action", "Profile"]}
            activeTab="Profile"
            onTabChange={(nextTab) => {
              if (nextTab === "Action") {
                setTab("Action");
              }
            }}
            items={profileItems}
            onSelect={(item) => {
              const command =
                item.id === "config:profile:show"
                  ? "/config profile"
                  : `/config profile ${item.label}`;
              submitSlashSelection(command);
            }}
            onClose={closeOverlay}
            onBack={() => setTab("Action")}
          />
        );
      };

      overlayId = overlay.pushOverlay(<ConfigStepper />);
      return;
    }

    if (intent.kind === "exit-worktree") {
      const items = getExitWorktreePaletteItems().map<ModelSelectionItem>(
        (item) => ({
          id: item.id,
          label: item.label,
          description: item.description,
          value: item.value,
        }),
      );
      overlayId = overlay.pushOverlay(
        <ModelSelectionOverlay
          title="Exit Worktree"
          subtitle="Choose how to leave the current worktree."
          items={items}
          onSelect={(item) =>
            submitSlashSelection(`/exit-worktree ${item.value ?? item.label}`)}
          onClose={closeOverlay}
        />,
      );
      return;
    }
  }, [configStore, overlay, session.sessionConfiguration?.provider?.slug, submit]);

  useEffect(() => {
    for (const request of pendingRequests) {
      if (hasInteractiveResolver(request as EvaluatorLinkedRequest)) continue;
      permissionQueueOps.remove(request.requestId);
      emitSessionWarning(
        session,
        "approval_resolver_missing",
        `dropped approval request ${request.requestId} because no live resolver was attached`,
        {
          requestId: request.requestId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
      );
    }
  }, [pendingRequests, permissionQueueOps, session]);

  // Mount one InteractiveHandler per pending request. Each handler
  // owns its own lifecycle (grace race → overlay push → resolve), so
  // a render pass with N pending items gives us N orchestrators.
  const permissionHandlers = validPendingRequests.map((req) => (
    <InteractiveHandler
      key={req.requestId}
      request={toHandlerRequest(req)}
      session={session}
      overlayContext={overlayAdapter}
    />
  ));

  const handleSubmit = (text: string): void => {
    const pickerIntent = readPickerCommandIntent(text);
    if (pickerIntent) {
      openPickerIntent(pickerIntent);
      return;
    }
    // `useQuery.submit` is a terminal-safe wrapper that logs if the
    // underlying session doesn't expose a submit hook; dropped input
    // is an observability signal, not a crash.
    void submit(text).catch(() => {
      // Submit failures surface through the session emit channel in
      // real runs; swallow here so a rejected promise doesn't become
      // an unhandled promise rejection in the Ink scheduler.
    });
  };

  const handleCancel = (): void => {
    try {
      session.abortTerminal?.("user_cancel");
    } catch {
      // abortTerminal is best-effort; the composer already cleared
      // its local buffer before calling us.
    }
  };

  useEffect(() => {
    if (initialPromptSubmittedRef.current) return;
    if (typeof initialPrompt !== "string" || initialPrompt.length === 0) {
      return;
    }
    initialPromptSubmittedRef.current = true;
    void submit(initialPrompt).catch(() => {
      // Submit failures already surface through session-side logging.
    });
  }, [initialPrompt, submit]);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      height="100%"
      width="100%"
    >
      {/* cockpit region (top) */}
      <Box flexDirection="column" flexShrink={0}>
        <Banner
          mode={mode}
          model={statusLineSession.model}
          runId={statusLineSession.sessionId}
          isStreaming={isStreaming}
          hasPlanActive={hasPlanActive}
        />
        {statusLineItems !== undefined ? (
          <StatusLineConfig
            items={statusLineItems}
            session={statusLineSession}
            configStore={configStore}
            cwd={composerSession.cwd}
          />
        ) : null}
      </Box>

      {/* transcript region (middle, flex:1) */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
        <MessageList messages={messages} isStreaming={isStreaming} />
      </Box>

      {/* composer region (bottom) */}
      <Box flexDirection="column" flexShrink={0}>
        <Composer
          session={composerSession}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
      </Box>

      {/* invisible orchestrators — one per pending permission request */}
      {permissionHandlers}

      {/* overlay stack rendered after the main column so modals appear
          last in document order (Ink has no absolute positioning) */}
      {overlay.overlays.map((entry) => (
        <OverlayFrame key={entry.id}>{entry.node}</OverlayFrame>
      ))}
    </Box>
  );
}

function OverlayFrame({ children }: { readonly children: ReactNode }) {
  return <Box flexDirection="column">{children}</Box>;
}

// ────────────────────────────────────────────────────────────────────────
// App provider stack
// ────────────────────────────────────────────────────────────────────────

/**
 * Tiny adapter component: reads Ink's `StdinContext` (provided by the
 * Ink root) and forwards its `internal_eventEmitter` to the AgenC
 * `KeybindingProvider` so keypresses flow into the binding registry in
 * production. When the Ink root isn't present (default context value),
 * the default context's `internal_eventEmitter` is still a valid
 * `EventEmitter` — it just never emits — so the provider safely
 * no-ops until a real Ink root mounts above.
 */
function KeybindingsFromStdin({
  bindings,
  children,
}: {
  readonly bindings?: Record<BindingContext, BindingMap>;
  readonly children: ReactNode;
}): React.ReactElement {
  const stdinCtx = useContext(StdinContext);
  const emitter = stdinCtx.internal_eventEmitter;
  return (
    <KeybindingProvider
      {...(bindings ? { bindings } : {})}
      stdinContext={{ internal_eventEmitter: emitter }}
    >
      {children}
    </KeybindingProvider>
  );
}

export const App: React.FC<AppProps> = ({
  session,
  configStore,
  bindings,
  model,
  initialPrompt,
}) => {
  return (
    <AlternateScreen>
      <AgenCAppStateProvider session={session} configStore={configStore}>
        <KeybindingsFromStdin {...(bindings ? { bindings } : {})}>
          <OverlayProvider>
            <TUIRoot model={model} initialPrompt={initialPrompt} />
          </OverlayProvider>
        </KeybindingsFromStdin>
      </AgenCAppStateProvider>
    </AlternateScreen>
  );
};

export default App;

// Re-exported so tests can mount the live root composition directly.
export { TUIRoot };
export { readPickerCommandIntent };

/**
 * The remaining evaluator-side work is limited to producing queued
 * requests with a live `resolveOnce: InteractiveResolver`. The TUI now
 * consumes those requests directly, rejects resolver-less entries
 * safely, and routes `plan_*` entries from `session.eventLog` through
 * the dedicated transcript renderer via `useQuery`.
 */
