import { randomUUID } from "node:crypto";

import type { RuntimeExecutionLocation } from "../runtime-contract/types.js";
import type { ToolResult } from "../tools/types.js";
import type { SystemRemoteJobManager } from "../tools/system/remote-job.js";
import type { SystemRemoteSessionManager } from "../tools/system/remote-session.js";
import type { SessionShellProfile } from "./shell-profile.js";

interface ParsedToolResult {
  readonly body: Record<string, unknown>;
}

export interface ManagedRemoteSessionHandle {
  readonly handleId: string;
  readonly callbackToken: string;
  readonly executionLocation: RuntimeExecutionLocation;
}

export interface ManagedRemoteJobHandle {
  readonly handleId: string;
  readonly callbackToken: string;
  readonly executionLocation: RuntimeExecutionLocation;
}

function parseToolResult(result: ToolResult): ParsedToolResult {
  let body: Record<string, unknown> | undefined;
  try {
    body = JSON.parse(result.content) as Record<string, unknown>;
  } catch {
    body = undefined;
  }
  if (result.isError || !body) {
    const errorObject =
      body && typeof body.error === "object" && body.error !== null
        ? (body.error as Record<string, unknown>)
        : undefined;
    const message =
      (typeof errorObject?.message === "string" && errorObject.message) ||
      (typeof body?.error === "string" && body.error) ||
      result.content;
    throw new Error(message);
  }
  return { body };
}

function buildRemoteSessionLocation(body: Record<string, unknown>): RuntimeExecutionLocation {
  return {
    mode: "remote_session",
    ...(typeof body.workingDirectory === "string"
      ? { workingDirectory: body.workingDirectory }
      : {}),
    ...(typeof body.workspaceRoot === "string"
      ? { workspaceRoot: body.workspaceRoot }
      : {}),
    ...(typeof body.serverName === "string" ? { serverName: body.serverName } : {}),
    ...(typeof body.sessionHandleId === "string"
      ? { handleId: body.sessionHandleId }
      : {}),
    ...(typeof body.remoteSessionId === "string"
      ? { remoteSessionId: body.remoteSessionId }
      : {}),
  };
}

function buildRemoteJobLocation(body: Record<string, unknown>): RuntimeExecutionLocation {
  return {
    mode: "remote_job",
    ...(typeof body.workingDirectory === "string"
      ? { workingDirectory: body.workingDirectory }
      : {}),
    ...(typeof body.workspaceRoot === "string"
      ? { workspaceRoot: body.workspaceRoot }
      : {}),
    ...(typeof body.serverName === "string" ? { serverName: body.serverName } : {}),
    ...(typeof body.jobHandleId === "string"
      ? { handleId: body.jobHandleId }
      : {}),
    ...(typeof body.remoteJobId === "string"
      ? { remoteJobId: body.remoteJobId }
      : {}),
  };
}

export async function startManagedRemoteSession(params: {
  readonly manager: Pick<SystemRemoteSessionManager, "start">;
  readonly parentSessionId: string;
  readonly workerId: string;
  readonly shellProfile?: SessionShellProfile;
  readonly workspaceRoot?: string;
  readonly workingDirectory?: string;
}): Promise<ManagedRemoteSessionHandle> {
  const remoteSessionId = `${params.parentSessionId}:${params.workerId}`;
  const result = await params.manager.start({
    serverName: "runtime",
    remoteSessionId,
    label: `${params.parentSessionId}:${params.workerId}`,
    idempotencyKey: `worker:${params.parentSessionId}:${params.workerId}`,
    mode: "callback",
    metadata: {
      parentSessionId: params.parentSessionId,
      workerId: params.workerId,
      ...(params.shellProfile ? { shellProfile: params.shellProfile } : {}),
      ...(params.workspaceRoot ? { workspaceRoot: params.workspaceRoot } : {}),
      ...(params.workingDirectory
        ? { workingDirectory: params.workingDirectory }
        : {}),
    },
    resourceEnvelope: {
      environmentClass: "runtime-worker",
      enforcement: "best_effort",
    },
  });
  const { body } = parseToolResult(result);
  const handleId =
    typeof body.sessionHandleId === "string" ? body.sessionHandleId : undefined;
  const callback = (
    typeof body.callback === "object" && body.callback !== null
      ? body.callback
      : undefined
  ) as Record<string, unknown> | undefined;
  const callbackToken =
    typeof callback?.authToken === "string" ? callback.authToken : undefined;
  if (!handleId || !callbackToken) {
    throw new Error("Remote session manager did not return a callback handle");
  }
  return {
    handleId,
    callbackToken,
    executionLocation: {
      ...buildRemoteSessionLocation(body),
      ...(params.workspaceRoot ? { workspaceRoot: params.workspaceRoot } : {}),
      ...(params.workingDirectory
        ? { workingDirectory: params.workingDirectory }
        : {}),
    },
  };
}

export async function reportManagedRemoteSession(params: {
  readonly manager: Pick<SystemRemoteSessionManager, "handleWebhook">;
  readonly handleId: string;
  readonly callbackToken: string;
  readonly state: "running" | "completed" | "failed" | "cancelled";
  readonly summary: string;
  readonly artifacts?: readonly string[];
  readonly events?: readonly {
    readonly summary: string;
    readonly kind?: "message" | "status" | "control" | "artifact";
  }[];
}): Promise<void> {
  const response = await params.manager.handleWebhook({
    sessionHandleId: params.handleId,
    headers: {
      authorization: `Bearer ${params.callbackToken}`,
      "x-agenc-event-id": randomUUID(),
    },
    body: {
      state: params.state,
      summary: params.summary,
      ...(params.artifacts && params.artifacts.length > 0
        ? {
            artifacts: params.artifacts.map((artifact) => ({
              kind: artifact.startsWith("http://") || artifact.startsWith("https://")
                ? "url"
                : "file",
              locator: artifact,
            })),
          }
        : {}),
      ...(params.events && params.events.length > 0
        ? {
            events: params.events.map((event) => ({
              summary: event.summary,
              kind: event.kind ?? "status",
              direction: "lifecycle",
            })),
          }
        : {}),
    },
  });
  if (response.status >= 400) {
    const message =
      typeof response.body.error === "object" &&
      response.body.error !== null &&
      typeof (response.body.error as Record<string, unknown>).message === "string"
        ? ((response.body.error as Record<string, unknown>).message as string)
        : `Remote session webhook failed with status ${response.status}`;
    throw new Error(message);
  }
}

export async function startManagedRemoteJob(params: {
  readonly manager: Pick<SystemRemoteJobManager, "start">;
  readonly sessionId: string;
  readonly workspaceRoot?: string;
}): Promise<ManagedRemoteJobHandle> {
  const remoteJobId = `verifier:${params.sessionId}:${randomUUID().slice(0, 8)}`;
  const result = await params.manager.start({
    serverName: "runtime",
    remoteJobId,
    label: remoteJobId,
    idempotencyKey: remoteJobId,
    mode: "callback",
    resourceEnvelope: {
      environmentClass: "runtime-verifier",
      enforcement: "best_effort",
    },
  });
  const { body } = parseToolResult(result);
  const handleId =
    typeof body.jobHandleId === "string" ? body.jobHandleId : undefined;
  const callback = (
    typeof body.callback === "object" && body.callback !== null
      ? body.callback
      : undefined
  ) as Record<string, unknown> | undefined;
  const callbackToken =
    typeof callback?.authToken === "string" ? callback.authToken : undefined;
  if (!handleId || !callbackToken) {
    throw new Error("Remote job manager did not return a callback handle");
  }
  return {
    handleId,
    callbackToken,
    executionLocation: {
      ...buildRemoteJobLocation(body),
      ...(params.workspaceRoot ? { workspaceRoot: params.workspaceRoot } : {}),
      ...(params.workspaceRoot ? { workingDirectory: params.workspaceRoot } : {}),
    },
  };
}

export async function reportManagedRemoteJob(params: {
  readonly manager: Pick<SystemRemoteJobManager, "handleWebhook">;
  readonly handleId: string;
  readonly callbackToken: string;
  readonly state: "running" | "completed" | "failed" | "cancelled";
  readonly summary: string;
  readonly artifacts?: readonly string[];
}): Promise<void> {
  const response = await params.manager.handleWebhook({
    jobHandleId: params.handleId,
    headers: {
      authorization: `Bearer ${params.callbackToken}`,
      "x-agenc-event-id": randomUUID(),
    },
    body: {
      state: params.state,
      summary: params.summary,
      ...(params.artifacts && params.artifacts.length > 0
        ? {
            artifacts: params.artifacts.map((artifact) => ({
              kind: artifact.startsWith("http://") || artifact.startsWith("https://")
                ? "url"
                : "file",
              locator: artifact,
            })),
          }
        : {}),
    },
  });
  if (response.status >= 400) {
    const message =
      typeof response.body.error === "object" &&
      response.body.error !== null &&
      typeof (response.body.error as Record<string, unknown>).message === "string"
        ? ((response.body.error as Record<string, unknown>).message as string)
        : `Remote job webhook failed with status ${response.status}`;
    throw new Error(message);
  }
}
