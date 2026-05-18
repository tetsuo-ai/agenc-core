import { describe, expect, test } from "vitest";

import { generateKeybindingsTemplate } from "./template.js";

describe("keybindings template", () => {
  test("generates valid AgenC keybindings JSON with non-rebindable shortcuts omitted", () => {
    const output = generateKeybindingsTemplate();
    const parsed = JSON.parse(output) as {
      $schema: string;
      $docs: string;
      bindings: Array<{
        context: string;
        bindings: Record<string, string | null>;
      }>;
    };

    expect(output.endsWith("\n")).toBe(true);
    expect(parsed.$schema).toBe("urn:agenc:keybindings:schema");
    expect(parsed.$docs).toBe("urn:agenc:keybindings:docs");

    const global = parsed.bindings.find((block) => block.context === "Global");
    expect(global?.bindings["ctrl+c"]).toBeUndefined();
    expect(global?.bindings["ctrl+d"]).toBeUndefined();
    expect(global?.bindings["ctrl+o"]).toBe("app:toggleTranscript");
  });
});
