/**
 * What an AgenC Core 0.19.25 daemon accepts, frozen for compatibility tests.
 *
 * Copied from 0.19.25 (commit 1e4cf9c35)
 * runtime/src/app-server/daemon-dispatcher.ts: `negotiateInitializeProtocol`
 * with `isCompatibleProtocolVersion` (protocol 1.34.0), and
 * `validateMessageStreamParams` with `validateObjectShape`,
 * `validateMessageContent` and `isValidMessageContentBlock`. Do not update it
 * from newer sources: it stands for the daemon a newer TUI may still meet.
 */

/** The protocol a 0.19.25 daemon and TUI speak. */
export const PROTOCOL_0_19_25 = "1.34.0";

export class Daemon01925ParamsError extends Error {}

type Negotiated01925 =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly error: {
        readonly code: -32000;
        readonly message: "Unsupported protocol version";
        readonly data: {
          readonly code: "PROTOCOL_VERSION_UNSUPPORTED";
          readonly clientVersion: string;
          readonly serverVersion: string;
        };
      };
    };

function parseVersion(version: string): { major: number; minor: number } | undefined {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  if (match === null) return undefined;
  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
  };
}

/** The 0.19.25 daemon's answer to `initialize` at `clientVersion`. */
export function negotiate01925(clientVersion: string): Negotiated01925 {
  const client = parseVersion(clientVersion);
  const server = parseVersion(PROTOCOL_0_19_25)!;
  if (client !== undefined && client.major === server.major && client.minor <= server.minor) {
    return { supported: true };
  }
  return {
    supported: false,
    error: {
      code: -32000,
      message: "Unsupported protocol version",
      data: {
        code: "PROTOCOL_VERSION_UNSUPPORTED",
        clientVersion,
        serverVersion: PROTOCOL_0_19_25,
      },
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidMessageContentBlock(block: unknown): boolean {
  if (!isPlainObject(block)) return false;
  if (block.type === "text") return typeof block.text === "string";
  if (block.type === "image_url") {
    const image = block.image_url;
    return isPlainObject(image) && typeof image.url === "string";
  }
  return false;
}

/** Throws as the 0.19.25 daemon refuses `message.stream` params. */
export function validateMessageStream01925(params: Record<string, unknown>): void {
  const stringFields = ["sessionId", "clientMessageId", "streamId", "ifBusy"];
  const objectFields = ["metadata"];
  const valueFields = ["content", "exactOutput"];
  const allowed = new Set([...stringFields, ...objectFields, ...valueFields]);
  for (const [key, value] of Object.entries(params)) {
    if (!allowed.has(key)) {
      throw new Daemon01925ParamsError(`message.stream does not accept param '${key}'`);
    }
    if (value === undefined) continue;
    if (stringFields.includes(key) && typeof value !== "string") {
      throw new Daemon01925ParamsError(`message.stream param '${key}' must be a string`);
    }
    if (objectFields.includes(key) && !isPlainObject(value)) {
      throw new Daemon01925ParamsError(`message.stream param '${key}' must be an object`);
    }
  }
  if (typeof params.sessionId !== "string" || params.sessionId.trim().length === 0) {
    throw new Daemon01925ParamsError("message.stream requires sessionId");
  }
  const content = params.content;
  if (typeof content !== "string" && !Array.isArray(content)) {
    throw new Daemon01925ParamsError("message.stream param 'content' must be a string or array");
  }
  if (Array.isArray(content)) {
    for (const [index, block] of content.entries()) {
      if (!isValidMessageContentBlock(block)) {
        throw new Daemon01925ParamsError(
          `message.stream param 'content[${index}]' must be a text or image_url block`,
        );
      }
    }
  }
  if (params.ifBusy !== undefined && params.ifBusy !== "reject") {
    throw new Daemon01925ParamsError("message.stream param 'ifBusy' must be 'reject'");
  }
  if (params.exactOutput !== undefined && typeof params.exactOutput !== "boolean") {
    throw new Daemon01925ParamsError("message.stream param exactOutput must be a boolean");
  }
}

/**
 * `message.stream` params as the 0.19.25 TUI sends them: no
 * `skillInvocation`, which it never had.
 */
export function messageStreamFrom01925Tui(sessionId: string): Record<string, unknown> {
  return {
    sessionId,
    content: "review the diff",
    metadata: { displayUserMessage: "$deep-review" },
    clientMessageId: "msg-01925",
    streamId: "stream-01925",
  };
}
