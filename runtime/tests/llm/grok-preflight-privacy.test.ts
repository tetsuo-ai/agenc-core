import { expect, test, vi } from "vitest";
import { GrokProvider } from "../../src/llm/providers/grok/adapter.js";

test.each([{ allowedToolNames: [] }, { allowedToolNames: ["PRIVATE_CANARY_TOOL_NAME"] }])("Grok preflight keeps tool selection diagnostics local: %j", ({ allowedToolNames }) => {
  const fetchImpl = vi.fn<typeof fetch>();
  const provider = new GrokProvider({ model: "grok-4.5", apiKey: "test-only", fetchImpl });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    provider.validateRequest([{ role: "user", content: "PRIVATE_CANARY_PROMPT" }], {
      toolRouting: { allowedToolNames },
      structuredOutput: { schema: { type: "json_schema", name: "test", schema: { type: "object" } } },
    });
    expect(warn).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});
