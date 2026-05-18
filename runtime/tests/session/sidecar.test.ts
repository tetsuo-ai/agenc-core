import { describe, expect, test } from "vitest";
import { ReservedErrorBuffer, SidecarManager } from "./sidecar.js";
import { EventLog } from "./event-log.js";
import type { Sidecar } from "./sidecar.js";

describe("ReservedErrorBuffer (I-43)", () => {
  test("accepts entries + evicts oldest on overflow", () => {
    const buf = new ReservedErrorBuffer(500); // small for the test
    for (let i = 0; i < 100; i += 1) {
      buf.append({
        sidecar: "x",
        level: "error",
        cause: "c",
        message: `msg${i}`,
        at: 0,
      });
    }
    expect(buf.getOverflowCount()).toBeGreaterThan(0);
    expect(buf.snapshot().length).toBeLessThan(100);
  });

  test("drain returns + clears", () => {
    const buf = new ReservedErrorBuffer();
    buf.append({ sidecar: "a", level: "warning", cause: "c", message: "m", at: 0 });
    const drained = buf.drain();
    expect(drained).toHaveLength(1);
    expect(buf.snapshot()).toHaveLength(0);
  });
});

describe("SidecarManager", () => {
  test("uses live-only subscriptions and registration-order startup", async () => {
    const log = new EventLog();
    const firstSeen: string[] = [];
    const secondSeen: string[] = [];
    const order: string[] = [];

    log.emit({
      id: "before-start",
      msg: { type: "warning", payload: { cause: "x", message: "y" } },
    });

    const first: Sidecar = {
      name: "first",
      start() {
        order.push("start:first");
        log.emit({
          id: "during-first-start",
          msg: { type: "warning", payload: { cause: "x", message: "y" } },
        });
      },
      onEvent(event) {
        firstSeen.push(event.id);
        order.push(`event:first:${event.id}`);
      },
    };
    const second: Sidecar = {
      name: "second",
      start() {
        order.push("start:second");
        log.emit({
          id: "during-second-start",
          msg: { type: "warning", payload: { cause: "x", message: "y" } },
        });
      },
      onEvent(event) {
        secondSeen.push(event.id);
        order.push(`event:second:${event.id}`);
      },
    };

    const mgr = new SidecarManager();
    mgr.register(first);
    mgr.register(second);
    await mgr.start(log);

    log.emit({
      id: "after-start",
      msg: { type: "warning", payload: { cause: "x", message: "y" } },
    });

    expect(firstSeen).toEqual(["during-second-start", "after-start"]);
    expect(secondSeen).toEqual(["after-start"]);
    expect(order).toEqual([
      "start:first",
      "start:second",
      "event:first:during-second-start",
      "event:first:after-start",
      "event:second:after-start",
    ]);

    await mgr.stop();
  });

  test("I-43: sidecar throw doesn't break other sidecars", async () => {
    const log = new EventLog();
    const received: string[] = [];
    const throwing: Sidecar = {
      name: "throwing",
      onEvent() {
        throw new Error("boom");
      },
    };
    const quiet: Sidecar = {
      name: "quiet",
      onEvent(e) {
        received.push(e.id);
      },
    };
    const diagnostics: string[] = [];
    const mgr = new SidecarManager({
      onDiagnostic: (d) => diagnostics.push(d.sidecar),
    });
    mgr.register(throwing);
    mgr.register(quiet);
    await mgr.start(log);
    log.emit({
      id: "1",
      msg: { type: "warning", payload: { cause: "x", message: "y" } },
    });
    expect(received).toEqual(["1"]);
    expect(diagnostics).toContain("throwing");
    await mgr.stop();
  });

  test("unsubscribes a sidecar before running its stop hook", async () => {
    const log = new EventLog();
    const firstSeen: string[] = [];
    const secondSeen: string[] = [];
    const order: string[] = [];

    const first: Sidecar = {
      name: "first",
      onEvent(event) {
        firstSeen.push(event.id);
      },
      stop() {
        order.push("stop:first");
        log.emit({
          id: "during-first-stop",
          msg: { type: "warning", payload: { cause: "x", message: "y" } },
        });
      },
    };
    const second: Sidecar = {
      name: "second",
      onEvent(event) {
        secondSeen.push(event.id);
        order.push(`event:second:${event.id}`);
      },
      stop() {
        order.push("stop:second");
        log.emit({
          id: "during-second-stop",
          msg: { type: "warning", payload: { cause: "x", message: "y" } },
        });
      },
    };

    const mgr = new SidecarManager();
    mgr.register(first);
    mgr.register(second);
    await mgr.start(log);

    log.emit({
      id: "steady-state",
      msg: { type: "warning", payload: { cause: "x", message: "y" } },
    });
    await mgr.stop();

    expect(firstSeen).toEqual(["steady-state"]);
    expect(secondSeen).toEqual(["steady-state", "during-first-stop"]);
    expect(order).toEqual([
      "event:second:steady-state",
      "stop:first",
      "event:second:during-first-stop",
      "stop:second",
    ]);
  });
});
