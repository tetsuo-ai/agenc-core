import { describe, expect, test } from "vitest";

import { createVoiceInputService } from "./voice-input.js";

describe("voice input service", () => {
  test("stays disabled without config or command", () => {
    expect(
      createVoiceInputService({
        env: {},
      }),
    ).toBeUndefined();
  });

  test("can be enabled by command config", () => {
    const service = createVoiceInputService({
      config: { enabled: true, command: "printf hello" },
      env: {},
    });
    expect(service).toBeDefined();
  });
});
