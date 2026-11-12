import { afterEach, describe, expect, test, vi } from "vitest";

const probes = vi.hoisted(() => ({ addNotification: vi.fn(), removeNotification: vi.fn() }));

// Run the hook's effect at once, as mounting the App does.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    },
  };
});

vi.mock("../../../../src/tui/context/notifications.js", () => ({
  useNotifications: () => ({
    addNotification: probes.addNotification,
    removeNotification: probes.removeNotification,
  }),
}));

import { resolveCanonicalStartupSelection } from "../../../../src/bin/startup-selection.js";
import { useStartupNotices } from "../../../../src/tui/hooks/notifs/useStartupNotices.js";
import { queueTuiStartupNotice, takeTuiStartupNotices } from "../../../../src/tui/startup-notices.js";

afterEach(() => {
  takeTuiStartupNotices();
  probes.addNotification.mockReset();
  vi.restoreAllMocks();
});

const saved = (model: string) => ({ model_provider: "openrouter", model });
const TODAY = new Date("2026-11-12T12:00:00Z");

describe("useStartupNotices", () => {
  test("shows each queued notice once, in the footer", () => {
    queueTuiStartupNotice({ key: "sandbox-unavailable", text: "No sandbox" });
    useStartupNotices();
    expect(probes.addNotification.mock.calls).toEqual([[{
      key: "sandbox-unavailable", text: "No sandbox",
      color: "warning", priority: "high", wrap: true, timeoutMs: 15_000,
    }]]);
    // A later mount has nothing left to show.
    useStartupNotices();
    expect(probes.addNotification).toHaveBeenCalledTimes(1);
  });

  test("shows that the saved model is retired, with the text startup wrote to stderr", () => {
    const stderr = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Bundled OpenRouter row retired on 2026-10-31 (issue #3447), resolved as
    // an interactive start does: by the trust preflight, then for the TUI's session.
    const config = saved("poolside/laguna-s-2.1");
    for (let resolution = 0; resolution < 2; resolution += 1) {
      expect(resolveCanonicalStartupSelection({ config, env: {}, now: TODAY }))
        .toMatchObject({ provider: "openrouter", model: "poolside/laguna-s-2.1" });
    }
    const text = "OpenRouter retired 'poolside/laguna-s-2.1' on 2026-10-31. Pick another model.";
    expect(stderr.mock.calls).toEqual([[text]]);
    // Nothing reaches the TUI before it mounts.
    expect(probes.addNotification).not.toHaveBeenCalled();

    useStartupNotices();
    expect(probes.addNotification.mock.calls).toEqual([[{
      key: "retired-model:openrouter/poolside/laguna-s-2.1", text,
      color: "warning", priority: "high", wrap: true, timeoutMs: 15_000,
    }]]);
  });

  test("shows nothing for a saved model that is not retired, or a retired one refused at --model", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Its date, 2026-12-31, is ahead.
    expect(resolveCanonicalStartupSelection({ config: saved("z-ai/glm-4.5"), env: {}, now: TODAY }).model)
      .toBe("z-ai/glm-4.5");
    expect(resolveCanonicalStartupSelection({ config: saved("x-ai/grok-4.5"), env: {}, now: TODAY }).model)
      .toBe("x-ai/grok-4.5");
    expect(() => resolveCanonicalStartupSelection({
      config: saved("bytedance-seed/seed-1.6"), env: {}, explicitModel: "bytedance-seed/seed-1.6", now: TODAY,
    })).toThrow("OpenRouter retired 'bytedance-seed/seed-1.6' on 2026-11-11. Pick another model.");
    useStartupNotices();
    expect(probes.addNotification).not.toHaveBeenCalled();
  });
});
