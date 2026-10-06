import React from "react";
import type { ProviderSlug } from "../config/provider-model-authority.js";
import TextInput from "../tui/components/TextInput.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal, Popup } from "../tui/components/v2/primitives.js";
import { Box, useInput } from "../tui/ink.js";
import {
  providerEnvironmentFromCommandContext,
  readCommandConfig,
  requireCommandConfigStore,
} from "./config-context.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import {
  chooseProviderModel,
  connectProviderWithKey,
  forgetProviderKey,
  type ProvidersHubActionResult,
} from "./providers-hub-actions.js";
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

export type ProvidersHubServices = {
  readonly reload: () => ProvidersHubSnapshot;
  readonly probeLocal: () => Promise<ReadonlySet<ProviderSlug>>;
  readonly modelsFor: (provider: ProviderSlug) => readonly ProvidersHubModelRow[];
  readonly connect: (provider: ProviderSlug, apiKey: string) => Promise<ProvidersHubActionResult>;
  readonly choose: (provider: ProviderSlug, model: string) => Promise<ProvidersHubActionResult>;
  readonly forget: (provider: ProviderSlug) => ProvidersHubActionResult;
};

type ModelEntry =
  | { readonly kind: "model"; readonly row: ProvidersHubModelRow }
  | { readonly kind: "replace-key" }
  | { readonly kind: "remove-key" };

type View =
  | { readonly kind: "list" }
  | { readonly kind: "key"; readonly row: ProvidersHubRow }
  | { readonly kind: "models"; readonly row: ProvidersHubRow; readonly entries: readonly ModelEntry[] }
  | { readonly kind: "info"; readonly row: ProvidersHubRow };

type Notice = { readonly text: string; readonly failed: boolean } | null;

function dotColor(row: ProvidersHubRow): "success" | "error" | "inactive" {
  if (row.connection === "error") return "error";
  if (row.connection === "current" || row.connection === "connected") return "success";
  return "inactive";
}

function modelEntries(
  row: ProvidersHubRow,
  models: readonly ProvidersHubModelRow[],
): readonly ModelEntry[] {
  return [
    ...models.map((model): ModelEntry => ({ kind: "model", row: model })),
    ...(row.access === "api-key" ? [{ kind: "replace-key" } as const] : []),
    ...(row.keySaved ? [{ kind: "remove-key" } as const] : []),
  ];
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
    case "managed":
      return [`${row.name} uses your AgenC account.`, "Run /login to sign in."];
    default:
      return [row.status];
  }
}

function ModelsView({
  row,
  entries,
  activeIndex,
  busy,
  notice,
}: {
  readonly row: ProvidersHubRow;
  readonly entries: readonly ModelEntry[];
  readonly activeIndex: number;
  readonly busy: boolean;
  readonly notice: Notice;
}): React.ReactNode {
  const models = entries.filter((entry) => entry.kind === "model").length;
  return (
    <MenuModal
      title={row.name}
      count={`${models} ${models === 1 ? "model" : "models"}`}
      summary={row.status}
      headerRight={busy ? "working" : undefined}
      closeHint="esc to go back"
      hint={notice?.text}
      columns={[3, 44, 20]}
      headers={["", "model", ""]}
      items={entries}
      activeIndex={activeIndex}
      renderRow={(entry, _index, active) => {
        if (entry.kind !== "model") {
          return [
            <ThemedText key="mark" color="subtle"> </ThemedText>,
            <ThemedText key="label" color={active ? "text" : "subtle"} bold={active}>
              {entry.kind === "replace-key" ? "Replace API key" : "Remove saved key"}
            </ThemedText>,
            <ThemedText key="note" color="inactive"> </ThemedText>,
          ];
        }
        return [
          <ThemedText key="mark" color={entry.row.current ? "agenc" : "subtle"}>
            {entry.row.current ? "●" : " "}
          </ThemedText>,
          <ThemedText key="model" color={active ? "text" : "text2"} bold={active} wrap="truncate-middle">
            {entry.row.displayModel}
          </ThemedText>,
          <ThemedText key="note" color="inactive" wrap="truncate-end">
            {entry.row.current ? "in use" : entry.row.isDefault ? "default" : ""}
          </ThemedText>,
        ];
      }}
      footer={[
        { keyName: "enter", label: "use" },
        { keyName: "esc", label: "back" },
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
  const [probed, setProbed] = React.useState<ReadonlySet<ProviderSlug> | null>(null);
  const [filter, setFilter] = React.useState("");
  const [listIndex, setListIndex] = React.useState(0);
  const [modelIndex, setModelIndex] = React.useState(0);
  const [keyValue, setKeyValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [view, setView] = React.useState<View>(() => {
    const row = initial.rows.find((candidate) => candidate.provider === initialProvider);
    return row === undefined
      ? { kind: "list" }
      : { kind: "models", row, entries: modelEntries(row, services.modelsFor(row.provider)) };
  });

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

  const openModels = React.useCallback(
    (row: ProvidersHubRow, message?: string) => {
      const entries = modelEntries(row, services.modelsFor(row.provider));
      const current = entries.findIndex((entry) => entry.kind === "model" && entry.row.current);
      setModelIndex(Math.max(0, current));
      setNotice(message === undefined ? null : { text: message, failed: false });
      setView({ kind: "models", row, entries });
    },
    [services],
  );

  const openRow = (row: ProvidersHubRow): void => {
    setNotice(null);
    if (row.connection === "current" || row.connection === "connected") {
      openModels(row);
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
    void work().finally(() => setBusy(false));
  };

  const submitKey = (row: ProvidersHubRow, value: string): void => {
    if (busy) return;
    run(async () => {
      const result = await services.connect(row.provider, value);
      if (!result.ok) {
        setNotice({ text: result.message, failed: true });
        return;
      }
      const next = services.reload();
      setSnapshot(next);
      const connected = next.rows.find((candidate) => candidate.provider === row.provider) ?? row;
      openModels(connected);
    });
  };

  useInput((input, key) => {
    if (busy) return;
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
      if (key.escape || input === "q") {
        setNotice(null);
        setView({ kind: "list" });
        return;
      }
      if (key.upArrow) {
        setModelIndex((index) => previousMenuIndex(index, view.entries.length));
        return;
      }
      if (key.downArrow) {
        setModelIndex((index) => nextMenuIndex(index, view.entries.length));
        return;
      }
      if (!key.return) return;
      const entry = view.entries[modelIndex];
      if (entry === undefined) return;
      if (entry.kind === "replace-key") {
        setKeyValue("");
        setNotice(null);
        setView({ kind: "key", row: view.row });
        return;
      }
      if (entry.kind === "remove-key") {
        const result = services.forget(view.row.provider);
        const next = services.reload();
        setSnapshot(next);
        const updated = next.rows.find((candidate) => candidate.provider === view.row.provider);
        setNotice({ text: result.message, failed: !result.ok });
        if (updated !== undefined) {
          setView({ kind: "models", row: updated, entries: modelEntries(updated, services.modelsFor(updated.provider)) });
          setModelIndex(0);
        }
        return;
      }
      run(async () => {
        const result = await services.choose(view.row.provider, entry.row.model);
        if (result.ok) {
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
  if (view.kind === "models") {
    return (
      <ModelsView
        row={view.row}
        entries={view.entries}
        activeIndex={modelIndex}
        busy={busy}
        notice={notice}
      />
    );
  }

  const connected = shown.filter(
    (row) => row.connection === "current" || row.connection === "connected",
  ).length;
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
    probeLocal: async () => {
      const { detectRunningLocalProviders } = await import("../onboarding/Onboarding.js");
      const running = await detectRunningLocalProviders({
        config: readCommandConfig(ctx) ?? requireCommandConfigStore(ctx).current(),
        env: providerEnvironmentFromCommandContext(ctx),
      });
      return new Set(running);
    },
    modelsFor: (provider) => readProvidersHubModels(ctx, provider),
    connect: (provider, apiKey) => connectProviderWithKey(ctx, provider, apiKey),
    choose: (provider, model) => chooseProviderModel(ctx, provider, model),
    forget: (provider) => forgetProviderKey(ctx, provider),
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
