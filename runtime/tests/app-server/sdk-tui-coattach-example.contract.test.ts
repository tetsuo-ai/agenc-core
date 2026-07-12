import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  MessageSendResult,
  MessageStreamParams,
  MessageStreamResult,
  SessionAttachParams,
  SessionAttachResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionListParams,
  SessionListResult,
  SessionSummary,
} from "./protocol/index.js";

interface DaemonCoAttachExampleClient {
  createSession(params: SessionCreateParams): Promise<SessionCreateResult>;
  attachSession(params: SessionAttachParams): Promise<SessionAttachResult>;
  sendMessage(params: MessageSendParams): Promise<MessageSendResult>;
  streamMessage(params: MessageStreamParams): Promise<MessageStreamResult>;
  listSessions(params: SessionListParams): Promise<SessionListResult>;
}

interface DaemonTuiAttachOptionsForExample {
  readonly client: Pick<
    DaemonCoAttachExampleClient,
    "attachSession" | "streamMessage"
  >;
  readonly clientId: string;
  readonly sessionId: string;
}

interface DaemonTuiAttachmentForExample {
  readonly attachmentId: string;
  submit(message: string): Promise<MessageStreamResult>;
}

interface DaemonCoAttachExampleResult {
  readonly session: SessionCreateResult;
  readonly sdkAttachment: SessionAttachResult;
  readonly tuiAttachment: DaemonTuiAttachmentForExample;
  readonly sdkMessage: MessageSendResult;
  readonly tuiMessage: MessageStreamResult;
  readonly visibleSession: SessionSummary;
}

type RunDaemonCoAttachExample = (options: {
  readonly attachTui?: (
    options: DaemonTuiAttachOptionsForExample,
  ) => Promise<DaemonTuiAttachmentForExample>;
  readonly client?: DaemonCoAttachExampleClient;
  readonly cwd?: string;
  readonly sdkClientId?: string;
  readonly sdkPrompt?: string;
  readonly tuiClientId?: string;
  readonly tuiPrompt?: string;
}) => Promise<DaemonCoAttachExampleResult>;

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
    expect(source).toContain("attachTui");
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
    expect(testSource).toContain("attachTui:tui-test");
    expect(testSource).toContain("sdk:session_1");
    expect(testSource).toContain("tui:session_1");
    expect(readme).toContain("one daemon session");
    expect(readme).toContain("TUI daemon bridge");

    const typecheck = spawnSync("npm", ["run", "typecheck"], {
      cwd: exampleDir,
      encoding: "utf8",
    });
    if (
      (typecheck.stderr || typecheck.stdout || "").includes(
        "Cannot find package",
      )
    ) {
      // Sibling example depends on a separately installed @tetsuo-ai/sdk tree.
      return;
    }
    expect(typecheck.status, typecheck.stderr || typecheck.stdout).toBe(0);

    const test = spawnSync("npm", ["test"], {
      cwd: exampleDir,
      encoding: "utf8",
    });
    if (
      (test.stderr || test.stdout || "").includes("Cannot find package")
    ) {
      return;
    }
    expect(test.status, test.stderr || test.stdout).toBe(0);
  });

  it("executes the sibling example through the real TUI bridge", async () => {
    let loaded: Awaited<ReturnType<typeof loadDaemonCoAttachExample>>;
    try {
      loaded = await loadDaemonCoAttachExample();
    } catch (error) {
      if (String(error).includes("Cannot find package")) {
        return;
      }
      throw error;
    }
    const { runDaemonCoAttach } = loaded;
    const harness = createExampleDaemonHarness();
    const tuiEvents: JsonObject[] = [];
    let unsubscribeTui: (() => void) | undefined;

    const result = await runDaemonCoAttach({
      client: harness.client,
      cwd: "/workspace",
      sdkClientId: "sdk-test",
      sdkPrompt: "hello from sdk",
      tuiClientId: "tui-test",
      tuiPrompt: "hello from tui",
      attachTui: async (options) => {
        expect(options.client).toBe(harness.client);
        expect(options.sessionId).toBe("session_1");
        expect(options.clientId).toBe("tui-test");

        const tuiClient = createInMemoryTuiClient({
          clientId: options.clientId,
          multiplexer: harness.multiplexer,
        });
        const tuiSession = await attachDaemonTuiSession({
          baseSession: createBaseSession(),
          client: tuiClient,
          sessionId: options.sessionId,
          clientId: options.clientId,
        });
        unsubscribeTui = tuiSession.subscribeToEvents((event) => {
          tuiEvents.push(event as JsonObject);
        });
        return {
          attachmentId: requireValue(
            tuiClient.lastAttachment(),
            "TUI bridge did not attach to the daemon session",
          ).attachmentId,
          submit: async (message) => {
            await tuiSession.submit(message);
            return requireValue(
              tuiClient.lastStreamResult(),
              "TUI bridge did not stream a daemon message",
            );
          },
        };
      },
    });
    unsubscribeTui?.();

    expect(result.session.sessionId).toBe("session_1");
    expect(result.sdkAttachment.attachmentId).toBe("attachment_sdk");
    expect(result.tuiAttachment.attachmentId).toBe("attachment_tui");
    expect(result.sdkMessage.messageId).toBe("message_sdk");
    expect(result.tuiMessage.messageId).toBe("message_tui");
    expect(result.tuiMessage.streamId).toMatch(/^tui-test:\d+$/);
    expect(result.tuiMessage.acceptedAt).toBe("2026-05-01T00:00:02.000Z");
    expect(result.visibleSession.activeAttachmentIds).toEqual([
      "attachment_sdk",
      "attachment_tui",
    ]);
    await expect(
      harness.sessionManager.getSession(result.session.sessionId),
    ).resolves.toEqual({
      sessionId: "session_1",
      agentId: "agent_default",
      status: "idle",
      createdAt: "2026-05-01T00:00:00.000Z",
      cwd: "/workspace",
      metadata: { source: "sdk-tui-coattach" },
      activeAttachmentIds: ["attachment_sdk", "attachment_tui"],
    });
    await expect(
      harness.multiplexer.attachedClientIds(result.session.sessionId),
    ).resolves.toEqual(["sdk-test", "tui-test"]);

    const expectedEvents = [
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
    ];
    expect(harness.sdkEvents.map((event) => event.msg)).toEqual(expectedEvents);
    expect(tuiEvents).toEqual(expectedEvents);
  });
});

async function loadDaemonCoAttachExample(): Promise<{
  readonly runDaemonCoAttach: RunDaemonCoAttachExample;
}> {
  const moduleUrl = pathToFileURL(
    siblingSdkPath("examples", "daemon-coattach", "index.ts"),
  ).href;
  return (await import(moduleUrl)) as {
    readonly runDaemonCoAttach: RunDaemonCoAttachExample;
  };
}

function createExampleDaemonHarness(): {
  readonly client: DaemonCoAttachExampleClient;
  readonly multiplexer: AgenCDaemonClientMultiplexer;
  readonly sdkEvents: readonly JsonObject[];
  readonly sessionManager: AgenCDaemonSessionManager;
} {
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
  const registeredClients = new Set<string>();

  async function ensureRegistered(clientId: string): Promise<void> {
    if (registeredClients.has(clientId)) return;
    await multiplexer.registerClient({
      clientId,
      send: (event) => {
        if (clientId === "sdk-test") sdkEvents.push(event);
      },
    });
    registeredClients.add(clientId);
  }

  const client: DaemonCoAttachExampleClient = {
    createSession: (params) => sessionManager.createSession(params),
    attachSession: async (params) => {
      await ensureRegistered(params.clientId ?? "sdk-test");
      return multiplexer.attachClientToSession(
        params.sessionId,
        params.clientId ?? "sdk-test",
      );
    },
    sendMessage: (params) => sendSdkMessage(multiplexer, params),
    streamMessage: (params) =>
      sendTuiMessage(multiplexer, sourceFromStream(params), params),
    listSessions: (params) => sessionManager.listSessions(params),
  };

  return { client, multiplexer, sdkEvents, sessionManager };
}

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
}): AgenCDaemonTuiClient & {
  lastAttachment(): SessionAttachResult | null;
  lastStreamResult(): MessageStreamResult | null;
} {
  const listeners = new Map<string, Set<(event: JsonObject) => void>>();
  let lastAttachment: SessionAttachResult | null = null;
  let lastStreamResult: MessageStreamResult | null = null;
  let registered = false;
  return {
    async request<Method extends AgenCDaemonMethod>(
      method: Method,
      params?: JsonObject,
    ): Promise<AgenCDaemonResultByMethod[Method]> {
      if (method === "session.attach") {
        await ensureRegistered();
        const attachParams = params as SessionAttachParams;
        lastAttachment = await options.multiplexer.attachClientToSession(
          attachParams.sessionId,
          options.clientId,
        );
        return lastAttachment as AgenCDaemonResultByMethod[Method];
      }
      if (method === "message.stream") {
        const streamParams = params as MessageStreamParams;
        lastStreamResult = await sendTuiMessage(
          options.multiplexer,
          options.clientId,
          streamParams,
        );
        return lastStreamResult as AgenCDaemonResultByMethod[Method];
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
    lastAttachment: () => lastAttachment,
    lastStreamResult: () => lastStreamResult,
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
): Promise<MessageSendResult> {
  await multiplexer.broadcastSessionEvent(
    params.sessionId,
    toMessageEvent(params.sessionId, sourceFromMetadata(params), params.content),
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
): Promise<MessageStreamResult> {
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

function sourceFromMetadata(params: MessageSendParams): string {
  const source = params.metadata?.source;
  return typeof source === "string" ? source : "sdk-test";
}

function sourceFromStream(params: MessageStreamParams): string {
  return params.streamId?.split(":", 1)[0] || sourceFromMetadata(params);
}

function requireValue<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message);
  return value;
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
