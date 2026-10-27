import { resolveDeepSeekWebSearchSetting, type DeepSeekWebSearchSetting } from "../llm/providers/deepseek/web-search.js";
import { resolveWebSearchMode, type WebSearchMode } from "../tools/web-search-mode.js";
import { openRouterMenuCatalog } from "./openrouter-menu-models.js";
import { OPENROUTER_CATALOG_FALLBACK_NOTE } from "../llm/registry/openrouter-live-catalog.js";
import React from "react";
import type { ProviderSlug } from "../config/provider-model-authority.js";
import TextInput from "../tui/components/TextInput.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal, Popup } from "../tui/components/v2/primitives.js";
import { Box, useInput, type Key } from "../tui/ink.js";
import { useInputCapture } from "../tui/keybindings/useKeybinding.js";
import { clearSharedDoublePressState } from "../tui/hooks/useDoublePress.js";
import {
  providerEnvironmentFromCommandContext,
  readCommandConfig,
  requireCommandConfigStore,
} from "./config-context.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import { searchModels } from "./model-search.js";
import {
  chooseProviderAuth,
  chooseWebSearchMode,
  chooseProviderModel,
  connectProviderWithKey,
  forgetProviderKey,
  signInWithAccount,
  signOutOfAccount,
  type ProvidersHubActionResult,
} from "./providers-hub-actions.js";
import {
  isSignInProvider,
  type SignInProgress,
  type SignInProvider,
  type SignInResult,
} from "./provider-sign-in.js";
import {
  filterProvidersHubRows,
  readProvidersHubModels,
  readProvidersHubSnapshot,
  withLocalProbe,
  type ProvidersHubModelRow,
  type ProvidersHubRow,
  type ProvidersHubSnapshot,
} from "./providers-hub-snapshot.js";
import type { SlashCommandContext } from "./types.js";
import {
  loadVeniceMenuModels,
  readVeniceMenuModels,
  VENICE_MODEL_LIST_UNAVAILABLE_NOTE,
} from "./venice-menu-models.js";
import {
  ensureOpenRouterZdrEndpoints,
  OPENROUTER_ZDR_LIST_UNAVAILABLE_NOTE,
} from "./live-model-catalog.js";
import {
  OPENROUTER_ZDR_OFF_HINT,
} from "../llm/zero-data-retention.js";
import {
  loadOllamaMenuModels,
  OLLAMA_MODEL_LIST_UNAVAILABLE_NOTE,
  readOllamaMenuModels,
} from "./ollama-menu-models.js";

export type ProvidersHubServices = {
  readonly reload: () => ProvidersHubSnapshot;
  readonly webSearchMode?: () => WebSearchMode;
  readonly deepSeekSearchState?: () => DeepSeekWebSearchSetting;
  readonly setWebSearchMode?: (mode: WebSearchMode) => Promise<ProvidersHubActionResult>;
  readonly probeLocal: () => Promise<ReadonlySet<ProviderSlug>>;
  readonly modelsFor: (provider: ProviderSlug) => readonly ProvidersHubModelRow[];
  /**
   * Ask a provider that publishes its own model list (Venice) for it; once it
   * settles, `modelsFor` returns that list. Null when there is nothing to wait
   * for: a fixed list, or one read moments ago. `note` says why the bundled
   * list stays.
   */
  readonly refreshModels?: (provider: ProviderSlug) => Promise<{ readonly note?: string }> | null;
  readonly connect: (provider: ProviderSlug, apiKey: string) => Promise<ProvidersHubActionResult>;
  readonly choose: (provider: ProviderSlug, model: string) => Promise<ProvidersHubActionResult>;
  readonly forget: (provider: ProviderSlug) => ProvidersHubActionResult;
  readonly signIn: (
    provider: SignInProvider,
    onProgress: (progress: SignInProgress) => void,
    signal: AbortSignal,
  ) => Promise<SignInResult>;
  readonly signOut: (provider: SignInProvider) => ProvidersHubActionResult;
  readonly setAuth: (provider: SignInProvider, auth: "oauth" | "api-key") => Promise<ProvidersHubActionResult>;
};

type ModelEntry =
  | { readonly kind: "model"; readonly row: ProvidersHubModelRow }
  | { readonly kind: "sign-in" }
  | { readonly kind: "sign-out"; readonly account: string }
  | { readonly kind: "use-account" }
  | { readonly kind: "use-key" }
  | { readonly kind: "replace-key" }
  | { readonly kind: "remove-key" }
  | { readonly kind: "web-search" };

/** Takes the place of the models when none matches the search. */
type NoMatch = { readonly kind: "no-match" };

/** A row of the models screen as it is shown. */
type ShownEntry = ModelEntry | NoMatch;

/** Above this many models the search line shows before anything is typed. */
const SEARCH_LINE_MIN_MODELS = 20;

/** The highlighted row on this screen: a muted gray band, as in the slash command picker. */
const ACTIVE_ROW_COLOR = "lineSoft";

/** The in-use mark's column on the models screen; the model column follows it. */
const MODEL_MARK_WIDTH = 3;

/** In-use mark, model, note, capabilities. */
const MODEL_COLUMNS: readonly number[] = [MODEL_MARK_WIDTH, 44, 8, 38];

/** Why an OpenRouter model is shown as unavailable, and how to use it anyway. */
const OPENROUTER_NO_ZDR_DETAIL =
  `No zero-retention endpoint serves this model. ${OPENROUTER_ZDR_OFF_HINT}`;

type ConnectChoice = "sign-in" | "paste-key";

type View =
  | { readonly kind: "list" }
  | { readonly kind: "connect"; readonly row: ProvidersHubRow }
  | { readonly kind: "key"; readonly row: ProvidersHubRow }
  | { readonly kind: "signin"; readonly row: ProvidersHubRow; readonly progress: SignInProgress | null }
  | { readonly kind: "models"; readonly row: ProvidersHubRow; readonly entries: readonly ModelEntry[] }
  | { readonly kind: "info"; readonly row: ProvidersHubRow };

type Notice = { readonly text: string; readonly failed: boolean } | null;

/** A provider's own model list being read, or why the bundled one stays. */
type ModelsLoad = {
  readonly provider: ProviderSlug;
  readonly loading: boolean;
  readonly note?: string;
} | null;

/** Which entry the cursor is on, so it stays there when the list changes. */
function entryIdentity(entry: ShownEntry | undefined): string | undefined {
  if (entry === undefined) return undefined;
  return entry.kind === "model" ? `model:${entry.row.model}` : entry.kind;
}

/**
 * The models screen for a search: the matching models, best first, then the
 * account and key rows, which a search never hides. No search shows every entry.
 */
function searchEntries(entries: readonly ModelEntry[], query: string): readonly ShownEntry[] {
  if (query.trim().length === 0) return entries;
  const models = entries.filter(
    (entry): entry is Extract<ModelEntry, { kind: "model" }> => entry.kind === "model",
  );
  const matches = searchModels(models, query, (entry) => ({
    ids: [entry.row.displayModel, entry.row.model],
    ...(entry.row.label === undefined ? {} : { label: entry.row.label }),
  }));
  return [
    ...(matches.length === 0 ? [{ kind: "no-match" } as const] : matches),
    ...entries.filter((entry) => entry.kind !== "model"),
  ];
}

/** The text a key adds to the search: printable characters, also when pasted. */
function searchInput(input: string, key: Key): string {
  if (key.ctrl || key.meta || key.super || key.return || key.tab || key.escape) return "";
  return input.replace(/\p{Cc}/gu, "");
}

function dotColor(row: ProvidersHubRow): "success" | "error" | "inactive" {
  if (row.connection === "error") return "error";
  if (row.connection === "current" || row.connection === "connected") return "success";
  return "inactive";
}

/** "ChatGPT" or "X": the account a sign-in provider signs in with. */
function accountName(provider: ProviderSlug): string {
  return provider === "openai" ? "ChatGPT" : "X";
}

function modelEntries(
  row: ProvidersHubRow,
  models: readonly ProvidersHubModelRow[],
): readonly ModelEntry[] {
  const signIn = row.signIn;
  const accountEntries: ModelEntry[] = [];
  if (signIn !== undefined) {
    accountEntries.push(
      signIn.account === null
        ? { kind: "sign-in" }
        : { kind: "sign-out", account: signIn.account },
    );
    // Switching needs both credentials, and an exported variable fixes it.
    if (signIn.account !== null && signIn.keyAvailable && signIn.lockedBy === undefined) {
      if (signIn.using === "account") accountEntries.push({ kind: "use-key" });
      if (signIn.using === "key") accountEntries.push({ kind: "use-account" });
    }
  }
  return [
    ...models.map((model): ModelEntry => ({ kind: "model", row: model })),
    { kind: "web-search" },
    ...accountEntries,
    ...(row.access === "api-key" ? [{ kind: "replace-key" } as const] : []),
    ...(row.keySaved ? [{ kind: "remove-key" } as const] : []),
  ];
}

function entryLabel(entry: Exclude<ModelEntry, { kind: "model" }>, row: ProvidersHubRow): string {
  switch (entry.kind) {
    case "sign-in":
      return `Sign in with your ${accountName(row.provider)} account`;
    case "sign-out":
      return `Sign out (${entry.account})`;
    case "use-account":
      return "Use your account instead of the key";
    case "use-key":
      return "Use the API key instead of your account";
    case "replace-key":
      return "Replace API key";
    case "remove-key":
      return "Remove saved key";
    case "web-search":
      return "Web search";
  }
}

/** What to tell a person about a provider they cannot connect from here. */
function infoLines(row: ProvidersHubRow): readonly string[] {
  switch (row.access) {
    case "local":
      return [
        `${row.name} runs on this computer and is not answering.`,
        `Start ${row.name}, then press Enter to check again.`,
      ];
    case "environment":
      return [
        `${row.name} signs in with your AWS credentials.`,
        `Set ${row.envLabel ?? "the AWS credential variables"} before starting AgenC.`,
      ];
    case "retired":
      return ["AgenC accounts no longer provide models."];
    default:
      return [row.status];
  }
}

/** "type to search", or what is typed with a cursor after it, over the model column. */
function SearchLine({ query }: { readonly query: string }): React.ReactNode {
  return (
    <Box flexDirection="row" paddingLeft={MODEL_MARK_WIDTH + 1}>
      {query.length === 0 ? (
        <ThemedText color="inactive">type to search</ThemedText>
      ) : (
        <>
          <ThemedText color="inactive">search: </ThemedText>
          <ThemedText color="text2" wrap="truncate-start">{query}</ThemedText>
          <ThemedText color="text2" inverse> </ThemedText>
        </>
      )}
    </Box>
  );
}

function ModelsView({
  row,
  entries,
  shown,
  query,
  activeIndex,
  busy,
  notice,
  loading = false,
  note,
  webSearchMode,
  deepSeekSearchState,
}: {
  readonly row: ProvidersHubRow;
  /** Every entry, before the search. */
  readonly entries: readonly ModelEntry[];
  /** The entries the search leaves, as listed. */
  readonly shown: readonly ShownEntry[];
  readonly query: string;
  readonly activeIndex: number;
  readonly busy: boolean;
  readonly notice: Notice;
  /** The provider's own model list is being read. */
  readonly loading?: boolean;
  readonly webSearchMode: WebSearchMode;
  readonly deepSeekSearchState?: DeepSeekWebSearchSetting;
  /** Why the bundled model list is shown. */
  readonly note?: string;
}): React.ReactNode {
  const models = entries.filter((entry) => entry.kind === "model").length;
  const noun = models === 1 ? "model" : "models";
  const matched = shown.filter((entry) => entry.kind === "model").length;
  const searching = query.length > 0;
  const highlighted = shown[activeIndex];
  const details = [
    ...(highlighted?.kind === "web-search" && row.provider === "deepseek" && deepSeekSearchState !== undefined
      ? [`DeepSeek Search: ${deepSeekSearchState === "on" ? "On" : deepSeekSearchState === "off" ? "Off" : "Auto"}.`] : []),
    ...(highlighted?.kind === "web-search" ? ["Auto loads search when needed. On gives the model WebSearch and web_fetch from the first request."] : []),
    ...(highlighted?.kind === "model" && highlighted.row.catalogDetail ? [highlighted.row.catalogDetail] : []),
    ...(highlighted?.kind === "model" && highlighted.row.tags?.includes("no tools")
      ? ["Agent tools will not work with this model."] : []),
    ...(highlighted?.kind === "model" && highlighted.row.zdrUnavailable === true
      ? [OPENROUTER_NO_ZDR_DETAIL]
      : []),
  ];
  return (
    <MenuModal
      title={row.name}
      count={searching ? `${matched} of ${models} ${noun}` : `${models} ${noun}`}
      summary={row.status}
      headerRight={busy ? "working" : loading ? "loading models" : undefined}
      closeHint={searching ? "esc to clear search" : "esc to go back"}
      hint={notice?.text}
      {...(details.length === 0 && note === undefined ? {} : {
        detail: <Box flexDirection="column">
          {note === undefined ? null : <ThemedText color="subtle" wrap="truncate-end">{note}</ThemedText>}
          {details.length === 0 ? null : <ThemedText color="subtle" wrap="wrap">{details.join(" ")}</ThemedText>}
        </Box>,
      })}
      {...(searching || models > SEARCH_LINE_MIN_MODELS ? { lead: <SearchLine query={query} /> } : {})}
      columns={MODEL_COLUMNS}
      headers={["", "model", "", "capabilities"]}
      items={shown}
      pinnedCount={shown.filter((entry) => entry.kind !== "model" && entry.kind !== "no-match").length}
      activeIndex={activeIndex}
      activeRowColor={ACTIVE_ROW_COLOR}
      renderRow={(entry, _index, active) => {
        if (entry.kind === "no-match") {
          return [
            <ThemedText key="mark" color="subtle"> </ThemedText>,
            <ThemedText key="label" color="inactive">no models match</ThemedText>,
            <ThemedText key="note" color="inactive"> </ThemedText>,
            <ThemedText key="tags" color="inactive"> </ThemedText>,
          ];
        }
        if (entry.kind !== "model") {
          return [
            <ThemedText key="mark" color="subtle"> </ThemedText>,
            <ThemedText key="label" color={active ? "text" : "subtle"} bold={active}>
              {entryLabel(entry, row)}
            </ThemedText>,
            <ThemedText key="note" color="inactive">{entry.kind === "web-search" ? webSearchMode === "on" ? "On" : "Auto" : " "}</ThemedText>,
            <ThemedText key="tags" color="inactive"> </ThemedText>,
          ];
        }
        const noZdr = entry.row.zdrUnavailable === true;
        return [
          <ThemedText key="mark" color={entry.row.current ? "agenc" : "subtle"}>
            {entry.row.current ? "●" : " "}
          </ThemedText>,
          <ThemedText key="model" color={active ? "text" : noZdr ? "inactive" : "text2"} bold={active} wrap="truncate-middle">
            {entry.row.displayModel}
          </ThemedText>,
          // A model OpenRouter would refuse says so before anything else.
          <ThemedText key="note" color={noZdr ? "warning" : "inactive"} wrap="truncate-end">
            {noZdr ? "no ZDR" : entry.row.current ? "in use" : entry.row.isDefault ? "default" : ""}
          </ThemedText>,
          // One step brighter on the highlighted row, so the tags stay readable on its band.
          <ThemedText key="tags" color={active ? "inactive" : "muted3"} wrap="truncate-end">
            {entry.row.tags ?? ""}
          </ThemedText>,
        ];
      }}
      footer={[
        { keyName: "enter", label: "use" },
        { keyName: "esc", label: searching ? "clear" : "back" },
      ]}
    />
  );
}

function KeyView({
  row,
  value,
  onChange,
  onSubmit,
  busy,
  notice,
}: {
  readonly row: ProvidersHubRow;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly busy: boolean;
  readonly notice: Notice;
}): React.ReactNode {
  const [cursorOffset, setCursorOffset] = React.useState(value.length);
  return (
    <Popup
      title={`${row.name} API key`}
      headerRight="esc to go back"
      status={busy ? "checking" : undefined}
      footer={[
        { keyName: "enter", label: "check and save" },
        { keyName: "esc", label: "back" },
      ]}
      minHeight={9}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText color="text2">
          Paste your key. AgenC checks it with {row.name}, then saves it on this computer.
        </ThemedText>
        <Box flexDirection="row">
          <ThemedText color="agenc">{"› "}</ThemedText>
          <TextInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            cursorOffset={Math.min(cursorOffset, value.length)}
            onChangeCursorOffset={setCursorOffset}
            columns={60}
            focus={!busy}
            showCursor={!busy}
            multiline={false}
            mask="•"
            placeholder="paste key"
          />
        </Box>
        {notice ? (
          <ThemedText color={notice.failed ? "error" : "success"} wrap="wrap">
            {notice.text}
          </ThemedText>
        ) : null}
      </Box>
    </Popup>
  );
}

const CONNECT_CHOICES: readonly ConnectChoice[] = ["sign-in", "paste-key"];

function ConnectView({
  row,
  activeIndex,
  notice,
}: {
  readonly row: ProvidersHubRow;
  readonly activeIndex: number;
  readonly notice: Notice;
}): React.ReactNode {
  return (
    <MenuModal
      title={row.name}
      summary="not set"
      closeHint="esc to go back"
      {...(notice === null ? {} : { hint: notice.text })}
      columns={[3, 50]}
      headers={["", "connect with"]}
      items={CONNECT_CHOICES}
      activeIndex={activeIndex}
      activeRowColor={ACTIVE_ROW_COLOR}
      renderRow={(choice, _index, active) => [
        <ThemedText key="mark" color="subtle"> </ThemedText>,
        <ThemedText key="label" color={active ? "text" : "text2"} bold={active}>
          {choice === "sign-in"
            ? `Sign in with your ${accountName(row.provider)} account`
            : "Paste an API key"}
        </ThemedText>,
      ]}
      footer={[
        { keyName: "enter", label: "choose" },
        { keyName: "esc", label: "back" },
      ]}
    />
  );
}

function SignInView({
  row,
  progress,
}: {
  readonly row: ProvidersHubRow;
  readonly progress: SignInProgress | null;
}): React.ReactNode {
  return (
    <Popup
      title={`${row.name} sign-in`}
      headerRight="esc to cancel"
      status="waiting for the browser"
      footer={[{ keyName: "esc", label: "cancel" }]}
      minHeight={9}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText color="text" wrap="wrap">
          {progress?.heading ?? "Starting the sign-in…"}
        </ThemedText>
        {progress?.url ? (
          <ThemedText color="agenc" wrap="wrap">
            {progress.url}
          </ThemedText>
        ) : null}
        {progress?.userCode ? (
          <ThemedText color="text">
            Code: <ThemedText color="text" bold>{progress.userCode}</ThemedText>
          </ThemedText>
        ) : null}
      </Box>
    </Popup>
  );
}

function InfoView({ row, busy }: { readonly row: ProvidersHubRow; readonly busy: boolean }): React.ReactNode {
  return (
    <Popup
      title={row.name}
      headerRight="esc to go back"
      status={busy ? "checking" : row.status}
      footer={[
        ...(row.access === "local" ? [{ keyName: "enter", label: "check again" }] : []),
        { keyName: "esc", label: "back" },
      ]}
      minHeight={7}
    >
      <Box flexDirection="column">
        {infoLines(row).map((line, index) => (
          <ThemedText key={index} color={index === 0 ? "text" : "text2"} wrap="wrap">
            {line}
          </ThemedText>
        ))}
      </Box>
    </Popup>
  );
}

export function ProvidersHubView({
  initial,
  initialProvider,
  services,
  onDone,
}: {
  readonly initial: ProvidersHubSnapshot;
  /** Open on this provider's models, as `/model` does. */
  readonly initialProvider?: ProviderSlug;
  readonly services: ProvidersHubServices;
  readonly onDone: () => void;
}): React.ReactNode {
  const [snapshot, setSnapshot] = React.useState(initial);
  const [webSearchMode, setWebSearchMode] = React.useState<WebSearchMode>(() => services.webSearchMode?.() ?? "auto");
  const [probed, setProbed] = React.useState<ReadonlySet<ProviderSlug> | null>(null);
  const [filter, setFilter] = React.useState("");
  const [listIndex, setListIndex] = React.useState(0);
  const [modelIndex, setModelIndex] = React.useState(0);
  const [keyValue, setKeyValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [connectIndex, setConnectIndex] = React.useState(0);
  const signInAbort = React.useRef<AbortController | null>(null);
  const [view, setView] = React.useState<View>(() => {
    const row = initial.rows.find((candidate) => candidate.provider === initialProvider);
    return row === undefined
      ? { kind: "list" }
      : { kind: "models", row, entries: modelEntries(row, services.modelsFor(row.provider)) };
  });
  const [modelsLoad, setModelsLoad] = React.useState<ModelsLoad>(null);
  /** What is typed on the models screen; empty shows every model. */
  const [modelQuery, setModelQuery] = React.useState("");
  // A model list that arrives later applies to the screen shown then.
  const viewRef = React.useRef(view);
  viewRef.current = view;
  const modelIndexRef = React.useRef(modelIndex);
  modelIndexRef.current = modelIndex;
  // Keys can arrive faster than renders: each one reads what the last one set.
  const modelQueryRef = React.useRef(modelQuery);
  modelQueryRef.current = modelQuery;
  const loadGeneration = React.useRef(0);
  const mounted = React.useRef(true);
  React.useEffect(() => () => {
    mounted.current = false;
  }, []);

  /** Read a provider's own model list, then show it in place of the bundled one. */
  const refreshModels = React.useCallback(
    (row: ProvidersHubRow) => {
      const generation = ++loadGeneration.current;
      const pending = services.refreshModels?.(row.provider) ?? null;
      if (pending === null) {
        setModelsLoad(null);
        return;
      }
      setModelsLoad({ provider: row.provider, loading: true });
      void pending.then(
        (result) => result,
        (): { readonly note?: string } => ({}),
      ).then((result) => {
        if (!mounted.current || generation !== loadGeneration.current) return;
        setModelsLoad({
          provider: row.provider,
          loading: false,
          ...(result.note === undefined ? {} : { note: result.note }),
        });
        const current = viewRef.current;
        if (current.kind !== "models" || current.row.provider !== row.provider) return;
        const entries = modelEntries(current.row, services.modelsFor(row.provider));
        // The search stays; the cursor stays on its entry when the new list has it.
        const query = modelQueryRef.current;
        const active = entryIdentity(searchEntries(current.entries, query)[modelIndexRef.current]);
        const next: View = { ...current, entries };
        const index = Math.max(
          0,
          searchEntries(entries, query).findIndex((entry) => entryIdentity(entry) === active),
        );
        viewRef.current = next;
        modelIndexRef.current = index;
        setView(next);
        setModelIndex(index);
      });
    },
    [services],
  );

  React.useEffect(() => {
    // `/model` opens straight on the current provider's models.
    const opened = viewRef.current;
    if (opened.kind === "models") refreshModels(opened.row);
  }, [refreshModels]);

  const shown = React.useMemo(() => {
    const base = probed === null ? snapshot : withLocalProbe(snapshot, probed);
    return filterProvidersHubRows(base.rows, filter);
  }, [snapshot, probed, filter]);

  React.useEffect(() => {
    let live = true;
    void services.probeLocal().then(
      (running) => {
        if (live) setProbed(running);
      },
      () => {
        if (live) setProbed(new Set());
      },
    );
    return () => {
      live = false;
    };
  }, [services]);

  /** Start the models screen without a search. */
  const clearModelSearch = React.useCallback(() => {
    modelQueryRef.current = "";
    setModelQuery("");
  }, []);

  const openModels = React.useCallback(
    (row: ProvidersHubRow, message?: string) => {
      const entries = modelEntries(row, services.modelsFor(row.provider));
      const current = entries.findIndex((entry) => entry.kind === "model" && entry.row.current);
      setModelIndex(Math.max(0, current));
      setNotice(message === undefined ? null : { text: message, failed: false });
      const next: View = { kind: "models", row, entries };
      viewRef.current = next;
      modelIndexRef.current = Math.max(0, current);
      clearModelSearch();
      setView(next);
      // Also after a key is saved or replaced: the list is read with that key.
      refreshModels(row);
    },
    [services, refreshModels, clearModelSearch],
  );

  /** Re-read the snapshot and return this provider's fresh row. */
  const refreshed = (row: ProvidersHubRow): ProvidersHubRow => {
    const next = services.reload();
    setSnapshot(next);
    return next.rows.find((candidate) => candidate.provider === row.provider) ?? row;
  };

  const startSignIn = (row: ProvidersHubRow): void => {
    if (!isSignInProvider(row.provider)) return;
    const provider = row.provider;
    const controller = new AbortController();
    signInAbort.current = controller;
    setNotice(null);
    setView({ kind: "signin", row, progress: null });
    void services
      .signIn(
        provider,
        (progress) => {
          setView((current) => (current.kind === "signin" ? { ...current, progress } : current));
        },
        controller.signal,
      )
      .then(
        (result) => result,
        (error: unknown): SignInResult => ({
          ok: false,
          cancelled: false,
          message: `Sign-in failed: ${error instanceof Error ? error.message : String(error)}.`,
        }),
      )
      .then((result) => {
        signInAbort.current = null;
        const updated = refreshed(row);
        if (result.ok) {
          openModels(updated);
          return;
        }
        const back = updated.connection === "current" || updated.connection === "connected";
        if (back) openModels(updated);
        else setView({ kind: "connect", row: updated });
        setNotice(result.cancelled ? null : { text: result.message, failed: true });
      });
  };

  const openRow = (row: ProvidersHubRow): void => {
    setNotice(null);
    if (row.connection === "current" || row.connection === "connected") {
      openModels(row);
      return;
    }
    if (row.connection === "not-set" && isSignInProvider(row.provider)) {
      setConnectIndex(0);
      setView({ kind: "connect", row });
      return;
    }
    if (row.access === "api-key" && row.connection === "not-set") {
      setKeyValue("");
      setView({ kind: "key", row });
      return;
    }
    setView({ kind: "info", row });
  };

  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    void work().catch(() => {
      setNotice({ text: "Could not complete this action. Try again or press Esc to go back.", failed: true });
    }).finally(() => setBusy(false));
  };

  const submitKey = (row: ProvidersHubRow, value: string): void => {
    if (busy) return;
    run(async () => {
      const result = await services.connect(row.provider, value);
      if (!result.ok) {
        setNotice({ text: result.message, failed: true });
        return;
      }
      setKeyValue("");
      if (result.sessionOnly) {
        setNotice({ text: result.message, failed: false });
        return;
      }
      const next = services.reload();
      setSnapshot(next);
      const connected = next.rows.find((candidate) => candidate.provider === row.provider) ?? row;
      openModels(connected, result.message);
    });
  };

  const moveModelCursor = (index: number): void => {
    modelIndexRef.current = index;
    setModelIndex(index);
  };

  /**
   * Search the models for `next`. A new search starts on its best match; an
   * emptied one keeps the cursor on the model it was on, or the one in use.
   */
  const searchModelList = (entries: readonly ModelEntry[], next: string): void => {
    const previous = modelQueryRef.current;
    const sameSearch = next.trim().toLowerCase() === previous.trim().toLowerCase();
    let index = 0;
    if (sameSearch) {
      index = modelIndexRef.current;
    } else if (next.trim().length === 0) {
      const highlighted = entryIdentity(searchEntries(entries, previous)[modelIndexRef.current]);
      const kept = entries.findIndex((entry) => entryIdentity(entry) === highlighted);
      const inUse = entries.findIndex((entry) => entry.kind === "model" && entry.row.current);
      index = Math.max(0, kept >= 0 ? kept : inUse);
    }
    modelQueryRef.current = next;
    setModelQuery(next);
    moveModelCursor(index);
  };

  useInputCapture((input, key) => {
    if (input !== "c" || !key.ctrl) return false;
    signInAbort.current?.abort();
    clearSharedDoublePressState("app:interrupt");
    onDone();
    return true;
  }, { context: "Chat" });

  useInput((input, key) => {
    if (view.kind === "signin") {
      if (key.escape) signInAbort.current?.abort();
      return;
    }
    if (busy) return;
    if (view.kind === "connect") {
      if (key.escape || input === "q") {
        setNotice(null);
        setView({ kind: "list" });
        return;
      }
      if (key.upArrow) {
        setConnectIndex((index) => previousMenuIndex(index, CONNECT_CHOICES.length));
        return;
      }
      if (key.downArrow) {
        setConnectIndex((index) => nextMenuIndex(index, CONNECT_CHOICES.length));
        return;
      }
      if (key.return) {
        if (CONNECT_CHOICES[connectIndex] === "sign-in") {
          startSignIn(view.row);
        } else {
          setKeyValue("");
          setNotice(null);
          setView({ kind: "key", row: view.row });
        }
      }
      return;
    }
    if (view.kind === "key") {
      if (key.escape) {
        setNotice(null);
        setView({ kind: "list" });
      }
      return;
    }
    if (view.kind === "info") {
      if (key.escape || input === "q") {
        setView({ kind: "list" });
        return;
      }
      if (key.return && view.row.access === "local") {
        run(async () => {
          const running = await services.probeLocal().catch(() => new Set<ProviderSlug>());
          setProbed(running);
          if (running.has(view.row.provider)) {
            openModels({ ...view.row, connection: "connected", status: "running" });
          }
        });
      }
      return;
    }
    if (view.kind === "models") {
      // A provider's own list can replace the entries while this view is
      // open, a moment before this handler sees them: use what is on screen.
      const entries = viewRef.current.kind === "models" ? viewRef.current.entries : view.entries;
      const query = modelQueryRef.current;
      const onScreen = searchEntries(entries, query);
      // Esc clears a search first, then goes back.
      if (key.escape) {
        if (query.length > 0) {
          searchModelList(entries, "");
          return;
        }
        setNotice(null);
        setView({ kind: "list" });
        return;
      }
      if (key.upArrow) {
        moveModelCursor(previousMenuIndex(modelIndexRef.current, onScreen.length));
        return;
      }
      if (key.downArrow) {
        moveModelCursor(nextMenuIndex(modelIndexRef.current, onScreen.length));
        return;
      }
      if (key.backspace || key.delete) {
        if (query.length > 0) searchModelList(entries, query.slice(0, -1));
        return;
      }
      if (!key.return) {
        const typed = searchInput(input, key);
        // A search starts at its first visible character.
        const next = query.length === 0 ? typed.trimStart() : query + typed;
        if (next !== query) searchModelList(entries, next);
        return;
      }
      const entry = onScreen[modelIndexRef.current];
      if (entry === undefined || entry.kind === "no-match") return;
      if (entry.kind === "web-search") {
        run(async () => {
          const result = await services.setWebSearchMode?.(webSearchMode === "on" ? "auto" : "on");
          if (result !== undefined) {
            setWebSearchMode(services.webSearchMode?.() ?? "auto");
            setNotice({ text: result.message, failed: !result.ok });
          }
        });
        return;
      }
      if (entry.kind === "replace-key") {
        setKeyValue("");
        setNotice(null);
        setView({ kind: "key", row: view.row });
        return;
      }
      if (entry.kind === "sign-in") {
        startSignIn(view.row);
        return;
      }
      if (entry.kind === "sign-out" && isSignInProvider(view.row.provider)) {
        const result = services.signOut(view.row.provider);
        const updated = refreshed(view.row);
        setNotice({ text: result.message, failed: !result.ok });
        if (updated.connection === "current" || updated.connection === "connected") {
          setView({ kind: "models", row: updated, entries: modelEntries(updated, services.modelsFor(updated.provider)) });
          setModelIndex(0);
          clearModelSearch();
        } else {
          setView({ kind: "list" });
        }
        return;
      }
      if ((entry.kind === "use-account" || entry.kind === "use-key") && isSignInProvider(view.row.provider)) {
        const provider = view.row.provider;
        run(async () => {
          const result = await services.setAuth(provider, entry.kind === "use-account" ? "oauth" : "api-key");
          const updated = refreshed(view.row);
          setView({ kind: "models", row: updated, entries: modelEntries(updated, services.modelsFor(updated.provider)) });
          setModelIndex(0);
          clearModelSearch();
          setNotice({ text: result.message, failed: !result.ok });
        });
        return;
      }
      if (entry.kind === "remove-key") {
        const result = services.forget(view.row.provider);
        const next = services.reload();
        setSnapshot(next);
        const updated = next.rows.find((candidate) => candidate.provider === view.row.provider);
        setNotice({ text: result.message, failed: !result.ok });
        if (updated !== undefined) {
          const models: View = { kind: "models", row: updated, entries: modelEntries(updated, services.modelsFor(updated.provider)) };
          viewRef.current = models;
          modelIndexRef.current = 0;
          setView(models);
          setModelIndex(0);
          clearModelSearch();
          refreshModels(updated);
        }
        return;
      }
      if (entry.kind !== "model") return;
      if (entry.row.zdrUnavailable === true) {
        setNotice({ text: OPENROUTER_NO_ZDR_DETAIL, failed: true });
        return;
      }
      run(async () => {
        const result = await services.choose(view.row.provider, entry.row.model);
        if (result.ok) {
          if (entry.row.tags?.includes("no tools")) {
            setNotice({ text: "Model selected. Agent tools will not work with this model.", failed: false });
            return;
          }
          onDone();
          return;
        }
        setNotice({ text: result.message, failed: true });
      });
      return;
    }
    // List: letters filter, arrows move, Enter opens.
    if (key.escape) {
      if (filter.length > 0) {
        setFilter("");
        setListIndex(0);
        return;
      }
      onDone();
      return;
    }
    if (key.upArrow) {
      setListIndex((index) => previousMenuIndex(index, shown.length));
      return;
    }
    if (key.downArrow) {
      setListIndex((index) => nextMenuIndex(index, shown.length));
      return;
    }
    if (key.return) {
      const row = shown[listIndex];
      if (row !== undefined) openRow(row);
      return;
    }
    if (key.backspace || key.delete) {
      setFilter((value) => value.slice(0, -1));
      setListIndex(0);
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta && /^[\w .-]+$/u.test(input)) {
      setFilter((value) => value + input);
      setListIndex(0);
    }
  });

  if (view.kind === "key") {
    return (
      <KeyView
        row={view.row}
        value={keyValue}
        onChange={setKeyValue}
        onSubmit={(value) => submitKey(view.row, value)}
        busy={busy}
        notice={notice}
      />
    );
  }
  if (view.kind === "info") return <InfoView row={view.row} busy={busy} />;
  if (view.kind === "connect") {
    return <ConnectView row={view.row} activeIndex={connectIndex} notice={notice} />;
  }
  if (view.kind === "signin") return <SignInView row={view.row} progress={view.progress} />;
  if (view.kind === "models") {
    const load = modelsLoad?.provider === view.row.provider ? modelsLoad : null;
    return (
      <ModelsView
        row={view.row}
        entries={view.entries}
        shown={searchEntries(view.entries, modelQuery)}
        query={modelQuery}
        activeIndex={modelIndex}
        busy={busy}
        notice={notice}
        loading={load?.loading === true}
        webSearchMode={webSearchMode}
        {...(services.deepSeekSearchState === undefined ? {} : { deepSeekSearchState: services.deepSeekSearchState() })}
        {...(load?.note === undefined ? {} : { note: load.note })}
      />
    );
  }

  const connected = shown.filter(
    (row) => row.connection === "current" || row.connection === "connected",
  ).length;
  const highlighted = shown[listIndex];
  return (
    <MenuModal
      title="providers"
      count={`${connected} connected`}
      summary={filter.length > 0 ? `filter: ${filter}` : `${snapshot.currentProvider} · ${snapshot.currentModel}`}
      headerRight={probed === null ? "checking local" : undefined}
      columns={[3, 24, 30, 28]}
      headers={["", "provider", "status", "model"]}
      items={shown}
      activeIndex={listIndex}
      activeRowColor={ACTIVE_ROW_COLOR}
      detail={highlighted ? <ThemedText color="text2" wrap="wrap">
        {highlighted.access === "local" || highlighted.access === "environment" || highlighted.access === "retired"
          ? highlighted.connection === "current" || highlighted.connection === "connected"
            ? `${highlighted.name}: choose a model to answer in this conversation.`
            : infoLines(highlighted).join(" ")
          : `${highlighted.name}: open to ${highlighted.connection === "current" || highlighted.connection === "connected" ? "choose a model for this conversation" : highlighted.signIn !== undefined ? "connect your account or key" : "connect your API key"}.`}
      </ThemedText> : undefined}
      renderRow={(row, _index, active) => [
        <ThemedText key="dot" color={dotColor(row)}>●</ThemedText>,
        <ThemedText key="name" color={active ? "text" : "text2"} bold={active} wrap="truncate-end">
          {row.name}
        </ThemedText>,
        <ThemedText
          key="status"
          color={row.connection === "error" ? "error" : row.connection === "not-set" ? "inactive" : "text2"}
          wrap="truncate-end"
        >
          {row.connection === "current" ? `in use · ${row.status}` : row.status}
        </ThemedText>,
        <ThemedText key="model" color="subtle" wrap="truncate-middle">
          {row.connection === "current" || row.connection === "connected" ? row.model : ""}
        </ThemedText>,
      ]}
      footer={[
        { keyName: "type", label: "filter" },
        { keyName: "enter", label: "open" },
        { keyName: "esc", label: "close" },
      ]}
    />
  );
}

function servicesFor(ctx: SlashCommandContext): ProvidersHubServices {
  return {
    reload: () => readProvidersHubSnapshot(ctx),
    webSearchMode: () => resolveWebSearchMode(providerEnvironmentFromCommandContext(ctx), readCommandConfig(ctx)?.web_search),
    setWebSearchMode: (mode) => chooseWebSearchMode(ctx, mode),
    deepSeekSearchState: () => {
      const env = providerEnvironmentFromCommandContext(ctx);
      const config = readCommandConfig(ctx);
      return resolveDeepSeekWebSearchSetting(env.AGENC_DEEPSEEK_WEB_SEARCH,
        resolveWebSearchMode(env, config?.web_search) === "on" ? true : config?.providers?.deepseek?.web_search);
    },
    probeLocal: async () => {
      const { detectRunningLocalProviders } = await import("../onboarding/Onboarding.js");
      const running = await detectRunningLocalProviders({
        config: readCommandConfig(ctx) ?? requireCommandConfigStore(ctx).current(),
        env: providerEnvironmentFromCommandContext(ctx),
      });
      return new Set(running);
    },
    modelsFor: (provider) => readProvidersHubModels(ctx, provider),
    refreshModels: (provider) => {
      if (provider === "ollama") {
        // The models installed on the local Ollama server the session uses.
        if (readOllamaMenuModels(ctx) !== undefined) return null;
        return loadOllamaMenuModels(ctx).then(
          (models) => models === undefined ? { note: OLLAMA_MODEL_LIST_UNAVAILABLE_NOTE } : {},
          () => ({ note: OLLAMA_MODEL_LIST_UNAVAILABLE_NOTE }),
        );
      }
      if (provider === "openrouter") {
        return Promise.all([
          openRouterMenuCatalog(ctx).refresh(),
          ensureOpenRouterZdrEndpoints(ctx),
        ]).then(([catalog, zdrKnown]) => ({
          ...(catalog.source === "bundled" ? { note: OPENROUTER_CATALOG_FALLBACK_NOTE }
            : !zdrKnown ? { note: OPENROUTER_ZDR_LIST_UNAVAILABLE_NOTE } : {}),
        }));
      }
      return provider !== "venice" || readVeniceMenuModels(ctx) !== undefined
        ? null
        : loadVeniceMenuModels(ctx).then(
            (result) => result.source === "bundled" && result.reason === "unavailable"
              ? { note: VENICE_MODEL_LIST_UNAVAILABLE_NOTE }
              : {},
            () => ({ note: VENICE_MODEL_LIST_UNAVAILABLE_NOTE }),
          );
    },
    connect: (provider, apiKey) => connectProviderWithKey(ctx, provider, apiKey),
    choose: (provider, model) => chooseProviderModel(ctx, provider, model),
    forget: (provider) => forgetProviderKey(ctx, provider),
    signIn: (provider, onProgress, signal) => signInWithAccount(ctx, provider, onProgress, signal),
    signOut: (provider) => signOutOfAccount(ctx, provider),
    setAuth: (provider, auth) => chooseProviderAuth(ctx, provider, auth),
  };
}

/**
 * Open the screen. `/model` and alt+p pass `currentModels` to land on the
 * current provider's models; esc from there shows every provider.
 */
export function openProvidersHub(
  ctx: SlashCommandContext,
  options: { readonly currentModels?: boolean } = {},
): boolean {
  const snapshot = readProvidersHubSnapshot(ctx);
  const services = servicesFor(ctx);
  return openLocalJsxCommand(ctx, (close) => (
    <ProvidersHubView
      initial={snapshot}
      {...(options.currentModels === true ? { initialProvider: snapshot.currentProvider } : {})}
      services={services}
      onDone={close}
    />
  ));
}
