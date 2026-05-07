import { describe, expect, it } from "vitest";

import { defaultConfig } from "../config/schema.js";
import { resolveStartupSelection } from "./startup-selection.js";

describe("resolveStartupSelection", () => {
  it("uses Bedrock model env when selected by provider", () => {
    const resolved = resolveStartupSelection({
      config: defaultConfig(),
      env: {
        AGENC_PROVIDER: "amazon-bedrock",
        AWS_BEDROCK_MODEL: "amazon.nova-lite-v1:0",
        AWS_ACCESS_KEY_ID: "bedrock-access-key",
      },
      argv: ["node", "agenc"],
    });

    expect(resolved.provider).toBe("amazon-bedrock");
    expect(resolved.model).toBe("amazon.nova-lite-v1:0");
    expect(resolved.apiKey).toBe("bedrock-access-key");
  });
});
