import React from "react";
import { describe, expect, test, vi } from "vitest";

import { renderToString } from "../../utils/staticRender.js";
import { Text } from "../ink.js";
import {
  AppStateProvider,
  useAppState,
  type AppState,
} from "./AppState.js";
import { createStore } from "./store.js";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../context/mailbox.js", () => ({
  MailboxProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../hooks/useEffectEventCompat.js", () => ({
  useEffectEventCompat: (callback: unknown) => callback,
}));
vi.mock("../hooks/useSettingsChange.js", () => ({
  useSettingsChange: () => {},
}));
vi.mock("../../services/PromptSuggestion/promptSuggestion.js", () => ({
  shouldEnablePromptSuggestion: () => false,
}));
vi.mock("../../tools/Tool.js", () => ({
  getEmptyToolPermissionContext: () => ({
    mode: "default",
    additionalDirectories: [],
    alwaysAllowRules: [],
    alwaysDenyRules: [],
    isBypassPermissionsModeAvailable: false,
  }),
}));
vi.mock("../../utils/commitAttribution.js", () => ({
  createEmptyAttributionState: () => ({}),
}));
vi.mock("../../utils/permissions/permissionSetup.js", () => ({
  createDisabledBypassPermissionsContext: (context: unknown) => context,
  isBypassPermissionsModeDisabled: () => false,
}));
vi.mock("../../utils/settings/applySettingsChange.js", () => ({
  applySettingsChange: () => {},
}));
vi.mock("../../utils/settings/settings.js", () => ({
  getInitialSettings: () => ({}),
}));
vi.mock("../../utils/teammate.js", () => ({
  isPlanModeRequired: () => false,
  isTeammate: () => false,
}));
vi.mock("../../utils/thinking.js", () => ({
  shouldEnableThinkingByDefault: () => false,
}));

function StatusLineProbe(): React.ReactNode {
  const statusLineText = useAppState((state) => state.statusLineText);
  return <Text>{statusLineText}</Text>;
}

describe("AppState", () => {
  test("provides selected state from the absorbed TUI state entrypoint", async () => {
    const initialState = {
      statusLineText: "state-ready",
      toolPermissionContext: { isBypassPermissionsModeAvailable: false },
    } as AppState;

    const output = await renderToString(
      <AppStateProvider initialState={initialState}>
        <StatusLineProbe />
      </AppStateProvider>,
      80,
    );

    expect(output).toContain("state-ready");
  });

  test("notifies store subscribers when state changes", () => {
    const store = createStore({ count: 0 });
    const snapshots: number[] = [];
    const unsubscribe = store.subscribe(() => {
      snapshots.push(store.getState().count);
    });

    store.setState((state) => ({ count: state.count + 1 }));
    store.setState((state) => state);
    store.setState((state) => ({ count: state.count + 1 }));
    unsubscribe();
    store.setState((state) => ({ count: state.count + 1 }));

    expect(store.getState()).toEqual({ count: 3 });
    expect(snapshots).toEqual([1, 2]);
  });
});
