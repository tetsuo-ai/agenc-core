import { afterEach, expect, test, vi } from "vitest";
import { createLazyDaemonHealth } from "../../src/app-server/lazy-health.js";

const implementation = vi.hoisted(() => ({ loads: 0 }));
vi.mock("../../src/app-server/health.js", async (importOriginal) => {
  implementation.loads += 1;
  return importOriginal<typeof import("../../src/app-server/health.js")>();
});

afterEach(() => vi.restoreAllMocks());

test("resident proof pings leave health implementation deferred until ready or stats", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  let now = 1_100;
  let ready = false;
  let restoring = 2;
  const readyCounter = vi.fn(() => ready);
  const restoreCounter = vi.fn(() => restoring);
  const sessionCounter = { countSessions: vi.fn(() => ({ active: 1, closed: 2, total: 3 })) };
  const memoryUsage = vi.fn(() => ({ rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 }));
  const health = createLazyDaemonHealth({
    nowMs: () => now, ready: readyCounter, restoringSessions: restoreCounter,
    sessionCounter, memoryUsage,
  });
  expect(implementation.loads).toBe(0);
  for (let index = 0; index < 3; index++) {
    now += 100;
    expect(await health.ping()).toEqual({ ok: true, now: new Date(now).toISOString() });
  }
  expect(implementation.loads).toBe(0);
  expect(readyCounter).not.toHaveBeenCalled();
  expect(restoreCounter).not.toHaveBeenCalled();
  expect(sessionCounter.countSessions).not.toHaveBeenCalled();
  expect(memoryUsage).not.toHaveBeenCalled();

  ready = true;
  restoring = 1;
  expect(await health.ready()).toEqual({
    ready: true, uptimeMs: 400, now: new Date(now).toISOString(), restoringSessions: 1,
  });
  const stats = await health.stats();
  expect(stats).toEqual({
    uptimeMs: 400, now: new Date(now).toISOString(),
    sessions: { active: 1, closed: 2, total: 3 },
    memory: { rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 },
  });
  expect(implementation.loads).toBe(1);
  expect(sessionCounter.countSessions).toHaveBeenCalledOnce();
  expect(memoryUsage).toHaveBeenCalledOnce();
});

test("ping retains a live default clock and matches the direct service payload", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(2_000);
  const health = createLazyDaemonHealth();
  const { AgenCDaemonHealthService } = await import("../../src/app-server/health.js");
  const direct = new AgenCDaemonHealthService();
  clock.mockReturnValue(3_000);
  expect(await health.ping()).toEqual(direct.ping());
  expect(await health.ping()).toEqual({ ok: true, now: "1970-01-01T00:00:03.000Z" });
});

test("ping preserves a supplied clock failure as a rejected request", async () => {
  const failure = new Error("clock unavailable");
  const health = createLazyDaemonHealth({ nowMs: () => { throw failure; } });
  await expect(health.ping()).rejects.toBe(failure);
});
