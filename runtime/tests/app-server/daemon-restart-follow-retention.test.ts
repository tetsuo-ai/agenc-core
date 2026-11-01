import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { activeAgenCDaemonRestartFollows, retainAgenCDaemonRestartFollow } from "../../src/app-server/daemon-restart-follow-retention.js";
import { addAgenCDaemonRestartResult, parseAgenCDaemonRestartResults } from "../../src/app-server/daemon-restart-outcome.js";

const homes: string[] = [];
const home = () => { const value = mkdtempSync(join(tmpdir(), "restart-retain-")); homes.push(value); return value; };
afterEach(() => { vi.restoreAllMocks(); for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("restart follow retention", () => {
  test("keeps a live owner without a heartbeat, and releases only its own registration", () => {
    const root = home();
    const releaseA = retainAgenCDaemonRestartFollow(root, "request-A"), releaseB = retainAgenCDaemonRestartFollow(root, "request-B");
    expect([...activeAgenCDaemonRestartFollows(root)].sort()).toEqual(["request-A", "request-B"]);
    releaseA(); releaseA();
    expect([...activeAgenCDaemonRestartFollows(root)]).toEqual(["request-B"]);
    releaseB();
    expect(activeAgenCDaemonRestartFollows(root).size).toBe(0);
  });

  test("cleans dead owners but keeps an owner whose liveness cannot be inspected", () => {
    const root = home(); retainAgenCDaemonRestartFollow(root, "request-A");
    const directory = join(root, "daemon-restart-follows");
    const file = join(directory, readdirSync(directory)[0]!);
    const entry = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...entry, pid: 2147483646 }));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); });
    expect([...activeAgenCDaemonRestartFollows(root)]).toEqual(["request-A"]);
    kill.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    expect(activeAgenCDaemonRestartFollows(root).size).toBe(0);
    expect(readdirSync(directory)).toEqual([]);
  });

  test("keeps every handover until the original follow is consumed, then returns to eight results", () => {
    let text: string | null = null;
    const retained = new Set(["request-0"]);
    for (let n = 0; n < 15; n++) {
      text = addAgenCDaemonRestartResult(text, { requestId: `request-${n}`, finishedAt: "1999-01-01T00:00:00Z",
        outcome: { status: "skipped", reason: "replaced" }, continuedBy: `request-${n + 1}` }, retained)!;
    }
    text = addAgenCDaemonRestartResult(text, { requestId: "request-15", finishedAt: "2099-01-01T00:00:00Z",
      outcome: { status: "failed", reason: "start failed" } }, retained)!;
    const results = parseAgenCDaemonRestartResults(text);
    expect(results).toHaveLength(16);
    expect(results[0]?.continuedBy).toBe("request-1");
    expect(results.at(-1)?.outcome).toMatchObject({ status: "failed", reason: "start failed" });
    expect(addAgenCDaemonRestartResult(text, { requestId: "request-15", finishedAt: "2099-01-01T00:00:01Z",
      outcome: { status: "skipped" } }, retained)).toBeNull();
    const pruned = addAgenCDaemonRestartResult(text, { requestId: "request-16", finishedAt: "2026-11-01T00:00:00Z", outcome: { status: "not-running" } })!;
    expect(parseAgenCDaemonRestartResults(pruned)).toHaveLength(8);
    expect(parseAgenCDaemonRestartResults(pruned).some(result => result.requestId === "request-0")).toBe(false);
  });

  test("a handover cycle does not prevent bounded pruning of unrelated results", () => {
    let text = addAgenCDaemonRestartResult(null, { requestId: "request-A", finishedAt: "now", outcome: { status: "skipped" }, continuedBy: "request-B" })!;
    text = addAgenCDaemonRestartResult(text, { requestId: "request-B", finishedAt: "now", outcome: { status: "skipped" }, continuedBy: "request-A" }, new Set(["request-A"]))!;
    expect(parseAgenCDaemonRestartResults(text)).toHaveLength(2);
  });
});
