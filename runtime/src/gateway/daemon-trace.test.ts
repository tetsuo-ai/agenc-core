import { describe, expect, it, vi } from "vitest";

import {
  buildRuntimeContractSessionTraceId,
  buildRuntimeContractTaskTraceId,
  buildRuntimeContractWorkerTraceId,
  logExecutionTraceEvent,
  logProviderPayloadTraceEvent,
} from "./daemon-trace.js";

describe("runtime contract trace ids", () => {
  it("builds deterministic session, task, and worker trace ids", () => {
    expect(buildRuntimeContractSessionTraceId("session-a")).toBe(
      "contract:session:session-a",
    );
    expect(buildRuntimeContractTaskTraceId("session-a", "7")).toBe(
      "contract:task:session-a:7",
    );
    expect(buildRuntimeContractWorkerTraceId("session-a", "worker-2")).toBe(
      "contract:worker:session-a:worker-2",
    );
  });
});

describe("trace log filtering", () => {
  it("drops provider stream_event chatter from daemon trace logs", () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      setLevel: vi.fn(),
    };

    logProviderPayloadTraceEvent({
      logger,
      channelName: "webchat",
      traceId: "trace-1",
      sessionId: "session-1",
      traceConfig: {
        enabled: true,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: true,
        maxChars: 20_000,
      },
      event: {
        kind: "stream_event",
        provider: "grok",
        model: "grok-4",
        transport: "chat",
        payload: { type: "response.output_text.delta", delta: "hel" },
      },
    });

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("summarizes tool_dispatch_finished result previews", () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      setLevel: vi.fn(),
    };

    logExecutionTraceEvent({
      logger,
      channelName: "webchat",
      traceId: "trace-2",
      sessionId: "session-2",
      traceConfig: {
        enabled: true,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: false,
        maxChars: 20_000,
      },
      event: {
        type: "tool_dispatch_finished",
        phase: "tool_followup",
        callIndex: 1,
        payload: {
          tool: "system.readFile",
          isError: false,
          result: "line one\nline two\nline three",
        },
      },
    });

    const line = logger.info.mock.calls[0]?.[0] as string;
    expect(line).toContain('"resultPreview"');
    expect(line).toContain('"resultOmitted":true');
    expect(line).not.toContain('"result":"line one');
  });
});
