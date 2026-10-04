import { expect, test, vi } from "vitest";

const effects = vi.hoisted(() => ({
  loads: 0,
  listeners: new Map<string, (...args: string[]) => void>(),
  execute: vi.fn(async (..._args: unknown[]) => [] as { blocked: boolean }[]),
  reload: vi.fn(async () => undefined),
}));
vi.mock("chokidar", () => ({ default: { watch: () => {
  const watcher = { on: (event: string, callback: (...args: string[]) => void) => { effects.listeners.set(event, callback); return watcher; }, close: async () => undefined };
  return watcher;
} } }));
vi.mock("../../src/utils/settings/settings.js", () => ({
  getSettingsFilePathForSource: (source: string) => source === "userSettings" ? "/tmp/gd-hook-settings.toml" : undefined,
}));
vi.mock("../../src/utils/settings/canonicalAuthority.js", () => ({
  getCanonicalConfigLayers: () => [],
  getCanonicalSettingsAuthority: () => ({ homeContext: { statePath: "/tmp/gd-hook-state.json" }, reload: effects.reload }),
}));
vi.mock("../../src/utils/hooks.js", () => {
  effects.loads++;
  return { executeConfigChangeHooks: effects.execute, hasBlockingResult: (rows: { blocked: boolean }[]) => rows.some(row => row.blocked) };
});

test("loads config hooks only for external events and keeps reload behind the blocking decision", async () => {
  const detector = await import("../../src/utils/settings/changeDetector.js");
  const internal = await import("../../src/utils/settings/internalWrites.js");
  const changed = vi.fn();
  try {
    await detector.resetForTesting({ deletionGrace: 1 });
    detector.subscribe(changed);
    await detector.initialize();
    expect(effects.loads).toBe(0);
    const change = effects.listeners.get("change")!;
    change("/tmp/unwatched.toml");
    internal.markInternalWrite("/tmp/gd-hook-settings.toml");
    change("/tmp/gd-hook-settings.toml");
    await vi.dynamicImportSettled();
    expect(effects.loads).toBe(0);

    let settle: ((rows: { blocked: boolean }[]) => void) | undefined;
    effects.execute.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    change("/tmp/gd-hook-settings.toml");
    await vi.waitFor(() => expect(effects.execute).toHaveBeenCalledWith("user_settings", "/tmp/gd-hook-settings.toml"));
    expect(changed).not.toHaveBeenCalled();
    expect(effects.reload).not.toHaveBeenCalled();
    settle!([{ blocked: true }]);
    await vi.dynamicImportSettled();
    expect(changed).not.toHaveBeenCalled();
    expect(effects.reload).not.toHaveBeenCalled();

    change("/tmp/gd-hook-settings.toml");
    await vi.waitFor(() => expect(effects.reload).toHaveBeenCalledTimes(1));
    expect(changed).toHaveBeenCalledWith("userSettings");
    expect(effects.loads).toBe(1);

    effects.listeners.get("unlink")!("/tmp/gd-hook-settings.toml");
    await vi.waitFor(() => expect(effects.reload).toHaveBeenCalledTimes(2));
    expect(effects.execute).toHaveBeenLastCalledWith("user_settings", "/tmp/gd-hook-settings.toml");
  } finally {
    await detector.dispose();
    internal.clearInternalWrites();
  }
});
