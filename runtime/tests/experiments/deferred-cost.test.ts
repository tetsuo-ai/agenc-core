import { expect, test, vi } from "vitest";
import { EventLog } from "../../src/session/event-log.js";
import { CostSidecar } from "../../src/session/cost.js";
import { SidecarManager } from "../../src/session/sidecar.js";
import { deferSidecar } from "../../src/session/deferred-sidecar.js";

test("end-of-run cost setup replays usage once and keeps a single live subscription", async () => {
  const log = new EventLog();
  const deferred = deferSidecar(log);
  const usage = () => log.emit({ id: "usage", msg: { type: "token_count", payload: {
    model: "deepseek-chat", provider: "deepseek", promptTokens: 100, completionTokens: 10, totalTokens: 110,
  } } });
  usage(); usage();
  const cost = new CostSidecar({ defaultModel: "deepseek-chat", defaultProvider: "deepseek", exitSummary: false });
  const stop = vi.spyOn(cost, "stop");
  const manager = new SidecarManager();
  manager.register(deferred.attach(cost));
  await manager.start(log);
  usage();
  expect(cost.getTotalInputTokens()).toBe(300);
  expect(cost.getTotalOutputTokens()).toBe(30);
  expect(cost.getTotalCostUsd()).toBeGreaterThan(0);
  await manager.stop();
  expect(stop).toHaveBeenCalledOnce();
  usage();
  expect(cost.getTotalInputTokens()).toBe(300);
});
