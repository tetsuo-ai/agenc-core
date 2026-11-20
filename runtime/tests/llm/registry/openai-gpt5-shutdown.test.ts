import { afterEach, describe, expect, test, vi } from "vitest";

import { resolveCanonicalStartupSelection } from "../../../src/bin/startup-selection.js";
import { modelCapabilityTags } from "../../../src/commands/model-capability-tags.js";
import { retiredModelNotice } from "../../../src/llm/model-catalog-selection.js";
import {
  findBundledModelCatalogEntry,
  resolveRegisteredModelCatalogEntry,
} from "../../../src/llm/registry/model-catalog.js";
import { BUILT_IN_PROVIDER_MODEL_CATALOG } from "../../../src/llm/registry/provider-info.js";
import { resolveProviderModelSelection } from "../../../src/session/provider-model-selection.js";
import { takeTuiStartupNotices } from "../../../src/tui/startup-notices.js";

const at = (day: string, time = "12:00:00.000"): Date => new Date(`${day}T${time}Z`);
const LAST_DAY = at("2026-12-10", "23:59:59.999");
const SHUTDOWN = at("2026-12-11", "00:00:00.000");
const ON_DEEPSEEK = { provider: "deepseek", model: "deepseek-flash" };
const notice = (model: string) => `OpenAI retired '${model}' on 2026-12-11. Pick another model.`;

/**
 * developers.openai.com/api/docs/deprecations, read 2026-11-20 (job
 * w21-coremodels): OpenAI shuts these down on 2026-12-11, each with its
 * dated snapshot. o3 and o3-2025-04-16 were dated in #3619.
 */
const SHUT_DOWN = ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "o3-pro"] as const;
const SNAPSHOTS = [
  "gpt-5-2025-08-07",
  "gpt-5-mini-2025-08-07",
  "gpt-5-nano-2025-08-07",
  "gpt-5-pro-2025-10-06",
  "o3-2025-04-16",
  "o3-pro-2025-06-10",
] as const;

afterEach(() => {
  takeTuiStartupNotices();
  vi.restoreAllMocks();
});

describe("OpenAI's 2026-12-11 shutdowns", () => {
  test.each(SHUT_DOWN)("%s is listed and tagged until its date", (model) => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openai).toContain(model);
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model }))
      .toMatchObject({ model, visibility: "list", retiresOn: "2026-12-11" });
    expect(modelCapabilityTags("openai", model, at("2026-11-20"))).toContain("retires 2026-12-11");
    expect(modelCapabilityTags("openai", model, SHUTDOWN)).toContain("retired 2026-12-11");
  });

  test.each(SHUT_DOWN)("%s is chosen until the date and refused from it on, typed or saved again", (model) => {
    const layer = { model_provider: "openai", model };
    expect(resolveProviderModelSelection({}, ON_DEEPSEEK, layer, {}, { now: LAST_DAY }))
      .toMatchObject({ provider: "openai", model });
    expect(() => resolveProviderModelSelection({}, ON_DEEPSEEK, layer, {}, { now: SHUTDOWN }))
      .toThrow(new Error(notice(model)));
    // A custom endpoint accepts any id, never one OpenAI has retired.
    expect(() => resolveProviderModelSelection({}, ON_DEEPSEEK, layer, { OPENAI_BASE_URL: "https://proxy.example/v1" }, { now: SHUTDOWN }))
      .toThrow(new Error(notice(model)));
  });

  test.each(SNAPSHOTS)("the dated snapshot %s is retired on the same day", (model) => {
    expect(findBundledModelCatalogEntry({ provider: "openai", model }))
      .toMatchObject({ model, retiresOn: "2026-12-11", visibility: "none" });
    expect(retiredModelNotice("openai", model, LAST_DAY)).toBeUndefined();
    expect(retiredModelNotice("openai", model, SHUTDOWN)).toBe(notice(model));
    // A custom endpoint accepts any id, never one OpenAI has retired.
    expect(() => resolveProviderModelSelection({}, ON_DEEPSEEK, { model_provider: "openai", model },
      { OPENAI_BASE_URL: "https://proxy.example/v1" }, { now: SHUTDOWN })).toThrow(new Error(notice(model)));
  });

  test("a saved choice still starts, and its owner is told", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const model of ["gpt-5", "gpt-5-2025-08-07"]) {
      const config = { model_provider: "openai", model };
      expect(resolveCanonicalStartupSelection({ config, env: {}, now: LAST_DAY }).model).toBe(model);
      expect(warning).not.toHaveBeenCalled();
      expect(resolveCanonicalStartupSelection({ config, env: {}, now: SHUTDOWN }).model).toBe(model);
      expect(warning).toHaveBeenLastCalledWith(notice(model));
      expect(takeTuiStartupNotices()).toEqual([{ key: `retired-model:openai/${model}`, text: notice(model) }]);
      warning.mockClear();
    }
  });

  test("the snapshots' dates never reach a capability lookup, and other variants keep no date", () => {
    // The snapshot still borrows its model's contract; only the date row is new.
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model: "gpt-5-2025-08-07" })?.model).toBe("gpt-5");
    for (const model of ["gpt-5-chat-latest", "gpt-5-codex", "gpt-5.1", "gpt-5.5", "o3-mini", "o3-deep-research"]) {
      expect(retiredModelNotice("openai", model, at("2027-06-01")), model).toBeUndefined();
    }
  });
});
