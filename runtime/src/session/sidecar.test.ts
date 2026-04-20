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
  test("registered sidecars receive events", async () => {
    const log = new EventLog();
    const received: string[] = [];
    const s: Sidecar = {
      name: "test",
      onEvent(e) {
        received.push(e.msg.type);
      },
    };
    const mgr = new SidecarManager();
    mgr.register(s);
    await mgr.start(log);
    log.emit({
      id: "1",
      msg: { type: "warning", payload: { cause: "x", message: "y" } },
    });
    log.emit({
      id: "2",
      msg: { type: "error", payload: { cause: "x", message: "y" } },
    });
    expect(received).toEqual(["warning", "error"]);
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
});
