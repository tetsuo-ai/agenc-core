import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import {
  AgenCDaemonSessionManager,
  type AgenCSessionLifecycleOptions,
} from "./session-lifecycle.js";
import {
  attachDaemonTuiSession,
  type AgenCDaemonTuiClient,
  type AgenCTuiBridgeSession,
} from "../tui/daemon-session.js";
import type {
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
  MessageContent,
  MessageSendParams,
  MessageStreamParams,
  SessionAttachParams,
} from "./protocol/index.js";

function siblingSdkPath(...segments: readonly string[]): string {
  const path = [
    resolve(process.cwd(), "..", "..", "agenc-sdk", ...segments),
    resolve(process.cwd(), "..", "agenc-sdk", ...segments),
  ].find(existsSync);

  if (path === undefined) {
    throw new Error(`Missing sibling agenc-sdk path: ${segments.join("/")}`);
  }
  return path;
}

function readSiblingSdkSource(...segments: readonly string[]): string {
  return readFileSync(siblingSdkPath(...segments), "utf8");
}

describe("AgenC SDK plus TUI co-attach example", () => {
  it("drives one daemon session through SDK and TUI client attachments", () => {
    const exampleDir = siblingSdkPath("examples", "daemon-coattach");
    const packageJson = JSON.parse(
      readSiblingSdkSource("examples", "daemon-coattach", "package.json"),
    ) as {
      readonly dependencies?: Record<string, string>;
      readonly scripts?: Record<string, string>;
    };
    const source = readSiblingSdkSource(
      "examples",
      "daemon-coattach",
      "index.ts",
    );
    const testSource = readSiblingSdkSource(
      "examples",
      "daemon-coattach",
      "index.test.ts",
    );
    const readme = readSiblingSdkSource(
      "examples",
      "daemon-coattach",
      "README.md",
    );

    expect(packageJson.dependencies?.["@tetsuo-ai/sdk"]).toBe("file:../..");
    expect(packageJson.scripts?.test).toBe("vitest run index.test.ts");
    expect(packageJson.scripts?.typecheck).toBe("tsc --noEmit -p tsconfig.json");
    expect(source).toContain("export async function runDaemonCoAttach");
    expect(source).toContain("client.attachSession");
    expect(source).toContain("client.sendMessage");
    expect(source).toContain("client.streamMessage");
    expect(source).toContain("client.listSessions");
    expect(source).toContain("activeAttachmentIds");
    expect(source).toContain("tuiClientId");
    expect(source).toContain("sdkClientId");
    expect(source).not.toMatch(/createAgent|agent\.create/);
    expect(testSource).toContain("attach:sdk-test");
    expect(testSource).toContain("attach:tui-test");
    expect(testSource).toContain("sdk:session_1");
    expect(testSource).toContain("tui:session_1");
    expect(readme).toContain("one daemon session");
    expect(readme).toContain("TUI client ID");

    const typecheck = spawnSync("npm", ["run", "typecheck"], {
      cwd: exampleDir,
      encoding: "utf8",
    });
    expect(typecheck.status, typecheck.stderr || typecheck.stdout).toBe(0);

    const test = spawnSync("npm", ["test"], {
      cwd: exampleDir,
      encoding: "utf8",
    });
    expect(test.status, test.stderr || test.stdout).toBe(0);
  });

  it("shares daemon session events across SDK and TUI attachments", async () => {
    const sessionManager = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence(["attachment_sdk", "attachment_tui"]),
      now: sequence([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.100Z",
        "2026-05-01T00:00:00.200Z",
      ]),
    } satisfies AgenCSessionLifecycleOptions);
    const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager });
    const sdkEvents: JsonObject[] = [];

    await multiplexer.registerClient({
      clientId: "sdk-test",
      send: (event) => {
        sdkEvents.push(event);
      },
    });
    const session = await sessionManager.createSession({
      agentId: "agent_1",
      cwd: "/workspace",
      initialPrompt: "start shared work",
    });
    const sdkAttachment = await multiplexer.attachClientToSession(
      session.sessionId,
      "sdk-test",
    );
    const tuiClient = createInMemoryTuiClient({
      clientId: "tui-test",
      multiplexer,
    });
    const tuiSession = await attachDaemonTuiSession({
      baseSession: createBaseSession(),
      client: tuiClient,
      sessionId: session.sessionId,
      clientId: "tui-test",
    });
    const tuiEvents: JsonObject[] = [];
    const unsubscribe = tuiSession.subscribeToEvents((event) => {
      tuiEvents.push(event as JsonObject);
    });

    await sendSdkMessage(multiplexer, {
      sessionId: session.sessionId,
      content: "hello from sdk",
      metadata: { source: "sdk-test" },
    });
    await tuiSession.submit("hello from tui");
    unsubscribe();

    await expect(sessionManager.getSession(session.sessionId)).resolves.toEqual({
      sessionId: "session_1",
      agentId: "agent_1",
      status: "idle",
      createdAt: "2026-05-01T00:00:00.000Z",
      cwd: "/workspace",
      activeAttachmentIds: ["attachment_sdk", "attachment_tui"],
    });
    await expect(multiplexer.attachedClientIds(session.sessionId)).resolves.toEqual([
      "sdk-test",
      "tui-test",
    ]);
    expect(sdkAttachment.attachmentId).toBe("attachment_sdk");
    expect(tuiEvents).toEqual([
      {
        type: "message",
        source: "sdk-test",
        content: "hello from sdk",
        sessionId: "session_1",
      },
      {
        type: "message",
        source: "tui-test",
        content: "hello from tui",
        sessionId: "session_1",
      },
    ]);
    expect(sdkEvents.map((event) => event.msg)).toEqual(tuiEvents);
  });
});

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error("test sequence exhausted");
    }
    index += 1;
    return value;
  };
}

function createBaseSession(): AgenCTuiBridgeSession {
  return {
    conversationId: "local_session",
    services: {},
  };
}

function createInMemoryTuiClient(options: {
  readonly clientId: string;
  readonly multiplexer: AgenCDaemonClientMultiplexer;
}): AgenCDaemonTuiClient {
  const listeners = new Map<string, Set<(event: JsonObject) => void>>();
  let registered = false;
  return {
    async request<Method extends AgenCDaemonMethod>(
      method: Method,
      params?: JsonObject,
    ): Promise<AgenCDaemonResultByMethod[Method]> {
      if (method === "session.attach") {
        await ensureRegistered();
        const attachParams = params as SessionAttachParams;
        return (await options.multiplexer.attachClientToSession(
          attachParams.sessionId,
          options.clientId,
        )) as AgenCDaemonResultByMethod[Method];
      }
      if (method === "message.stream") {
        const streamParams = params as MessageStreamParams;
        return (await sendTuiMessage(
          options.multiplexer,
          options.clientId,
          streamParams,
        )) as AgenCDaemonResultByMethod[Method];
      }
      throw new Error(`Unexpected TUI daemon method: ${method}`);
    },
    subscribeToSessionEvents(sessionId, cb) {
      let sessionListeners = listeners.get(sessionId);
      if (sessionListeners === undefined) {
        sessionListeners = new Set();
        listeners.set(sessionId, sessionListeners);
      }
      sessionListeners.add(cb);
      return () => {
        sessionListeners?.delete(cb);
      };
    },
  };

  async function ensureRegistered(): Promise<void> {
    if (registered) return;
    await options.multiplexer.registerClient({
      clientId: options.clientId,
      send: (event) => {
        const sessionId =
          typeof event.sessionId === "string" ? event.sessionId : undefined;
        if (sessionId === undefined) return;
        for (const listener of listeners.get(sessionId) ?? []) {
          listener(event);
        }
      },
    });
    registered = true;
  }
}

async function sendSdkMessage(
  multiplexer: AgenCDaemonClientMultiplexer,
  params: MessageSendParams,
) {
  await multiplexer.broadcastSessionEvent(
    params.sessionId,
    toMessageEvent(params.sessionId, "sdk-test", params.content),
  );
  return {
    messageId: "message_sdk",
    acceptedAt: "2026-05-01T00:00:01.000Z",
  };
}

async function sendTuiMessage(
  multiplexer: AgenCDaemonClientMultiplexer,
  clientId: string,
  params: MessageStreamParams,
) {
  await multiplexer.broadcastSessionEvent(
    params.sessionId,
    toMessageEvent(params.sessionId, clientId, params.content),
  );
  return {
    messageId: "message_tui",
    streamId: params.streamId ?? `${clientId}:stream`,
    acceptedAt: "2026-05-01T00:00:02.000Z",
  };
}

function toMessageEvent(
  sessionId: string,
  source: string,
  content: MessageContent,
): JsonObject {
  return {
    type: "session.message",
    sessionId,
    msg: {
      type: "message",
      source,
      content: typeof content === "string" ? content : "[structured content]",
      sessionId,
    },
  };
}
