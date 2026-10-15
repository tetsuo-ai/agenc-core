import React from "react";
import { describe, expect, test } from "vitest";
import { FullscreenLayout } from "./FullscreenLayout.js";
import { FullscreenModeProvider } from "../context/fullscreenModeContext.js";
import { StatusEffortContext } from "../context/statusEffortContext.js";
import { AppStateProvider, getDefaultAppState } from "../state/AppState.js";
import { Text } from "../ink.js";
import { renderToString } from "../../utils/staticRender.js";
import { getSessionEffortLabelForContext } from "../../../src/utils/effort.js";
import { TEST_REMOTE_AUTH_SESSION_CONTEXT } from "../remoteAuthSessionContext.fixture.js";

async function footer(provider: string, model: string, effort: "max" | "high" | "none") {
  const label = getSessionEffortLabelForContext(model, effort, {
    ...TEST_REMOTE_AUTH_SESSION_CONTEXT,
    provider,
  });
  return renderToString(
    <AppStateProvider initialState={{ ...getDefaultAppState(), mainLoopModel: model }}>
      <StatusEffortContext value={label}>
        <FullscreenModeProvider enabled>
          <FullscreenLayout scrollable={<Text>ready</Text>} bottom={<Text>prompt</Text>} />
        </FullscreenModeProvider>
      </StatusEffortContext>
    </AppStateProvider>,
    { columns: 180, rows: 24 },
  );
}

describe("footer effort follows the active model", () => {
  test.each([
    ["venice", "llama-3.3-70b"],
    ["groq", "minimaxai/minimax-m2.7"],
    ["ollama-cloud", "minimax-m2.7"],
    // Hosted identities must not inherit effort from an upstream name.
    ["groq", "gpt-5.4-unregistered"],
    ["ollama-cloud", "claude-opus-5-unregistered"],
    ["venice", "claude-opus-5-unregistered"],
  ])("%s/%s hides saved and runtime effort", async (provider, model) => {
    for (const effort of ["max", "high", "none"] as const) {
      expect(await footer(provider!, model!, effort)).not.toContain("effort");
    }
  });

  test.each(["high", "max"] as const)("DeepSeek still shows %s effort", async (effort) => {
    expect(await footer("deepseek", "deepseek-flash", effort)).toContain(`${effort} effort`);
  });

  test("Venice GLM keeps its newly catalogued effort support", async () => {
    expect(await footer("venice", "zai-org-glm-5-2", "max")).toContain("max effort");
  });
});
