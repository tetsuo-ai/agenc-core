import { describe, expect, it } from "vitest";

import { searchModels, type ModelSearchFields } from "./model-search.js";
import OPENROUTER_MODELS from "../fixtures/openrouter-models-298.json" with { type: "json" };

type Model = { readonly id: string; readonly label?: string };

const fields = (model: Model): ModelSearchFields => ({
  ids: [model.id],
  ...(model.label === undefined ? {} : { label: model.label }),
});

const ids = (models: readonly Model[]): readonly string[] => models.map((model) => model.id);

describe("model search", () => {
  it("returns the list as it is for an empty or blank query", () => {
    const models: Model[] = [{ id: "b/two" }, { id: "a/one" }];
    expect(searchModels(models, "", fields)).toBe(models);
    expect(searchModels(models, "   ", fields)).toBe(models);
  });

  it("lists exact, then prefix, then substring, then fuzzy matches, each in list order", () => {
    const models: Model[] = [
      { id: "vendor/gpt-5-mini" }, // prefix of the name after the vendor
      { id: "other/my-gpt-5" }, // substring
      { id: "vendor/g-p-t-x-5" }, // letters in order with gaps
      { id: "vendor/gpt-5" }, // exact name after the vendor
      { id: "gpt-5-pro" }, // prefix of the whole id
      { id: "vendor/unrelated" },
      { id: "vendor/GPT-5" }, // exact, any case
    ];
    expect(ids(searchModels(models, "gpt-5", fields))).toEqual([
      "vendor/gpt-5",
      "vendor/GPT-5",
      "vendor/gpt-5-mini",
      "gpt-5-pro",
      "other/my-gpt-5",
      "vendor/g-p-t-x-5",
    ]);
  });

  it("matches the label as well as the id, ignoring case", () => {
    const models: Model[] = [
      { id: "meta-llama/llama-4-scout", label: "Meta: Llama 4 Scout" },
      { id: "x/other", label: "Other" },
    ];
    expect(ids(searchModels(models, "LLAMA 4", fields))).toEqual(["meta-llama/llama-4-scout"]);
    expect(ids(searchModels(models, "meta: llama 4 scout", fields))).toEqual(["meta-llama/llama-4-scout"]);
  });

  it("ignores spaces between the letters of a fuzzy match", () => {
    const models: Model[] = [{ id: "openai/gpt-5-mini" }, { id: "openai/gpt-4o" }];
    expect(ids(searchModels(models, "gpt 5 mini", fields))).toEqual(["openai/gpt-5-mini"]);
    expect(ids(searchModels(models, "gpt5mini", fields))).toEqual(["openai/gpt-5-mini"]);
  });

  it("returns nothing when no model matches", () => {
    expect(searchModels([{ id: "openai/gpt-5" }], "gemma", fields)).toEqual([]);
  });

  it("ranks the 298 OpenRouter models: the exact name first, then names that start with the query", () => {
    expect(OPENROUTER_MODELS).toHaveLength(298);
    const catalog: Model[] = OPENROUTER_MODELS.map((row) => ({ id: row.model, label: row.label }));
    const gpt5 = ids(searchModels(catalog, "gpt-5", fields));
    expect(gpt5[0]).toBe("openai/gpt-5");
    // Every name that starts with "gpt-5" comes before any looser match.
    const prefixed = gpt5.filter((id) => id.slice(id.lastIndexOf("/") + 1).startsWith("gpt-5"));
    expect(gpt5.slice(1, prefixed.length)).toEqual(prefixed.filter((id) => id !== "openai/gpt-5"));
    expect(ids(searchModels(catalog, "gemma", fields))).toEqual([
      "google/gemma-4-26b-a4b-it",
      "google/gemma-4-26b-a4b-it:free",
      "google/gemma-4-31b-it",
      "google/gemma-4-31b-it:free",
      "google/gemma-3-12b-it",
      "google/gemma-3-27b-it",
    ]);
  });
});
