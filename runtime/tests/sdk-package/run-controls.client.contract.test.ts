import { describe, expect, it } from "vitest";
import {
  createAgencClient,
  type AgencDaemonMethod,
  type AgencDaemonRequest,
  type AgencDaemonResponse,
  type AgencTransport,
} from "../../../packages/agenc-sdk/src/index.js";

class ControlTransport implements AgencTransport {
  readonly requests: AgencDaemonRequest[] = [];
  constructor(private readonly enabled: boolean) {}

  async request<Method extends AgencDaemonMethod>(request: AgencDaemonRequest<Method>): Promise<AgencDaemonResponse<Method>> {
    this.requests.push(request as AgencDaemonRequest);
    const result = request.method === "initialize"
      ? { type: "initialized", protocolVersion: "1.23.0", protocol: { version: "1.23.0" }, capabilities: {
        "daemon.methods": { "run.pause": this.enabled, "run.resume": this.enabled },
      } }
      : { runId: "run-1", state: request.method === "run.pause" ? "pause_requested" : "running" };
    return { jsonrpc: "2.0", id: request.id, result } as AgencDaemonResponse<Method>;
  }
}

describe("SDK workflow control methods", () => {
  it("requires advertised support and never silently starts a replacement run", async () => {
    const transport = new ControlTransport(false);
    const client = createAgencClient({ transport });
    await client.initialize();
    await expect(client.pauseRun({ runId: "run-1", requestId: "pause-1" })).rejects.toMatchObject({ capability: "run.pause" });
    await expect(client.resumeRun({ runId: "run-1", suspensionId: "pause:1" })).rejects.toMatchObject({ capability: "run.resume" });
    expect(transport.requests.map(({ method }) => method)).toEqual(["initialize"]);
  });

  it("preserves checkpoint state and exact control identities", async () => {
    const transport = new ControlTransport(true);
    const client = createAgencClient({ transport });
    await client.initialize();
    const pause = { runId: "run-1", requestId: "pause-1" };
    const resume = { runId: "run-1", suspensionId: "pause:1", envOverrides: { DEEPSEEK_API_KEY: "test-only" } };
    expect(await client.pauseRun(pause)).toMatchObject({ state: "pause_requested" });
    expect(await client.resumeRun(resume)).toMatchObject({ runId: "run-1", state: "running" });
    expect(transport.requests.slice(1).map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "run.pause", params: pause },
      { method: "run.resume", params: resume },
    ]);
  });
});
