import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { JsonObject } from "../app-server/protocol/index.js";
import { RemoteError, type RemoteDevice, type RemoteRole } from "./types.js";
import type { RemoteApprovalProjection } from "./approvals.js";

export interface RemoteGrant {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly sessionIds: readonly string[];
  readonly role: RemoteRole;
  readonly allowFiles: boolean;
  readonly allowApprovals: boolean;
}
export interface RemoteSessionLookup {
  (sessionId: string): Promise<{ readonly sessionId: string; readonly cwd?: string; readonly [key: string]: unknown } | null>;
}
export const BROWSER_METHODS = ["initialize", "session.list", "session.create", "session.transcript.v2", "session.artifact.read", "message.send", "session.cancelTurn", "tool.approve", "tool.deny", "remote.pendingApprovals", "files.list", "files.read"] as const;

/** Compare canonical paths with the host's path semantics (Windows drive/case included). */
export function pathWithin(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const implementation = platform === "win32" ? path.win32 : path.posix;
  const normalize = (value: string) => platform === "win32" ? value.toLowerCase() : value;
  const relative = implementation.relative(normalize(root), normalize(target));
  return relative === "" || (!implementation.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${implementation.sep}`));
}
export function canonicalRemoteWorkspace(workspacePath: string, privateHome: string): string {
  if (!path.isAbsolute(workspacePath)) throw new RemoteError("REMOTE_WORKSPACE_INVALID");
  const root = realpathSync(workspacePath);
  const canonicalPrivateHome = realpathSync(privateHome);
  if (!statSync(root).isDirectory() || root === path.parse(root).root || pathWithin(canonicalPrivateHome, root)) throw new RemoteError("REMOTE_WORKSPACE_INVALID");
  return root;
}

/** Created by the daemon service only, never from JSON-RPC initialize parameters. */
export class RemoteAccessBoundary {
  constructor(
    readonly grant: RemoteGrant,
    private readonly current: () => boolean,
    private readonly lookup: RemoteSessionLookup,
    private readonly privateHome: string,
    private readonly extensions?: {
      readonly approvals: RemoteApprovalProjection;
      readonly createSession?: (title: string) => Promise<{ sessionId: string; agentId: string }>;
      readonly assertControlSession?: (sessionId: string) => Promise<void>;
    },
  ) { this.privateHome = realpathSync(privateHome); }

  assertActive(): void { if (!this.current()) throw new RemoteError("REMOTE_ACCESS_REVOKED"); }
  projection(): JsonObject { return { workspaceId: this.grant.workspaceId, role: this.grant.role, allowFiles: this.grant.allowFiles, allowApprovals: this.grant.role === "control" && this.grant.allowApprovals, supportsSessionCreate: this.grant.role === "control" && this.extensions?.createSession !== undefined }; }
  allowsMethod(method: string): boolean {
    if (!(BROWSER_METHODS as readonly string[]).includes(method)) return false;
    if (["initialize", "session.list", "session.transcript.v2", "session.artifact.read"].includes(method)) return true;
    if (method.startsWith("files.")) return this.grant.allowFiles;
    if (this.grant.role !== "control") return false;
    if (method === "session.create") return this.extensions?.createSession !== undefined;
    if (method.startsWith("tool.") || method === "remote.pendingApprovals") return this.grant.allowApprovals;
    return true;
  }

  async assertSession(sessionId: unknown): Promise<void> {
    this.assertActive();
    if (typeof sessionId !== "string" || !this.grant.sessionIds.includes(sessionId)) throw new RemoteError("REMOTE_SESSION_DENIED");
    const session = await this.lookup(sessionId);
    this.assertActive();
    if (!session?.cwd || !pathWithin(this.grant.workspacePath, realpathSync(session.cwd))) throw new RemoteError("REMOTE_SESSION_DENIED");
  }

  async authorize(method: string, params: JsonObject): Promise<void> {
    this.assertActive();
    if (!(BROWSER_METHODS as readonly string[]).includes(method)) throw new RemoteError("REMOTE_METHOD_DENIED");
    if (method === "initialize" || method === "session.list") return;
    if (method === "session.create") {
      if (this.grant.role !== "control" || !this.extensions?.createSession) throw new RemoteError("REMOTE_METHOD_DENIED");
      if (this.grant.sessionIds.length >= 64 || Object.keys(params).some((key) => key !== "title") || (params.title !== undefined && (typeof params.title !== "string" || params.title.length > 256))) throw new RemoteError("REMOTE_SESSION_CREATE_INVALID");
      return;
    }
    if (method.startsWith("files.")) {
      if (!this.grant.allowFiles) throw new RemoteError("REMOTE_FILES_DENIED");
      return;
    }
    await this.assertSession(params.sessionId);
    if (method === "remote.pendingApprovals") {
      if (!this.grant.allowApprovals || this.grant.role !== "control") throw new RemoteError("REMOTE_APPROVAL_DENIED");
      return;
    }
    if (method === "session.transcript.v2" || method === "session.artifact.read") return;
    if (this.grant.role !== "control") throw new RemoteError("REMOTE_CONTROL_DENIED");
    if (method === "message.send" || method === "tool.approve") {
      await this.extensions?.assertControlSession?.(params.sessionId as string);
      this.assertActive();
    }
    if (method.startsWith("tool.")) {
      if (!this.grant.allowApprovals) throw new RemoteError("REMOTE_APPROVAL_DENIED");
      // A browser can resolve an individual prompt, never create permanent grants.
      if (Object.keys(params).some((key) => !["sessionId", "requestId", "reason", "scope"].includes(key)) || (params.scope !== undefined && params.scope !== "once")) throw new RemoteError("REMOTE_APPROVAL_DENIED");
      if (this.extensions && (typeof params.requestId !== "string" || !this.extensions.approvals.has(params.sessionId as string, params.requestId))) throw new RemoteError("REMOTE_APPROVAL_NOT_PENDING");
    }
    if (method === "message.send") {
      if (Object.keys(params).some((key) => !["sessionId", "content", "clientMessageId", "ifBusy"].includes(key)) || typeof params.content !== "string" || typeof params.clientMessageId !== "string" || params.ifBusy !== "reject") throw new RemoteError("REMOTE_MESSAGE_INVALID");
    }
  }

  async sessions(): Promise<JsonObject> {
    const sessions: JsonObject[] = [];
    for (const sessionId of this.grant.sessionIds) {
      try {
        await this.assertSession(sessionId);
        const session = await this.lookup(sessionId);
        this.assertActive();
        if (session) {
          const projected = Object.fromEntries(Object.entries(session).filter(([key, value]) => ["sessionId", "agentId", "title", "status", "createdAt", "lastActiveAt"].includes(key) && typeof value === "string")) as JsonObject;
          sessions.push({ ...projected, workspaceId: this.grant.workspaceId });
        }
      } catch (error) { if (!(error instanceof RemoteError) || error.code !== "REMOTE_SESSION_DENIED") throw error; }
    }
    return { sessions };
  }
  async createSession(params: JsonObject): Promise<JsonObject> {
    await this.authorize("session.create", params);
    if (realpathSync(this.grant.workspacePath) !== this.grant.workspacePath) throw new RemoteError("REMOTE_WORKSPACE_INVALID");
    const created = await this.extensions!.createSession!(typeof params.title === "string" && params.title.trim() ? params.title.trim() : "Remote session");
    this.assertActive();
    // The service owns this copied list; no browser-provided array is retained.
    (this.grant.sessionIds as string[]).push(created.sessionId);
    return { ...created, workspaceId: this.grant.workspaceId };
  }
  pendingApprovals(sessionId: string): JsonObject { this.assertActive(); return { approvals: this.extensions?.approvals.list(sessionId) ?? [] }; }
  resolveApproval(sessionId: string, requestId: string): void { this.extensions?.approvals.resolve(sessionId, requestId); }

  private filePath(input: unknown): string {
    this.assertActive();
    if (!this.grant.allowFiles || typeof input !== "string" || input.length > 4096 || input.includes("\0") || input.includes(":")) throw new RemoteError("REMOTE_FILES_DENIED");
    // Disallow hidden configuration, common credential names, and all symlinks/junctions.
    const parts = input.split(/[\\/]/u).filter(Boolean);
    if (path.isAbsolute(input) || parts.some((part) => part.startsWith(".") || /^(?:credentials?|secrets?|auth|id_rsa|id_ed25519)(?:\.|$)/iu.test(part) || /\.(?:pem|key|p12|pfx|keystore)$/iu.test(part))) throw new RemoteError("REMOTE_FILES_DENIED");
    let target = this.grant.workspacePath;
    for (const part of parts) {
      target = path.join(target, part);
      if (lstatSync(target).isSymbolicLink()) throw new RemoteError("REMOTE_FILES_DENIED");
    }
    const canonical = realpathSync(target);
    if (!pathWithin(this.grant.workspacePath, canonical) || pathWithin(this.privateHome, canonical)) throw new RemoteError("REMOTE_FILES_DENIED");
    return canonical;
  }

  files(method: "files.list" | "files.read", params: JsonObject): JsonObject {
    const target = this.filePath(params.path ?? "");
    if (method === "files.list") {
      const entries = readdirSync(target, { withFileTypes: true }).slice(0, 500).flatMap((entry) => {
        try { this.filePath(path.relative(this.grant.workspacePath, path.join(target, entry.name))); }
        catch { return []; }
        return entry.isFile() || entry.isDirectory() ? [{ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }] : [];
      });
      return { path: params.path ?? "", entries };
    }
    const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new RemoteError("REMOTE_FILE_LIMIT");
      const current = statSync(this.filePath(params.path));
      if (stat.dev !== current.dev || stat.ino !== current.ino) throw new RemoteError("REMOTE_FILES_DENIED");
      const data = Buffer.alloc(stat.size);
      const bytesRead = readSync(fd, data, 0, data.length, 0);
      this.assertActive();
      if (data.includes(0)) throw new RemoteError("REMOTE_FILE_BINARY");
      return { path: params.path, content: data.subarray(0, bytesRead).toString("utf8") };
    } finally { closeSync(fd); }
  }
}

export function publicDevice(device: RemoteDevice): RemoteDevice { return { ...device, sessionIds: [...device.sessionIds] }; }
