import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveCanonicalStartupSelection } from "../../src/bin/startup-selection.js";
import { OpenRouterCatalog } from "../../src/llm/registry/openrouter-live-catalog.js";
import { clearPublishedModelCatalogs } from "../../src/llm/registry/published-model-catalog.js";
import { recordPublishedModelCosts } from "../../src/llm/registry/published-model-costs.js";
import { takeTuiStartupNotices } from "../../src/tui/startup-notices.js";

const homes: string[] = [];
afterEach(() => {
  clearPublishedModelCatalogs();
  recordPublishedModelCosts("openrouter", new Map());
  takeTuiStartupNotices();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

const at = (day: string, time = "12:00:00.000"): Date => new Date(`${day}T${time}Z`);
const saved = (model: string) => ({ model_provider: "openrouter", model });
const notice = (model: string, date: string) => `OpenRouter retired '${model}' on ${date}. Pick another model.`;
/** What the TUI is handed to show in its footer once it has mounted (tui/startup-notices.ts). */
const tuiNotice = (model: string, date: string) =>
  ({ key: `retired-model:openrouter/${model}`, text: notice(model, date) });
const silenceWarnings = () => vi.spyOn(console, "warn").mockImplementation(() => {});

/** Leave OpenRouter's list in a home's cache, as an earlier run would have on the day these tests start on. */
const cacheLiveList = (...models: readonly string[]): Promise<string> =>
  cacheLiveListGivenAt(at("2026-11-12", "00:00:00.000"), ...models);

/** The same, for a run that read OpenRouter's list at `given`. */
async function cacheLiveListGivenAt(given: Date, ...models: readonly string[]): Promise<string> {
  const path = mkdtempSync(join(tmpdir(), "startup-retired-"));
  homes.push(path);
  const body = { data: models.map((id) => ({
    id, name: id, context_length: 200000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" },
  })) };
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(body)));
  expect((await new OpenRouterCatalog({ home: path, fetchImpl, now: () => given.getTime() }).refresh()).source)
    .toBe("live");
  // A new process starts with nothing read.
  clearPublishedModelCatalogs();
  return path;
}

describe("a saved model the bundled catalog says is retired", () => {
  test("still starts, and says once that the provider retired it", () => {
    const warning = silenceWarnings();
    const now = at("2026-11-12");
    const config = saved("bytedance-seed/seed-1.6");
    expect(resolveCanonicalStartupSelection({ config, env: {}, now }))
      .toMatchObject({ provider: "openrouter", model: "bytedance-seed/seed-1.6", config });
    expect(warning.mock.calls).toEqual([[notice("bytedance-seed/seed-1.6", "2026-11-11")]]);
    // The interactive TUI draws over that stderr line: it is handed the same text.
    expect(takeTuiStartupNotices()).toEqual([tuiNotice("bytedance-seed/seed-1.6", "2026-11-11")]);
    // The trust preflight and the session each resolve the selection in one
    // process: the notice is not repeated.
    expect(resolveCanonicalStartupSelection({ config, env: {}, now }).model).toBe("bytedance-seed/seed-1.6");
    expect(warning).toHaveBeenCalledTimes(1);
    expect(takeTuiStartupNotices()).toEqual([]);
    // Another retired model is another notice.
    resolveCanonicalStartupSelection({ config: saved("poolside/laguna-xs-2.1:free"), env: {}, now });
    expect(warning).toHaveBeenLastCalledWith(notice("poolside/laguna-xs-2.1:free", "2026-10-31"));
    expect(warning).toHaveBeenCalledTimes(2);
    expect(takeTuiStartupNotices()).toEqual([tuiNotice("poolside/laguna-xs-2.1:free", "2026-10-31")]);
  });

  test("hands the TUI one notice when the selection is resolved twice before it mounts", () => {
    silenceWarnings();
    const now = at("2026-11-12");
    const config = saved("poolside/laguna-s-2.1");
    // The trust preflight, then the TUI's own session context.
    resolveCanonicalStartupSelection({ config, env: {}, now });
    resolveCanonicalStartupSelection({ config, env: {}, now });
    expect(takeTuiStartupNotices()).toEqual([tuiNotice("poolside/laguna-s-2.1", "2026-10-31")]);
  });

  test("starts without a notice the day before its date, with one from its date on", () => {
    const warning = silenceWarnings();
    const config = saved("z-ai/glm-4.5");
    expect(resolveCanonicalStartupSelection({ config, env: {}, now: at("2026-12-30", "23:59:59.999") }).model)
      .toBe("z-ai/glm-4.5");
    expect(warning).not.toHaveBeenCalled();
    expect(takeTuiStartupNotices()).toEqual([]);
    expect(resolveCanonicalStartupSelection({ config, env: {}, now: at("2026-12-31", "00:00:00.000") }).model)
      .toBe("z-ai/glm-4.5");
    expect(warning.mock.calls).toEqual([[notice("z-ai/glm-4.5", "2026-12-31")]]);
    expect(takeTuiStartupNotices()).toEqual([tuiNotice("z-ai/glm-4.5", "2026-12-31")]);
  });

  test("reads the system time when no clock is passed", () => {
    const warning = silenceWarnings();
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-11-12") });
    expect(resolveCanonicalStartupSelection({ config: saved("bytedance-seed/seed-1.6-flash"), env: {} }).model)
      .toBe("bytedance-seed/seed-1.6-flash");
    expect(warning.mock.calls).toEqual([[notice("bytedance-seed/seed-1.6-flash", "2026-11-11")]]);
    // Not yet retired on that day.
    resolveCanonicalStartupSelection({ config: saved("dots-studio/dots-3-note-preview:free"), env: {} });
    expect(warning).toHaveBeenCalledTimes(1);
  });

  test("a model with no date, on any provider, starts without a notice", () => {
    const warning = silenceWarnings();
    const now = at("9999-12-31");
    expect(resolveCanonicalStartupSelection({ config: saved("x-ai/grok-4.5"), env: {}, now }).model).toBe("x-ai/grok-4.5");
    expect(resolveCanonicalStartupSelection({
      config: { model_provider: "deepseek", model: "deepseek-flash" }, env: {}, now,
    }).model).toBe("deepseek-flash");
    expect(warning).not.toHaveBeenCalled();
    expect(takeTuiStartupNotices()).toEqual([]);
  });

  test("the cached live list wins: a model it has starts without a notice", async () => {
    const warning = silenceWarnings();
    const now = at("2026-11-12");
    const metadata = { catalogHome: await cacheLiveList("x-ai/grok-4.5", "bytedance-seed/seed-2.0-code") };
    expect(resolveCanonicalStartupSelection({ config: saved("bytedance-seed/seed-2.0-code"), env: {}, metadata, now }).model)
      .toBe("bytedance-seed/seed-2.0-code");
    expect(warning).not.toHaveBeenCalled();
    expect(takeTuiStartupNotices()).toEqual([]);
    // A retired model that list no longer has still gets its notice.
    resolveCanonicalStartupSelection({ config: saved("poolside/laguna-s-2.1:free"), env: {}, metadata, now });
    expect(warning.mock.calls).toEqual([[notice("poolside/laguna-s-2.1:free", "2026-10-31")]]);
    expect(takeTuiStartupNotices()).toEqual([tuiNotice("poolside/laguna-s-2.1:free", "2026-10-31")]);
  });
});

describe("a cached list from before the saved model's date", () => {
  test("does not hide the notice: the list says nothing about the days since", async () => {
    const warning = silenceWarnings();
    const model = "poolside/laguna-xs-2.1";
    // The last start that read OpenRouter's list was a week before the date,
    // which is the cache every owner of that model has on the first start
    // after it.
    const metadata = { catalogHome: await cacheLiveListGivenAt(at("2026-10-24"), "x-ai/grok-4.5", model) };
    expect(resolveCanonicalStartupSelection({ config: saved(model), env: {}, metadata, now: at("2026-10-30") }).model)
      .toBe(model);
    expect(warning).not.toHaveBeenCalled();
    expect(takeTuiStartupNotices()).toEqual([]);

    expect(resolveCanonicalStartupSelection({ config: saved(model), env: {}, metadata, now: at("2026-11-12") }).model)
      .toBe(model);
    expect(warning.mock.calls).toEqual([[notice(model, "2026-10-31")]]);
    expect(takeTuiStartupNotices()).toEqual([tuiNotice(model, "2026-10-31")]);
  });

  test("does not let a retired model typed with --model through", async () => {
    silenceWarnings();
    const model = "bytedance-seed/seed-2.0-code";
    const stale = { catalogHome: await cacheLiveListGivenAt(at("2026-11-10", "23:59:59.999"), "x-ai/grok-4.5", model) };
    expect(() => resolveCanonicalStartupSelection({
      config: saved(model), env: {}, metadata: stale, explicitModel: model, now: at("2026-11-12"),
    })).toThrow(new Error(notice(model, "2026-11-11")));
    // Read on the date itself, the same list vouches.
    clearPublishedModelCatalogs();
    const fresh = { catalogHome: await cacheLiveListGivenAt(at("2026-11-11", "00:00:00.000"), "x-ai/grok-4.5", model) };
    expect(resolveCanonicalStartupSelection({
      config: saved(model), env: {}, metadata: fresh, explicitModel: model, now: at("2026-11-12"),
    }).model).toBe(model);
  });
});

describe("a retired model typed with --model", () => {
  test("is refused with its date, and accepted the day before", () => {
    const warning = silenceWarnings();
    const model = "poolside/laguna-s-2.1";
    for (const explicitModel of [model, `openrouter:${model}`]) {
      expect(() => resolveCanonicalStartupSelection({
        config: saved(model), env: {}, explicitModel, now: at("2026-10-31", "00:00:00.000"),
      })).toThrow(new Error(notice(model, "2026-10-31")));
      expect(resolveCanonicalStartupSelection({
        config: saved(model), env: {}, explicitModel, now: at("2026-10-30", "23:59:59.999"),
      }).model).toBe(model);
    }
    expect(warning).not.toHaveBeenCalled();
    // A refused start never reaches the TUI: nothing is left for it to show.
    expect(takeTuiStartupNotices()).toEqual([]);
  });

  test("is accepted while the cached live list has it", async () => {
    silenceWarnings();
    const model = "poolside/laguna-xs-2.1";
    const metadata = { catalogHome: await cacheLiveList("x-ai/grok-4.5", model) };
    expect(resolveCanonicalStartupSelection({
      config: saved(model), env: {}, metadata, explicitModel: model, now: at("2026-11-12"),
    }).model).toBe(model);
  });
});
