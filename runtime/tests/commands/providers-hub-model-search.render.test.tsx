import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { ProvidersHubView, type ProvidersHubServices } from "./providers-hub.js";
import type {
  ProvidersHubModelRow,
  ProvidersHubRow,
  ProvidersHubSnapshot,
} from "./providers-hub-snapshot.js";
import OPENROUTER_MODELS from "../fixtures/openrouter-models-298.json" with { type: "json" };
import { renderPtyRows } from "../../scripts/check-tui-e2e/harness.mjs";
import { createRoot } from "../tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../tui/state/AppState.js";

const UP = "\u001b[A";
const DOWN = "\u001b[B";
const ESC = "\u001b";
const BACKSPACE = "\u007f";

const openrouter: ProvidersHubRow = {
  provider: "openrouter",
  name: "OpenRouter",
  access: "api-key",
  connection: "current",
  status: "key saved",
  model: OPENROUTER_MODELS[0]!.model,
  keySaved: true,
};
const deepseek: ProvidersHubRow = {
  provider: "deepseek",
  name: "DeepSeek",
  access: "api-key",
  connection: "connected",
  status: "key saved",
  model: "deepseek-flash",
  keySaved: true,
};
const snapshot: ProvidersHubSnapshot = {
  currentProvider: "openrouter",
  currentModel: openrouter.model,
  rows: [openrouter, deepseek],
};

/** The 298 tool-capable OpenRouter models of the 2026-10-20 catalog; the first is in use. */
const openrouterModels: readonly ProvidersHubModelRow[] = OPENROUTER_MODELS.map((row, index) => ({
  model: row.model,
  displayModel: row.model,
  current: index === 0,
  isDefault: false,
  label: row.label,
}));
const deepseekModels: readonly ProvidersHubModelRow[] = [
  { model: "deepseek-flash", displayModel: "deepseek-flash", current: false, isDefault: true },
  { model: "deepseek-pro", displayModel: "deepseek-pro", current: false, isDefault: false },
];

function fakeServices(overrides: Partial<ProvidersHubServices> = {}) {
  return {
    reload: () => snapshot,
    probeLocal: async () => new Set(),
    modelsFor: (provider: string) => (provider === "openrouter" ? openrouterModels : deepseekModels),
    connect: vi.fn(async () => ({ ok: true as const, message: "Key checked and saved." })),
    choose: vi.fn(async () => ({ ok: true as const, message: "saved" })),
    forget: vi.fn(() => ({ ok: true as const, message: "Saved key removed." })),
    signIn: vi.fn(async () => ({ ok: true as const, account: "ana@example.com" })),
    signOut: vi.fn(() => ({ ok: true as const, message: "Signed out." })),
    setAuth: vi.fn(async () => ({ ok: true as const, message: "Saved." })),
    ...overrides,
  } satisfies ProvidersHubServices;
}

async function mount(element: React.ReactNode) {
  const stdin = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (enabled: boolean) => void;
    ref?: () => void;
    unref?: () => void;
  };
  const stdout = new PassThrough() as PassThrough & { columns?: number; rows?: number; isTTY?: boolean };
  stdin.isTTY = true;
  stdin.setRawMode = vi.fn();
  stdin.ref = () => {};
  stdin.unref = () => {};
  stdout.columns = 120;
  stdout.rows = 30;
  stdout.isTTY = true;
  let written = "";
  stdout.on("data", (chunk: Buffer) => {
    written += chunk.toString("utf8");
  });
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  root.render(
    <AppStateProvider initialState={getDefaultAppState()}>{element}</AppStateProvider>,
  );
  await sleep();
  const rows = (): string[] => renderPtyRows(written, { cols: 120, rows: 30 }) as string[];
  return {
    /** The screen as a terminal shows it now, lowercased (popup titles render in capitals). */
    screen: (): string => rows().join("\n").toLowerCase(),
    /** The model ids listed, top to bottom. */
    models: (): string[] =>
      rows().flatMap((line) => {
        const match = /^│\s+(?:▌\s+)?(?:●\s+)?([\w.-]+\/[\w.:/-]+)/u.exec(line);
        return match === null ? [] : [match[1]!];
      }),
    /** The text of the highlighted row. */
    highlighted: (): string | undefined =>
      rows()
        .find((line) => line.includes("▌"))
        ?.replace(/^│\s+▌\s+/u, "")
        .replace(/\s*│$/u, "")
        .trim()
        .toLowerCase(),
    async press(...keys: string[]) {
      for (const key of keys) {
        stdin.write(key);
        await sleep();
      }
    },
    unmount: () => root.unmount(),
  };
}

function sleep(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openOpenRouter(services = fakeServices()) {
  return mount(
    <ProvidersHubView initial={snapshot} initialProvider="openrouter" services={services} onDone={() => {}} />,
  );
}

describe("model search on the providers screen", () => {
  it("keeps search usable during refresh, shows all 468 models and explains a no-tools choice", async () => {
    let models = openrouterModels;
    let complete!: (result: {}) => void;
    const services = fakeServices({
      modelsFor: () => models,
      refreshModels: () => new Promise(resolve => { complete = resolve; }),
    });
    const onDone = vi.fn();
    const screen = await mount(
      <ProvidersHubView initial={snapshot} initialProvider="openrouter" services={services} onDone={onDone} />,
    );
    try {
      expect(screen.screen()).toContain("298 models");
      await screen.press(..."liveonly");
      expect(screen.screen()).toContain("no models match");
      models = [...openrouterModels, ...Array.from({ length: 170 }, (_, index) => ({
        model: `fixture/liveonly-${index}`, displayModel: `fixture/liveonly-${index}`,
        current: false, isDefault: false, tags: "no tools",
      }))];
      complete({});
      await sleep(60);
      expect(screen.screen()).toContain("170 of 468 models");
      await screen.press("\r");
      expect(services.choose).toHaveBeenCalledWith("openrouter", "fixture/liveonly-0");
      expect(screen.screen()).toContain("agent tools will not work with this model");
      expect(onDone).not.toHaveBeenCalled();
    } finally { screen.unmount(); }
  });

  it("shows the search line, the model count and the key rows on a long list before anything is typed", async () => {
    expect(OPENROUTER_MODELS).toHaveLength(298);
    const screen = await openOpenRouter();
    try {
      const first = screen.screen();
      expect(first).toContain("openrouter · 298 models · key saved");
      expect(first).toContain("type to search");
      expect(first).toContain("esc to go back");
      // The key rows stay on screen below the models that scroll.
      expect(first).toContain("replace api key");
      expect(first).toContain("remove saved key");
      expect(first).toMatch(/scroll 1-\d+\/298/u);
      expect(screen.highlighted()).toMatch(/^● +minimax\/minimax-m3\.1-flash:free +in use/u);
    } finally {
      screen.unmount();
    }
  });

  it("filters as you type, ignoring case, and counts the matches out of every model", async () => {
    const screen = await openOpenRouter();
    try {
      await screen.press(..."GemMa");
      const filtered = screen.screen();
      expect(filtered).toContain("openrouter · 6 of 298 models · key saved");
      expect(filtered).toContain("search: gemma");
      expect(filtered).not.toContain("type to search");
      expect(filtered).toContain("esc to clear search");
      expect(filtered).toContain("[esc] clear");
      expect(screen.models()).toEqual([
        "google/gemma-4-26b-a4b-it",
        "google/gemma-4-26b-a4b-it:free",
        "google/gemma-4-31b-it",
        "google/gemma-4-31b-it:free",
        "google/gemma-3-12b-it",
        "google/gemma-3-27b-it",
      ]);
      expect(screen.highlighted()).toBe("google/gemma-4-26b-a4b-it");
    } finally {
      screen.unmount();
    }
  });

  it("lists the exact name first, then names that start with the query, then looser matches", async () => {
    const screen = await openOpenRouter();
    try {
      await screen.press(..."gpt-5");
      expect(screen.screen()).toContain("29 of 298 models");
      const listed = screen.models();
      expect(listed[0]).toBe("openai/gpt-5");
      expect(screen.highlighted()).toBe("openai/gpt-5");
      // Names that start with "gpt-5" follow, in catalog order.
      expect(listed.slice(1, 5)).toEqual([
        "openai/gpt-5.6-luna-pro",
        "openai/gpt-5.6-luna",
        "openai/gpt-5.6-terra-pro",
        "openai/gpt-5.6-terra",
      ]);

      // A query that only matches the catalog label, then one with gaps.
      await screen.press(...Array.from({ length: 5 }, () => BACKSPACE), ..."llama 4");
      expect(screen.models()).toEqual(["meta-llama/llama-4-maverick", "meta-llama/llama-4-scout"]);
      await screen.press(...Array.from({ length: 7 }, () => BACKSPACE), ..."gpt5mini");
      expect(screen.models()).toEqual([
        "openai/gpt-5.4-mini",
        "openai/gpt-5.1-codex-mini",
        "openai/gpt-5-mini",
      ]);
    } finally {
      screen.unmount();
    }
  });

  it("edits the search with backspace and says when nothing matches", async () => {
    const screen = await openOpenRouter();
    try {
      await screen.press(..."gemmaz");
      const none = screen.screen();
      expect(none).toContain("0 of 298 models");
      expect(none).toContain("no models match");
      expect(screen.highlighted()).toBe("no models match");
      expect(screen.models()).toEqual([]);

      await screen.press(BACKSPACE);
      expect(screen.screen()).toContain("search: gemma");
      expect(screen.screen()).toContain("6 of 298 models");

      await screen.press(...Array.from({ length: 5 }, () => BACKSPACE));
      const cleared = screen.screen();
      expect(cleared).toContain("openrouter · 298 models");
      expect(cleared).toContain("type to search");
      expect(cleared).toContain("esc to go back");
    } finally {
      screen.unmount();
    }
  });

  it("clears the search on the first esc and goes back to the providers on the second", async () => {
    const onDone = vi.fn();
    const screen = await mount(
      <ProvidersHubView initial={snapshot} initialProvider="openrouter" services={fakeServices()} onDone={onDone} />,
    );
    try {
      // "q" is part of the search, not a way out.
      await screen.press(..."qwen3-coder");
      expect(screen.screen()).toContain("search: qwen3-coder");
      expect(screen.models()[0]).toBe("qwen/qwen3-coder");

      await screen.press(ESC);
      await sleep(60);
      const cleared = screen.screen();
      expect(cleared).toContain("openrouter · 298 models");
      expect(cleared).toContain("type to search");
      // The cursor stays on the model it was on.
      expect(screen.highlighted()).toBe("qwen/qwen3-coder");

      await screen.press(ESC);
      await sleep(60);
      const providers = screen.screen();
      expect(providers).toContain("providers · 2 connected");
      expect(providers).not.toContain("type to search");
      expect(onDone).not.toHaveBeenCalled();
    } finally {
      screen.unmount();
    }
  });

  it("keeps the key rows at the end of a filtered list and runs them", async () => {
    const services = fakeServices();
    const screen = await openOpenRouter(services);
    try {
      await screen.press(..."gemma");
      const filtered = screen.screen();
      expect(filtered.indexOf("google/gemma-3-27b-it")).toBeLessThan(filtered.indexOf("replace api key"));
      expect(filtered.indexOf("replace api key")).toBeLessThan(filtered.indexOf("remove saved key"));

      // Up from the first match wraps to the last row.
      await screen.press(UP);
      expect(screen.highlighted()).toBe("remove saved key");
      await screen.press("\r");
      expect(services.forget).toHaveBeenCalledWith("openrouter");
      expect(services.choose).not.toHaveBeenCalled();
      // A rebuilt list starts without a search.
      expect(screen.screen()).toContain("type to search");
    } finally {
      screen.unmount();
    }
  });

  it("does nothing on enter when no model matches, and still reaches the key rows", async () => {
    const services = fakeServices();
    const screen = await openOpenRouter(services);
    try {
      await screen.press(..."zzzz", "\r");
      expect(services.choose).not.toHaveBeenCalled();
      expect(screen.screen()).toContain("no models match");

      await screen.press(DOWN);
      expect(screen.highlighted()).toMatch(/web search\s+auto/);
      await screen.press(DOWN);
      expect(screen.highlighted()).toBe("replace api key");
      await screen.press("\r");
      expect(screen.screen()).toContain("openrouter api key");
    } finally {
      screen.unmount();
    }
  });

  it("uses the highlighted match", async () => {
    const services = fakeServices();
    const onDone = vi.fn();
    const screen = await mount(
      <ProvidersHubView initial={snapshot} initialProvider="openrouter" services={services} onDone={onDone} />,
    );
    try {
      await screen.press(..."gemma", DOWN, "\r");
      await sleep(60);
      expect(services.choose).toHaveBeenCalledWith("openrouter", "google/gemma-4-26b-a4b-it:free");
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      screen.unmount();
    }
  });

  it("keeps the middle ellipsis on a long id that matches", async () => {
    const screen = await openOpenRouter();
    try {
      await screen.press(..."omni-30b");
      // nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free is longer than the model column.
      expect(screen.screen()).toMatch(/│\s+▌\s+nvidia\/nemotron-[^\s│]*…[^\s│]*reasoning:free\s/u);
      expect(screen.screen()).toContain("1 of 298 models");
    } finally {
      screen.unmount();
    }
  });

  it("searches a pasted query in one step", async () => {
    const screen = await openOpenRouter();
    try {
      await screen.press("google/gemma-4-31b");
      expect(screen.screen()).toContain("search: google/gemma-4-31b");
      expect(screen.models()).toEqual(["google/gemma-4-31b-it", "google/gemma-4-31b-it:free"]);
    } finally {
      screen.unmount();
    }
  });

  it("keeps the search when the provider's own list replaces the bundled one", async () => {
    let finish: () => void = () => {};
    let refreshed = false;
    const live: readonly ProvidersHubModelRow[] = [
      ...openrouterModels,
      { model: "google/gemma-5-9b-it", displayModel: "google/gemma-5-9b-it", current: false, isDefault: false },
    ];
    const services = fakeServices({
      modelsFor: (provider) => (provider !== "openrouter" ? deepseekModels : refreshed ? live : openrouterModels),
      refreshModels: () =>
        new Promise<{ readonly note?: string }>((resolve) => {
          finish = () => {
            refreshed = true;
            resolve({});
          };
        }),
    });
    const screen = await openOpenRouter(services);
    try {
      await screen.press(..."gemma", DOWN);
      expect(screen.screen()).toContain("6 of 298 models");
      expect(screen.highlighted()).toBe("google/gemma-4-26b-a4b-it:free");

      finish();
      await sleep(60);
      expect(screen.screen()).toContain("search: gemma");
      expect(screen.screen()).toContain("7 of 299 models");
      expect(screen.models()).toContain("google/gemma-5-9b-it");
      expect(screen.highlighted()).toBe("google/gemma-4-26b-a4b-it:free");
    } finally {
      screen.unmount();
    }
  });

  it("keeps a short list as it was, and searches it once something is typed", async () => {
    const screen = await mount(
      <ProvidersHubView
        initial={{ ...snapshot, currentProvider: "deepseek" }}
        initialProvider="deepseek"
        services={fakeServices()}
        onDone={() => {}}
      />,
    );
    try {
      const before = screen.screen();
      // Today's layout: the column headers right under the title, no search line.
      expect(before).toMatch(/deepseek · 2 models · key saved +esc to go back │\n│ +│\n│ +model +capabilities/u);
      expect(before).not.toContain("type to search");
      expect(before).not.toContain("search:");
      expect(before).toContain("[enter] use  [esc] back");

      await screen.press(..."pro");
      const searching = screen.screen();
      expect(searching).toContain("deepseek · 1 of 2 models · key saved");
      expect(searching).toContain("search: pro");
      expect(searching).toContain("deepseek-pro");
      expect(searching).not.toContain("deepseek-flash");
      expect(searching).toContain("replace api key");

      await screen.press(ESC);
      await sleep(60);
      const after = screen.screen();
      expect(after).not.toContain("search:");
      expect(after).not.toContain("type to search");
      expect(after).toContain("deepseek · 2 models · key saved");
    } finally {
      screen.unmount();
    }
  });
});
