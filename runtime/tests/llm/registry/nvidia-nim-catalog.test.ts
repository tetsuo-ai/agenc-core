import { describe, expect, it } from "vitest";

import { defaultConfig } from "../../../src/config/schema.js";
import {
  buildProviderModelCatalog,
  resolveProviderModelInput,
  resolveProviderModelLayer,
} from "../../../src/config/provider-model-authority.js";
import { resolveCanonicalStartupSelection } from "../../../src/bin/startup-selection.js";
import { readModelMenuSnapshot } from "../../../src/commands/model-menu-snapshot.js";
import type { SlashCommandContext } from "../../../src/commands/types.js";
import { resolveHomeContext } from "../../../src/config/home.js";
import { resolveProviderModelSelection } from "../../../src/session/provider-model-selection.js";
import { assertModelCatalogSelection } from "../../../src/llm/model-catalog-selection.js";
import { StaticModelsManager } from "../../../src/llm/models-manager.js";
import { resolveReasoningEffort } from "../../../src/llm/reasoning-effort.js";
import {
  deriveFlatCatalog,
  listRegisteredModelCatalogEntries,
  resolveRegisteredModelCatalogEntry,
} from "../../../src/llm/registry/model-catalog.js";
import { resolveNvidiaCurrentModel } from "../../../src/llm/registry/nvidia-current-models.js";
import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../../../src/llm/registry/provider-info.js";

/**
 * Evidence, 2026-10-17: GET https://integrate.api.nvidia.com/v1/models listed 81 models.
 * 35 of the 115 ids this catalog used to offer were among them. A chat call to each of the
 * other 80 answered HTTP 410 (end of life, for example "The model 'openai/gpt-oss-120b' has
 * reached its end of life on 2026-09-03T08:00:00Z and is no longer available.") or HTTP 404.
 */
const LISTED = [
  "nvidia/cosmos-reason2-8b",
  "meta/codellama-70b",
  "bigcode/starcoder2-15b",
  "mistralai/codestral-22b-instruct-v0.1",
  "deepseek-ai/deepseek-coder-6.7b-instruct",
  "google/codegemma-7b",
  "google/codegemma-1.1-7b",
  "ibm/granite-34b-code-instruct",
  "ibm/granite-8b-code-instruct",
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "nvidia/llama-3.1-nemotron-51b-instruct",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "nvidia/nemotron-4-340b-instruct",
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/llama3-chatqa-1.5-70b",
  "meta/llama-3.2-90b-vision-instruct",
  "meta/llama-3.2-11b-vision-instruct",
  "google/gemma-4-31b-it",
  "google/gemma-3-12b-it",
  "google/gemma-3-4b-it",
  "mistralai/mistral-large-2-instruct",
  "mistralai/mistral-large",
  "mistralai/mistral-7b-instruct-v0.3",
  "ibm/granite-3.0-8b-instruct",
  "ibm/granite-3.0-3b-a800m-instruct",
  "databricks/dbrx-instruct",
  "01-ai/yi-large",
  "ai21labs/jamba-1.5-large-instruct",
  "writer/palmyra-creative-122b",
  "writer/palmyra-fin-70b-32k",
  "writer/palmyra-med-70b",
  "writer/palmyra-med-70b-32k",
  "moonshotai/kimi-k2.6",
  "meta/muse-glimmer-30b",
  "openai/gpt-oss-20b",
] as const;

const RETIRED = [
  "openai/gpt-oss-120b",
  "microsoft/phi-4-mini-flash-reasoning",
  "qwen/qwen3-next-80b-a3b-thinking",
  "deepseek-ai/deepseek-r1-distill-qwen-32b",
  "deepseek-ai/deepseek-r1-distill-qwen-14b",
  "deepseek-ai/deepseek-r1-distill-qwen-7b",
  "deepseek-ai/deepseek-r1-distill-llama-8b",
  "qwen/qwq-32b",
  "bigcode/starcoder2-7b",
  "mistralai/mamba-codestral-7b-v0.1",
  "qwen/qwen2.5-coder-32b-instruct",
  "qwen/qwen2.5-coder-7b-instruct",
  "qwen/qwen3-coder-480b-a35b-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "nvidia/nemotron-3-nano-30b-a3b",
  "nvidia/nemotron-mini-4b-instruct",
  "nvidia/llama-3.1-nemotron-nano-8b-v1",
  "nvidia/llama-3.1-nemotron-nano-4b-v1.1",
  "nvidia/llama3-chatqa-1.5-8b",
  "meta/llama-3.1-405b-instruct",
  "meta/llama-3.1-70b-instruct",
  "meta/llama-3.1-8b-instruct",
  "meta/llama-3.2-3b-instruct",
  "meta/llama-3.2-1b-instruct",
  "meta/llama-3.3-70b-instruct",
  "meta/llama-4-maverick-17b-128e-instruct",
  "meta/llama-4-scout-17b-16e-instruct",
  "google/gemma-3-27b-it",
  "google/gemma-3-1b-it",
  "google/gemma-3n-e4b-it",
  "google/gemma-3n-e2b-it",
  "google/gemma-2-27b-it",
  "google/gemma-2-9b-it",
  "google/gemma-2-2b-it",
  "mistralai/mistral-large-3-675b-instruct-2512",
  "mistralai/mistral-medium-3-instruct",
  "mistralai/mistral-small-4-119b-2603",
  "mistralai/mistral-small-3.1-24b-instruct-2503",
  "mistralai/mistral-small-24b-instruct",
  "mistralai/mistral-7b-instruct-v0.2",
  "mistralai/mixtral-8x22b-instruct-v0.1",
  "mistralai/mixtral-8x7b-instruct-v0.1",
  "mistralai/mistral-nemotron",
  "mistralai/ministral-14b-instruct-2512",
  "mistralai/devstral-2-123b-instruct-2512",
  "mistralai/magistral-small-2506",
  "mistralai/mathstral-7b-v0.1",
  "microsoft/phi-4-multimodal-instruct",
  "microsoft/phi-4-mini-instruct",
  "microsoft/phi-3.5-mini-instruct",
  "microsoft/phi-3-small-128k-instruct",
  "microsoft/phi-3-small-8k-instruct",
  "microsoft/phi-3-medium-128k-instruct",
  "microsoft/phi-3-medium-4k-instruct",
  "microsoft/phi-3-mini-128k-instruct",
  "microsoft/phi-3-mini-4k-instruct",
  "qwen/qwen3.5-397b-a17b",
  "qwen/qwen3.5-122b-a10b",
  "qwen/qwen3-next-80b-a3b-instruct",
  "qwen/qwen2.5-7b-instruct",
  "qwen/qwen2-7b-instruct",
  "qwen/qwen3-32b",
  "qwen/qwen3-8b",
  "deepseek-ai/deepseek-r1",
  "deepseek-ai/deepseek-v3",
  "deepseek-ai/deepseek-v3.2",
  "deepseek-ai/deepseek-v3.1-terminus",
  "deepseek-ai/deepseek-v3.1",
  "ibm/granite-3.3-8b-instruct",
  "ai21labs/jamba-1.5-mini-instruct",
  "z-ai/glm5",
  "z-ai/glm4.7",
  "minimaxai/minimax-m2.5",
  "moonshotai/kimi-k2.5",
  "moonshotai/kimi-k2-instruct",
  "moonshotai/kimi-k2-thinking",
  "moonshotai/kimi-k2.5-thinking",
  "moonshotai/kimi-k2-instruct-0905",
  "moonshotai/kimi-k3",
] as const;

// moonshotai/kimi-k3 is the one retired id with a registry row. NVIDIA ended it on
// 2026-10-15, so its row stays for old sessions and the picker no longer offers it.
const RETIRED_WITH_ROW = "moonshotai/kimi-k3";
const NEW_DEFAULT = "nvidia/nemotron-3-super-120b-a12b";
const OLD_DEFAULT = "nvidia/llama-3.1-nemotron-70b-instruct";

const nimCatalog = (): readonly string[] => BUILT_IN_PROVIDER_MODEL_CATALOG["nvidia-nim"];

// The real /model menu for a session whose provider is nvidia-nim and whose model is `model`.
function menuContext(model: string): SlashCommandContext {
  const config = { ...defaultConfig(), model, model_provider: "nvidia-nim" };
  const configStore = {
    current: () => config,
    homeContext: resolveHomeContext({ AGENC_HOME: "/home/test" }),
  };
  const session = {
    state: {
      unsafePeek: () => ({
        sessionConfiguration: {
          provider: { slug: "nvidia-nim" },
          collaborationMode: { model },
        },
        history: [],
      }),
    },
    services: { configStore, providerService: { environment: () => ({}) } },
  };
  return { session, argsRaw: "", cwd: "/ws", home: "/home/test", configStore } as unknown as SlashCommandContext;
}

describe("NVIDIA NIM picker after NVIDIA retired models (2026-10-17)", () => {
  it("pins 35 listed and 80 retired ids that never overlap", () => {
    expect(LISTED).toHaveLength(35);
    expect(RETIRED).toHaveLength(80);
    expect(new Set(LISTED).size).toBe(35);
    expect(new Set(RETIRED).size).toBe(80);
    expect(LISTED.filter((model) => (RETIRED as readonly string[]).includes(model))).toEqual([]);
  });

  it("offers exactly the ids NVIDIA still lists, once each", () => {
    const models = nimCatalog();
    expect(new Set(models).size).toBe(models.length);
    expect([...models].sort()).toEqual([...LISTED].sort());
    expect([...(buildProviderModelCatalog(defaultConfig())["nvidia-nim"] ?? [])].sort())
      .toEqual([...LISTED].sort());
  });

  it("offers none of the retired ids", () => {
    const offered = new Set(nimCatalog());
    expect(RETIRED.filter((model) => offered.has(model))).toEqual([]);
  });

  it("keeps the NIM default among the listed ids", () => {
    // nvidia/llama-3.1-nemotron-70b-instruct is still listed, but a chat call to it answered
    // HTTP 404 ("Function ... Not found for account") on every attempt, so it is no longer the default.
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS["nvidia-nim"]).toBe(NEW_DEFAULT);
    expect(LISTED).toContain(NEW_DEFAULT);
    expect(LISTED).toContain(OLD_DEFAULT);
    expect(nimCatalog()).toContain(NEW_DEFAULT);
  });

  it("hides the retired Kimi K3 row from every list but keeps it registered", () => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "nvidia-nim", model: RETIRED_WITH_ROW }))
      .toMatchObject({ provider: "nvidia-nim", model: RETIRED_WITH_ROW, visibility: "none" });
    expect(listRegisteredModelCatalogEntries("nvidia-nim").map((entry) => entry.model))
      .toContain(RETIRED_WITH_ROW);
    expect(deriveFlatCatalog()["nvidia-nim"]).not.toContain(RETIRED_WITH_ROW);
    expect(nimCatalog()).not.toContain(RETIRED_WITH_ROW);
    // The hosted wire contract stays for old sessions.
    expect(resolveNvidiaCurrentModel(RETIRED_WITH_ROW)).toMatchObject({ vision: true, efforts: ["low", "high", "max"] });
    expect(resolveReasoningEffort({ provider: "nvidia-nim", model: RETIRED_WITH_ROW }).levels)
      .toEqual(["low", "high", "max"]);
  });

  it("lists only the listed ids as selectable NIM models in the models manager", async () => {
    const manager = new StaticModelsManager({ config: defaultConfig(), fallbackProvider: "nvidia-nim" });
    const picker = (await manager.listModels()).filter((model) => model.provider === "nvidia-nim");
    expect(picker.map((model) => model.slug).sort()).toEqual([...LISTED].sort());
    expect(picker.every((model) => model.showInPicker === true)).toBe(true);
  });

  it("offers exactly the listed ids in the /model menu", () => {
    const snapshot = readModelMenuSnapshot(menuContext(NEW_DEFAULT));
    const rows = snapshot.rows.filter((row) => row.provider === "nvidia-nim");
    expect(rows.map((row) => row.model).sort()).toEqual([...LISTED].sort());
    expect(rows.find((row) => row.status === "current")?.model).toBe(NEW_DEFAULT);
  });

  it("still shows the saved retired model as the current row, and no other retired id", () => {
    const snapshot = readModelMenuSnapshot(menuContext("openai/gpt-oss-120b"));
    const rows = snapshot.rows.filter((row) => row.provider === "nvidia-nim");
    expect(rows.map((row) => row.model).sort()).toEqual([...LISTED, "openai/gpt-oss-120b"].sort());
    expect(rows.find((row) => row.model === "openai/gpt-oss-120b")?.status).toBe("current");
  });
});

describe("old NVIDIA NIM sessions that saved a retired model", () => {
  const config = (model: string) => ({ ...defaultConfig(), model_provider: "nvidia-nim", model });

  it("restores the saved provider and model at startup", () => {
    const moved: string[] = [];
    for (const model of RETIRED) {
      const resolved = resolveCanonicalStartupSelection({ env: {}, config: config(model) });
      if (resolved.provider !== "nvidia-nim" || resolved.model !== model) moved.push(model);
    }
    expect(moved).toEqual([]);
  });

  it("keeps the saved pair through profile and config layers", () => {
    const moved: string[] = [];
    for (const model of RETIRED) {
      const layered = resolveProviderModelLayer(defaultConfig(), { model_provider: "nvidia-nim", model });
      if (layered.model_provider !== "nvidia-nim" || layered.model !== model) moved.push(model);
    }
    expect(moved).toEqual([]);
  });

  it("admits the saved pair on a restored switch that skips catalog validation", () => {
    const moved: string[] = [];
    for (const model of RETIRED) {
      const admitted = resolveProviderModelSelection(
        config(model),
        { provider: "nvidia-nim", model },
        { model_provider: "nvidia-nim", model },
        {},
        { validateCatalog: false },
      );
      if (admitted.provider !== "nvidia-nim" || admitted.model !== model) moved.push(model);
    }
    expect(moved).toEqual([]);
  });

  it("resolves the saved model on nvidia-nim even when another provider lists the same id", () => {
    // openai/gpt-oss-120b is also a Groq and OpenRouter id, and qwen/qwen3.5-397b-a17b is an OpenRouter id.
    for (const model of ["openai/gpt-oss-120b", "qwen/qwen3.5-397b-a17b", "meta/llama-3.1-70b-instruct", RETIRED_WITH_ROW]) {
      expect(resolveProviderModelInput(config(model), "nvidia-nim", model)).toEqual({ provider: "nvidia-nim", model });
    }
  });

  it("still returns model info for the saved model", async () => {
    for (const model of ["openai/gpt-oss-120b", "qwen/qwen3.5-397b-a17b", "meta/llama-3.1-70b-instruct"]) {
      const manager = new StaticModelsManager({ config: config(model), fallbackProvider: "nvidia-nim" });
      expect(await manager.getModelInfo(model)).toMatchObject({ slug: model, provider: "nvidia-nim" });
    }
  });

  it("keeps the wire contract of a retired NIM family", () => {
    expect(resolveReasoningEffort({ provider: "nvidia-nim", model: "openai/gpt-oss-120b" }).levels)
      .toEqual(["low", "medium", "high"]);
  });

  it("rejects a retired id typed on hosted NIM and suggests a listed one", () => {
    for (const model of ["openai/gpt-oss-120b", "meta/llama-3.1-70b-instruct"]) {
      expect(() => assertModelCatalogSelection({}, "nvidia-nim", model, {}), model)
        .toThrow(/unknown model .* for provider 'nvidia-nim'.*did you mean/u);
      expect(() => resolveCanonicalStartupSelection({ env: {}, config: config(model), explicitModel: model }), model)
        .toThrow(/unknown model/u);
    }
  });

  it("still admits the retired Kimi K3 by name, like every other hidden registry row", () => {
    expect(() => assertModelCatalogSelection({}, "nvidia-nim", RETIRED_WITH_ROW, {})).not.toThrow();
  });

  it("still accepts a retired id typed against a self-hosted NIM endpoint", () => {
    const env = { NVIDIA_BASE_URL: "http://localhost:8000/v1" };
    for (const model of RETIRED) {
      expect(() => assertModelCatalogSelection({}, "nvidia-nim", model, env), model).not.toThrow();
    }
  });

  it("accepts every listed id typed on hosted NIM", () => {
    for (const model of LISTED) {
      expect(() => assertModelCatalogSelection({}, "nvidia-nim", model, {}), model).not.toThrow();
      expect(resolveProviderModelInput({}, "nvidia-nim", model)).toEqual({ provider: "nvidia-nim", model });
    }
  });
});
