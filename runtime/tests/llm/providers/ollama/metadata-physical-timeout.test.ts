import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { describe, expect, test } from "vitest";
import { OllamaProvider } from "../../../../src/llm/providers/ollama/adapter.js";
import type { LLMTool } from "../../../../src/llm/types.js";

const read: LLMTool = { type: "function", function: {
  name: "mcp.memory.read", description: "Read a value", parameters: {
    type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false,
  },
} };
const omitted: LLMTool = { ...read, function: { ...read.function, name: "NotSelected" } };

async function stalledMetadataFixture(stall: "headers" | "body") {
  const paths: string[] = [];
  const requestBodies: unknown[] = [];
  const sockets = new Set<Socket>();
  let sawPhysicalClose = false;
  let safetyDeadlineFired = false;
  let resolvePhysicalClose!: () => void;
  const physicalClose = new Promise<void>(resolve => { resolvePhysicalClose = resolve; });
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    if (request.url !== "/api/show" || request.method !== "POST") {
      response.writeHead(500).end("Only isolated metadata requests are permitted");
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", chunk => { chunks.push(Buffer.from(chunk)); });
    request.on("end", () => {
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      request.socket.once("close", () => {
        sawPhysicalClose = true;
        resolvePhysicalClose();
      });
      if (stall === "body") {
        // Fetch resolves its headers, but the real SDK's response.json() must
        // remain pending until the wrapper aborts the physical body stream.
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"capabilities":["completion","tools"]');
      }
      // Deliberately never finish either the headers or body. No /api/chat
      // handler or real inference endpoint exists in this fixture.
    });
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  // The safety deadline makes a broken physical-abort regression finish with
  // an assertion failure instead of leaving open sockets or hanging the suite.
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const safetyDeadline = setTimeout(() => {
    safetyDeadlineFired = true;
    for (const socket of sockets) socket.destroy();
    rejectDeadline(new Error("Isolated metadata fixture exceeded its physical-abort deadline"));
  }, 7_500);
  return {
    url: `http://127.0.0.1:${port}`,
    paths,
    requestBodies,
    physicalClose,
    withinDeadline<T>(operation: Promise<T>): Promise<T> {
      return Promise.race([operation, deadline]);
    },
    get sawPhysicalClose() { return sawPhysicalClose; },
    get safetyDeadlineFired() { return safetyDeadlineFired; },
    async close() {
      clearTimeout(safetyDeadline);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    },
  };
}

describe("Ollama metadata physical timeout through the real SDK fetch wrapper", () => {
  test.each(["headers", "body"] as const)("aborts a stalled %s socket and retains only the pinned selected catalog", async stall => {
    const fixture = await stalledMetadataFixture(stall);
    try {
      const provider = new OllamaProvider({
        model: "isolated-metadata-test-model", host: fixture.url,
        numCtx: 32_768, tools: [read, omitted],
      });
      const options = { systemPrompt: "Keep current policy", toolRouting: { allowedToolNames: [read.function.name] } };
      const started = performance.now();
      // No client injection or fetch mock: this imports the installed Ollama
      // SDK and reaches ensureClient's actual AbortSignal.timeout wrapper.
      const profile = await fixture.withinDeadline(provider.getExecutionProfile(options));
      await fixture.withinDeadline(fixture.physicalClose);
      const elapsed = performance.now() - started;
      expect(fixture.safetyDeadlineFired).toBe(false);
      expect(fixture.sawPhysicalClose).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(2_500);
      expect(elapsed).toBeLessThan(6_000);
      expect(fixture.paths).toEqual(["/api/show"]);
      expect(fixture.requestBodies).toEqual([{ model: "isolated-metadata-test-model" }]);
      expect(profile.model).toBe("isolated-metadata-test-model");
      const pinned = { ...options, providerExecutionHandle: profile.providerExecutionHandle };
      const messages = [{ role: "user" as const, content: "Read key" }];
      const projected = provider.projectRequestForAccounting(messages, pinned);
      // Unknown metadata is not permission to strip native schemas or broaden
      // the catalog. No inference is needed to inspect the pinned wire view.
      expect(projected.options.tools).toEqual([{ ...read, function: { ...read.function, name: "mcp__memory__read" } }]);
      expect(projected.options.systemPrompt).toBe(options.systemPrompt);
      expect(projected.messages).toEqual(messages);
      expect(() => provider.projectRequestForAccounting(messages, { ...pinned, tools: [] })).toThrow("does not match");
      await fixture.withinDeadline(provider.getExecutionProfile(options));
      expect(fixture.paths).toEqual(["/api/show"]);
    } finally {
      await fixture.close();
    }
  }, 10_000);
});
