import { describe, expect, it } from "vitest";

import { resolveProviderCapabilityEntry } from "../../../src/llm/capabilities.js";
import {
  META_MUSE_WONDER_MODEL,
  isRegisteredMetaChatModel,
  metaModelUsesResponsesApi,
} from "../../../src/llm/registry/meta-models.js";
import { resolveProviderStructuredOutputMode } from "../../../src/llm/structured-output.js";

describe("isRegisteredMetaChatModel / metaModelUsesResponsesApi", () => {
  it.each([
    [undefined, false, false],
    ["", false, false],
    ["   ", false, false],
    ["llama-3.3", false, false],
    ["muse-glimmer-30b", false, false],
    ["muse-spark-1.3", true, false],
    ["muse-spark-1.3-contributor", true, false],
    ["muse-spark-1.2", true, false],
    ["muse-spark-1.2-contributor", true, false],
    ["muse-spark-1.1", true, false],
    ["muse-spark-1.3-unverified", false, false],
    ["muse-spark-2.0", false, false],
    ["muse-wonder-1.0", true, true],
    // A later Wonder id still uses Responses; capabilities stay conservative.
    ["muse-wonder-1.1", false, true],
    // Wonder Full is not a Model API SKU, but the family still routes to Responses.
    ["muse-wonder-full-1.0", false, true],
    ["meta/muse-wonder-1.0", true, true],
    ["meta/muse-spark-1.3", true, false],
    ["provider/muse-wonder-1.1", false, true],
    [" muse-wonder-1.0 ", true, true],
    ["muse-wonder-1.0/extra", false, false],
  ] as const)(
    "%j → registered=%s responses=%s",
    (model, registered, responses) => {
      expect(isRegisteredMetaChatModel(model)).toBe(registered);
      expect(metaModelUsesResponsesApi(model)).toBe(responses);
    },
  );

  it("exports the Model API Wonder id the catalog registers", () => {
    expect(META_MUSE_WONDER_MODEL).toBe("muse-wonder-1.0");
    expect(isRegisteredMetaChatModel(META_MUSE_WONDER_MODEL)).toBe(true);
    expect(metaModelUsesResponsesApi(META_MUSE_WONDER_MODEL)).toBe(true);
  });
});

describe("capability and structured-output consequences", () => {
  it("grants image, structured output, and effort only to registered Muse chat ids", () => {
    expect(resolveProviderCapabilityEntry({ provider: "meta", model: "muse-wonder-1.0" }))
      .toMatchObject({
        supportsImageInput: true,
        supportsStructuredOutput: true,
        supportsStructuredOutputWithTools: true,
        acceptsReasoningEffort: true,
      });
    expect(resolveProviderCapabilityEntry({ provider: "meta", model: "muse-spark-1.3" }))
      .toMatchObject({
        supportsImageInput: true,
        supportsStructuredOutput: true,
        acceptsReasoningEffort: true,
      });
    for (const model of ["muse-wonder-1.1", "muse-wonder-full-1.0", "muse-spark-2.0"]) {
      expect(
        resolveProviderCapabilityEntry({ provider: "meta", model }),
        model,
      ).toMatchObject({
        supportsImageInput: false,
        supportsStructuredOutput: false,
        supportsStructuredOutputWithTools: false,
        acceptsReasoningEffort: false,
      });
    }
  });

  it("selects structured output only on the registered model's API surface", () => {
    expect(resolveProviderStructuredOutputMode({
      provider: "meta",
      model: "muse-wonder-1.0",
      api: "responses",
    })).toBe("native_text_format");
    expect(resolveProviderStructuredOutputMode({
      provider: "meta",
      model: "muse-spark-1.3",
      api: "chat_completions",
    })).toBe("chat_response_format");
    expect(resolveProviderStructuredOutputMode({
      provider: "meta",
      model: "muse-wonder-1.0",
      api: "chat_completions",
    })).toBe("unsupported");
    expect(resolveProviderStructuredOutputMode({
      provider: "meta",
      model: "muse-spark-1.3",
      api: "responses",
    })).toBe("unsupported");
    // Unregistered Wonder still uses Responses, but has no reviewed schema contract.
    expect(resolveProviderStructuredOutputMode({
      provider: "meta",
      model: "muse-wonder-1.1",
      api: "responses",
    })).toBe("unsupported");
    expect(resolveProviderStructuredOutputMode({
      provider: "meta",
      model: "muse-wonder-full-1.0",
      api: "responses",
    })).toBe("unsupported");
  });
});
