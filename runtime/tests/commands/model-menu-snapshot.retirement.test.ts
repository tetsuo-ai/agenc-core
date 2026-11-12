import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { modelCapabilityTags } from "../../src/commands/model-capability-tags.js";
import { modelMenuFallback, readModelMenuSnapshot } from "../../src/commands/model-menu-snapshot.js";
import { modelCommand } from "../../src/commands/model.js";
import { providerCommand, switchProviderModel } from "../../src/commands/provider.js";
import { readProvidersHubModels } from "../../src/commands/providers-hub-snapshot.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import { resolveHomeContext } from "../../src/config/home.js";
import { OPENROUTER_CATALOG_FALLBACK_NOTE, openRouterCatalogFor } from "../../src/llm/registry/openrouter-live-catalog.js";
import { OPENROUTER_MODEL_IDS } from "../../src/llm/registry/openrouter-model-ids.js";
import { clearPublishedModelCatalogs } from "../../src/llm/registry/published-model-catalog.js";
import { recordPublishedModelCosts } from "../../src/llm/registry/published-model-costs.js";

const homes: string[] = [];
afterEach(() => {
  clearPublishedModelCatalogs();
  recordPublishedModelCosts("openrouter", new Map());
  vi.useRealTimers();
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

const at = (day: string, time = "12:00:00.000"): Date => new Date(`${day}T${time}Z`);

// Bundled rows of the 2026-10-20 snapshot (issue #3447).
const MODEL = "z-ai/glm-4.5";
const DATE = "2026-12-31";
const REFUSAL = `OpenRouter retired '${MODEL}' on ${DATE}. Pick another model.`;
const RETIRED_BY_2026_11_12 = [
  ["poolside/laguna-s-2.1", "2026-10-31"],
  ["poolside/laguna-s-2.1:free", "2026-10-31"],
  ["poolside/laguna-xs-2.1", "2026-10-31"],
  ["poolside/laguna-xs-2.1:free", "2026-10-31"],
  ["bytedance-seed/seed-1.6", "2026-11-11"],
  ["bytedance-seed/seed-1.6-flash", "2026-11-11"],
  ["bytedance-seed/seed-2.0-code", "2026-11-11"],
] as const;
const RETIRING_2026_12_31 = ["dots-studio/dots-3-note-preview:free", MODEL];

interface Scene {
  readonly provider?: string;
  readonly model?: string;
  readonly config?: unknown;
}

/** A session with its own empty home: OpenRouter's list is the bundled one until a test loads another. */
function context(scene: Scene = {}): SlashCommandContext & { readonly home: string } {
  const path = mkdtempSync(join(tmpdir(), "retired-models-"));
  homes.push(path);
  const environment = { AGENC_HOME: path };
  const session = {
    state: { unsafePeek: () => ({ sessionConfiguration: {
      provider: { slug: scene.provider ?? "openrouter" },
      collaborationMode: { model: scene.model ?? "x-ai/grok-4.5" },
    }, history: [] }) },
    activeTurn: { unsafePeek: () => null },
    pendingProviderSwitch: null as unknown,
    setPendingProviderSwitch(next: unknown) { this.pendingProviderSwitch = next; },
    services: { providerEnvironment: environment, configStore: {
      homeContext: resolveHomeContext(environment, { platformHome: path }),
      current: () => scene.config ?? { providers: { openrouter: { zero_data_retention: false } } },
    } },
  };
  return { argsRaw: "", cwd: path, home: path, session } as unknown as SlashCommandContext & { readonly home: string };
}

/** The OpenRouter models the `/model` listing offers at `now`. */
const menuModels = (ctx: SlashCommandContext, now: Date): readonly string[] =>
  readModelMenuSnapshot(ctx, { now }).rows
    .filter((row) => row.provider === "openrouter" && row.selectable)
    .map((row) => row.displayModel);
/** The OpenRouter models the providers hub offers at `now`. */
const hubModels = (ctx: SlashCommandContext, now: Date): readonly string[] =>
  readProvidersHubModels(ctx, "openrouter", { now }).map((row) => row.model);

const text = (result: Awaited<ReturnType<typeof modelCommand.execute>>): string =>
  result.kind === "text" ? result.text : JSON.stringify(result);

const liveRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, context_length: 200000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" },
  ...extra,
});

describe("a bundled model with a retirement date", () => {
  test("the day before its date it is offered, tagged \"retires\" and selectable", async () => {
    const before = at("2026-12-30", "23:59:59.999");
    const ctx = context();
    expect(menuModels(ctx, before)).toContain(MODEL);
    expect(readProvidersHubModels(ctx, "openrouter", { now: before }).find((row) => row.model === MODEL)?.tags)
      .toContain(`retires ${DATE}`);
    expect(modelCapabilityTags("openrouter", MODEL, before)).toContain(`retires ${DATE}`);

    vi.useFakeTimers({ toFake: ["Date"], now: before });
    expect(text(await modelCommand.execute({ ...ctx, argsRaw: MODEL }))).toContain(`Model switched to "${MODEL}"`);
    expect((ctx.session as unknown as { pendingProviderSwitch: unknown }).pendingProviderSwitch)
      .toEqual({ provider: "openrouter", model: MODEL });
  });

  test.each([
    ["on its date", at(DATE, "00:00:00.000")],
    ["after its date", at("2027-03-01")],
  ])("%s it is not offered, is tagged \"retired\" and selection is refused with the date", async (_when, now) => {
    const ctx = context();
    const snapshot = readModelMenuSnapshot(ctx, { now });
    expect(menuModels(ctx, now)).not.toContain(MODEL);
    expect(hubModels(ctx, now)).not.toContain(MODEL);
    // All nine dated rows of the snapshot are past their date by then.
    expect(snapshot.providerCounts.openrouter).toBe(OPENROUTER_MODEL_IDS.length - 9);
    expect(snapshot.catalogNote).toBe(OPENROUTER_CATALOG_FALLBACK_NOTE);
    expect(modelMenuFallback(snapshot)).not.toContain(`openrouter:${MODEL} `);
    expect(modelMenuFallback(snapshot)).toContain("openrouter:z-ai/glm-4.5-air ");
    expect(modelCapabilityTags("openrouter", MODEL, now)).toContain(`retired ${DATE}`);

    vi.useFakeTimers({ toFake: ["Date"], now });
    // Typed by name, with or without the provider, from this or another provider.
    for (const typed of [MODEL, `openrouter:${MODEL}`]) {
      expect(text(await modelCommand.execute({ ...ctx, argsRaw: typed }))).toBe(`Model switch blocked: ${REFUSAL}`);
    }
    const onGrok = context({ provider: "grok", model: "grok-4.6" });
    expect(text(await modelCommand.execute({ ...onGrok, argsRaw: MODEL }))).toBe(`Model switch blocked: ${REFUSAL}`);
    // The providers hub chooses a model through this call.
    expect(await switchProviderModel(onGrok, "openrouter", MODEL)).toMatchObject({
      applied: false, unchanged: false, message: `Provider switch to "openrouter" blocked: ${REFUSAL}`,
    });
    expect((ctx.session as unknown as { pendingProviderSwitch: unknown }).pendingProviderSwitch).toBeNull();
    expect((onGrok.session as unknown as { pendingProviderSwitch: unknown }).pendingProviderSwitch).toBeNull();
  });

  test("the provider's live list wins: a model it lists is offered and accepted past the bundled date", async () => {
    const late = at("2027-03-01");
    const ctx = context();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ data: [
      liveRow("x-ai/grok-4.5"),
      // Both still listed: one with the date its bundled row has, one with no date.
      liveRow(MODEL, { expiration_date: DATE }),
      liveRow("dots-studio/dots-3-note-preview:free"),
    ] })));
    const catalog = openRouterCatalogFor({ home: ctx.home, fetchImpl });
    expect(hubModels(ctx, late)).not.toContain(MODEL);
    expect((await catalog.refresh()).source).toBe("live");

    expect(hubModels(ctx, late)).toEqual(["x-ai/grok-4.5", MODEL, "dots-studio/dots-3-note-preview:free"]);
    expect(menuModels(ctx, late)).toEqual(hubModels(ctx, late));
    const rows = readProvidersHubModels(ctx, "openrouter", { now: late });
    // The tag still says what the provider's own row says about the date.
    expect(rows.find((row) => row.model === MODEL)?.tags).toBe(`tools · retired ${DATE}`);
    expect(rows.find((row) => row.model === "dots-studio/dots-3-note-preview:free")?.tags).toBe("tools · free");

    vi.useFakeTimers({ toFake: ["Date"], now: late });
    expect(text(await modelCommand.execute({ ...ctx, argsRaw: MODEL }))).toContain(`Model switched to "${MODEL}"`);
    // A model the live list dropped is refused: with its date when the
    // bundled row has one that has passed, as unlisted otherwise.
    expect(text(await modelCommand.execute({ ...ctx, argsRaw: "bytedance-seed/seed-1.6" })))
      .toBe("Model switch blocked: OpenRouter retired 'bytedance-seed/seed-1.6' on 2026-11-11. Pick another model.");
    expect(text(await modelCommand.execute({ ...ctx, argsRaw: "openai/gpt-6-sol" })))
      .toContain("does not list model 'openai/gpt-6-sol'");
  });

  test("an entry with no date is offered and selectable at any time", async () => {
    const farFuture = at("9999-12-31");
    const ctx = context();
    expect(menuModels(ctx, farFuture)).toContain("z-ai/glm-4.5-air");
    expect(modelCapabilityTags("openrouter", "z-ai/glm-4.5-air", farFuture)).not.toMatch(/retire/u);
    vi.useFakeTimers({ toFake: ["Date"], now: farFuture });
    expect(text(await modelCommand.execute({ ...ctx, argsRaw: "z-ai/glm-4.5-air" })))
      .toContain("Model switched to \"z-ai/glm-4.5-air\"");
  });
});

describe("a session or a configuration that is on a retired model", () => {
  const late = at("2027-03-01");

  test("the session's own model stays listed, marked in use and tagged \"retired\"", async () => {
    const ctx = context({ model: MODEL });
    const snapshot = readModelMenuSnapshot(ctx, { now: late });
    expect(snapshot.rows[snapshot.activeIndex]).toMatchObject({
      provider: "openrouter", displayModel: MODEL, status: "current", selectable: true, retiredOn: DATE,
    });
    expect(modelMenuFallback(snapshot)).toContain(`* openrouter:${MODEL} (active session model, retired ${DATE})`);
    // No other row is retired, and before its date this one is not either.
    expect(snapshot.rows.filter((entry) => entry.retiredOn !== undefined)).toHaveLength(1);
    expect(modelMenuFallback(readModelMenuSnapshot(ctx, { now: at("2026-12-30") })))
      .toContain(`* openrouter:${MODEL} (active session model)`);
    const row = readProvidersHubModels(ctx, "openrouter", { now: late }).find((entry) => entry.model === MODEL);
    expect(row).toMatchObject({ current: true });
    expect(row?.tags).toContain(`retired ${DATE}`);
    // Every other retired row is still left out.
    expect(hubModels(ctx, late)).not.toContain("bytedance-seed/seed-1.6");

    vi.useFakeTimers({ toFake: ["Date"], now: late });
    // The way off a retired model is open; the way back is not.
    expect(text(await modelCommand.execute({ ...ctx, argsRaw: "x-ai/grok-4.5" })))
      .toContain("Model switched to \"x-ai/grok-4.5\"");
    expect(text(await modelCommand.execute({ ...ctx, argsRaw: MODEL }))).toBe(`Model switch blocked: ${REFUSAL}`);
  });

  test("a saved default that is retired is not offered, and choosing it again is refused", async () => {
    const config = { providers: { openrouter: { default_model: MODEL, zero_data_retention: false } } };
    const ctx = context({ provider: "grok", model: "grok-4.6", config });
    // While its date is ahead the saved default is listed as the configured model.
    expect(readModelMenuSnapshot(ctx, { now: at("2026-12-30") }).rows
      .find((row) => row.provider === "openrouter" && row.displayModel === MODEL))
      .toMatchObject({ status: "configured", selectable: true });
    expect(menuModels(ctx, late)).not.toContain(MODEL);
    expect(hubModels(ctx, late)).not.toContain(MODEL);

    vi.useFakeTimers({ toFake: ["Date"], now: late });
    const blocked = `Provider switch to "openrouter" blocked: ${REFUSAL}`;
    expect(text(await providerCommand.execute({ ...ctx, argsRaw: "openrouter" }))).toBe(blocked);
    expect(text(await providerCommand.execute({ ...ctx, argsRaw: `openrouter ${MODEL}` }))).toBe(blocked);
    // Naming another model switches provider.
    expect(text(await providerCommand.execute({ ...ctx, argsRaw: "openrouter x-ai/grok-4.5" })))
      .toContain("Provider switched to \"openrouter\"");
    expect((ctx.session as unknown as { pendingProviderSwitch: unknown }).pendingProviderSwitch)
      .toEqual({ provider: "openrouter", model: "x-ai/grok-4.5" });
  });
});

describe("the bundled snapshot with the clock at 2026-11-12", () => {
  const today = at("2026-11-12");

  test("offers none of the seven retired models and still offers the two dated 2026-12-31", () => {
    const ctx = context();
    const snapshot = readModelMenuSnapshot(ctx, { now: today });
    const menu = menuModels(ctx, today);
    const hub = hubModels(ctx, today);
    const listing = modelMenuFallback(snapshot);
    for (const [model] of RETIRED_BY_2026_11_12) {
      expect(menu, model).not.toContain(model);
      expect(hub, model).not.toContain(model);
      expect(listing, model).not.toContain(`openrouter:${model} `);
    }
    for (const model of RETIRING_2026_12_31) {
      expect(menu, model).toContain(model);
      expect(hub, model).toContain(model);
      expect(listing, model).toContain(`openrouter:${model} `);
    }
    expect(snapshot.providerCounts.openrouter).toBe(OPENROUTER_MODEL_IDS.length - RETIRED_BY_2026_11_12.length);
    expect(hub).toHaveLength(OPENROUTER_MODEL_IDS.length - RETIRED_BY_2026_11_12.length);
    expect(readProvidersHubModels(ctx, "openrouter", { now: today }).filter((row) => row.tags?.includes("retire")))
      .toEqual(RETIRING_2026_12_31.map((model) => expect.objectContaining({
        model, tags: expect.stringContaining(`retires ${DATE}`),
      })));
  });

  test("without a clock the picker reads the system time", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: today });
    const ctx = context();
    expect(readModelMenuSnapshot(ctx).providerCounts.openrouter).toBe(OPENROUTER_MODEL_IDS.length - 7);
    expect(readProvidersHubModels(ctx, "openrouter")).toHaveLength(OPENROUTER_MODEL_IDS.length - 7);
    expect(modelCapabilityTags("openrouter", "bytedance-seed/seed-1.6")).toContain("retired 2026-11-11");
    expect(modelCapabilityTags("openrouter", MODEL)).toContain(`retires ${DATE}`);
  });

  test.each(RETIRED_BY_2026_11_12)("refuses /model %s, naming %s", async (model, date) => {
    vi.useFakeTimers({ toFake: ["Date"], now: today });
    const ctx = context();
    expect(text(await modelCommand.execute({ ...ctx, argsRaw: model })))
      .toBe(`Model switch blocked: OpenRouter retired '${model}' on ${date}. Pick another model.`);
    expect((ctx.session as unknown as { pendingProviderSwitch: unknown }).pendingProviderSwitch).toBeNull();
  });

  test.each(RETIRING_2026_12_31)("accepts /model %s", async (model) => {
    vi.useFakeTimers({ toFake: ["Date"], now: today });
    expect(text(await modelCommand.execute({ ...context(), argsRaw: model }))).toContain(`Model switched to "${model}"`);
  });
});
