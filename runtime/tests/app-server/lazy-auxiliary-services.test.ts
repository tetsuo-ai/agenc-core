import { describe, expect, test, vi } from "vitest";
import { createLazyDaemonHealth } from "../../src/app-server/lazy-health.js";
import { createLazyWhisperService } from "../../src/audio/lazy-whisper.js";
import { createLazyRunInspection } from "../../src/app-server/lazy-run-inspection.js";
import { createLazyOwnerTelegramService } from "../../src/gateway/lazy-owner-telegram.js";
import type { OwnerTelegramService, OwnerTelegramOptions } from "../../src/gateway/owner-telegram.js";
import { createLazyRealtimeRpcService, createLazyRealtimeTransports } from "../../src/app-server/lazy-realtime.js";
import { REALTIME_EXECUTION_ADMISSION_DIAGNOSTIC } from "../../src/app-server/realtime-admission.js";

describe("lazy auxiliary services", () => {
  test("realtime retains the admission refusal and does not resolve a thread", async () => {
    const resolveThread = vi.fn();
    const service = createLazyRealtimeRpcService({ resolveThread });
    expect(service.startEnabled).toBe(false);
    await expect(service.start({ threadId: "thread-1" })).rejects.toMatchObject({
      code: "EXECUTION_ADMISSION_REQUIRED",
      message: REALTIME_EXECUTION_ADMISSION_DIAGNOSTIC,
    });
    expect(resolveThread).not.toHaveBeenCalled();
  });

  test("realtime captures the supplied fetch and consults live headers on use", async () => {
    const response = { status: 201, headers: { get: () => "/v1/realtime/calls/rtc_test" }, text: async () => "sdp-answer" };
    const fetch = vi.fn().mockResolvedValue(response);
    let token = "before";
    const headers = vi.fn(() => ({ authorization: token }));
    const transport = createLazyRealtimeTransports({ baseUrl: "https://example.invalid/v1", fetch, defaultHeaders: headers });
    expect(fetch).not.toHaveBeenCalled();
    expect(headers).not.toHaveBeenCalled();
    token = "after";
    await transport.callClient.create("sdp-offer");
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: "sdp-offer", headers: expect.objectContaining({ authorization: "after" }) }));
  });

  test("health keeps construction time and reads current readiness and restore counts", async () => {
    const startup = 1000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(startup);
    let ready = true;
    let restoring = 3;
    let now = startup + 100;
    const health = createLazyDaemonHealth({ nowMs: () => now, ready: () => ready, restoringSessions: () => restoring });
    ready = false;
    restoring = 1;
    now += 100;
    const result = await health.ready();
    expect(result.ready).toBe(false);
    expect(result.restoringSessions).toBe(1);
    clock.mockRestore();
    expect(result.uptimeMs).toBe(200);
    expect((await health.ping()).now).toBe(new Date(now).toISOString());
  });

  test("Whisper rejects a relative host home before its first request", () => {
    expect(() => createLazyWhisperService({ home: "relative" })).toThrow("Whisper home must be absolute");
  });

  test("cancelled inspection cannot discover or open state", async () => {
    const stateDatabasePaths = vi.fn(() => []);
    const service = createLazyRunInspection({ stateDatabasePaths });
    const reason = new Error("cancelled");
    await expect(service.status({ runId: "run-1" }, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(stateDatabasePaths).not.toHaveBeenCalled();
  });

  test("Telegram preserves eager metadata validation without loading a stopped runtime", async () => {
    const reads: string[] = [];
    const storage = {
      load: () => { reads.push("legacy"); return null; },
      agents: { load: () => { reads.push("agents"); return []; } },
    };
    const load = vi.fn();
    const service = createLazyOwnerTelegramService({ storage } as OwnerTelegramOptions, load);
    expect(reads).toEqual(["legacy", "agents"]);
    service.observeSessionEvent("session", { method: "event.permission_request" });
    await service.close();
    expect(load).not.toHaveBeenCalled();
    const failure = new Error("malformed metadata");
    expect(() => createLazyOwnerTelegramService({ storage: { load: () => { throw failure; } } } as unknown as OwnerTelegramOptions, load)).toThrow(failure);
  });

  test("Telegram shutdown during loading owns cleanup and never starts the pending RPC", async () => {
    type Runtime = Pick<OwnerTelegramService, "handle" | "observeSessionEvent" | "close">;
    let finish!: (value: Runtime) => void;
    const pending = new Promise<Runtime>(resolve => { finish = resolve; });
    const service = createLazyOwnerTelegramService({ storage: { load: () => null } } as OwnerTelegramOptions, () => pending);
    const request = service.handle("telegram.status", {});
    const rejected = expect(request).rejects.toMatchObject({ code: "REMOTE_OPERATION_CANCELLED" });
    const closing = service.close();
    const runtime = { handle: vi.fn<OwnerTelegramService["handle"]>().mockResolvedValue({}), observeSessionEvent: vi.fn(), close: vi.fn() };
    finish(runtime);
    await rejected;
    await closing;
    expect(runtime.handle).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });
});
