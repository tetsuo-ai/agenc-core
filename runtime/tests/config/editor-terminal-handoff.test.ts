import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { spawnConfigEditor } from "../../src/config/editor.js";
const harness = vi.hoisted(() => ({ steps: [] as string[], failure: false }));
vi.mock("../../src/tui/ink/instances.js", () => ({ getInkInstance: () => ({ enterAlternateScreen: () => harness.steps.push("suspend"), exitAlternateScreen: () => harness.steps.push("resume") }) }));
vi.mock("node:child_process", () => ({ spawn: () => {
  harness.steps.push("spawn");
  const child = new EventEmitter();
  queueMicrotask(() => harness.failure ? child.emit("error", new Error("missing editor")) : child.emit("exit", 0));
  return child;
} }));
it.each([false, true])("hands stdin to the editor and restores it after failure=%s", async failure => {
  harness.steps = [];
  harness.failure = failure;
  expect(await spawnConfigEditor("vi", ["config.toml"])).toBe(failure ? 127 : 0);
  expect(harness.steps).toEqual(["suspend", "spawn", "resume"]);
});
