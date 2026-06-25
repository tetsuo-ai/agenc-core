// Per-connection translator: app JSON-RPC 2.0 <-> daemon gateway `{type,...}`. One adapter instance
// per app socket, holding per-connection turn + correlation state. P1 ships single-turn-at-a-time
// per session (the gateway's phase:"idle" is a reliable per-turn signal only when turns don't
// overlap), so concurrent messages on one session are SERIALIZED here until the turn ends. The
// daemon's new turn-id-stamped `turn.complete` (when present) is also honored.

import {
  APP_METHODS,
  GW,
  NOTIFY,
  PORTAL_PROTOCOL_VERSION,
  RPC,
  mapGatewayError,
  type GatewayEnvelope,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from "./portal-protocol.js";

export interface PortalAdapterOptions {
  sendToApp: (msg: JsonRpcResponse | JsonRpcNotification) => void;
  sendToGateway: (envelope: Record<string, unknown>) => void;
  /** True for the relay/remote transport. Gates privileged actions the loopback path allows freely
   *  (the adapter is the SOLE scope-enforcement point for the remote leg — the daemon treats the
   *  loopback socket as full-privilege operator). */
  isRemote?: boolean;
  logger?: (msg: string) => void;
}

/** Fail-closed gate: only obviously read-only actions may be approved by a REMOTE client (P2a). A
 *  remote relay client must NOT be able to self-approve shell/wallet/destructive/file-mutating tools
 *  — otherwise a leaked ticket runs privileged ops with no human on the device. */
function remotelyApprovable(action: string): boolean {
  const a = action.toLowerCase();
  if (
    /bash|shell|exec|command|\brun\b|spawn|write|edit|create|update|delete|remove|\brm\b|destroy|drop|wallet|transfer|\bsend\b|sign|airdrop|swap|\bpay\b|config|sudo|kill|reload|install|chmod|chown|\bmv\b|\bcp\b/.test(
      a,
    )
  ) {
    return false;
  }
  return /read|list|view|search|grep|glob|fetch|\bget\b|\bcat\b|show|inspect|status|browse/.test(a);
}

type RpcId = string | number | null;

function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Map a tool name to one of the app's ToolKind raw values (icon/label hints). */
function toolKind(name = ""): string {
  const n = name.toLowerCase();
  if (/edit|write|apply|patch|create|update/.test(n)) return "fileEdit";
  if (/read|list|cat|view|open/.test(n)) return "fileRead";
  if (/search|grep|find|glob/.test(n)) return "search";
  if (/web|fetch|http|url/.test(n)) return "web";
  if (/bash|shell|exec|command|run/.test(n)) return "bash";
  return "task";
}

function short(v: unknown, n = 400): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export class PortalAdapter {
  private appSessionId: string | null = null;
  private gatewaySessionId: string | undefined;
  private readonly pending = new Map<string, { appId: RpcId; method: string }>();
  private streamedThisTurn = false;
  private turnActive = false;
  private readonly turnQueue: string[] = [];
  /** requestId -> action, captured from approval.request so tool.approve can be scope-checked. */
  private readonly pendingApprovals = new Map<string, string>();
  private readonly isRemote: boolean;

  constructor(private readonly opts: PortalAdapterOptions) {
    this.isRemote = opts.isRemote ?? false;
  }

  // ---- app JSON-RPC -> gateway {type} ----

  handleAppMessage(raw: string): void {
    let msg: { id?: RpcId; method?: string; params?: unknown };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    const id: RpcId = msg.id ?? null;
    const method = msg.method ?? "";
    const params = asObj(msg.params);

    switch (method) {
      case RPC.initialize:
        this.reply(id, {
          protocol: { version: PORTAL_PROTOCOL_VERSION },
          capabilities: { "daemon.methods": APP_METHODS },
        });
        break;
      case RPC.healthPing:
        this.sendGateway({ type: GW.ping, id: String(id) }, { appId: id, method });
        break;
      case RPC.sessionList:
        this.sendGateway(
          { type: GW.chatSessionList, id: String(id), payload: {} },
          { appId: id, method },
        );
        break;
      case RPC.sessionAttach: {
        this.appSessionId = asStr(params.sessionId) || this.appSessionId;
        this.reply(id, { sessionId: this.appSessionId });
        // No scrollback fetch on attach: the app's sessionId is a client-local id the gateway does
        // not own yet (requesting chat.history for it returns "Not authorized to access this
        // session"), and the app restores its own persisted transcript. P2/P4 reconcile session ids
        // with the gateway (chat.session.resume) and add real server-side scrollback replay.
        break;
      }
      case RPC.messageSend:
      case RPC.messageStream: {
        this.appSessionId = asStr(params.sessionId) || this.appSessionId;
        const content = asStr(params.content);
        this.reply(id, {
          messageId: `m-${Date.now()}`,
          streamId: `st-${Date.now()}`,
          acceptedAt: Date.now(),
        });
        this.enqueueTurn(content);
        break;
      }
      case RPC.toolApprove: {
        const requestId = asStr(params.requestId);
        if (this.isRemote) {
          const action = this.pendingApprovals.get(requestId) ?? "";
          if (!remotelyApprovable(action)) {
            // A remote client must NOT self-approve a privileged tool it just triggered (M1). Reject
            // the tool on the gateway and tell the client a device-local human confirm is required.
            this.opts.logger?.(`[portal] denied remote approval of "${action}" (req ${requestId})`);
            this.replyErr(id, -32001, `remote approval not allowed for "${action || "this action"}"; requires device-local confirmation`);
            this.sendGateway({ type: GW.approvalRespond, payload: { requestId, approved: false } });
            this.pendingApprovals.delete(requestId);
            break;
          }
        }
        this.pendingApprovals.delete(requestId);
        this.reply(id, { ok: true });
        this.sendGateway({ type: GW.approvalRespond, payload: { requestId, approved: true } });
        break;
      }
      case RPC.toolDeny: {
        const requestId = asStr(params.requestId);
        this.pendingApprovals.delete(requestId);
        this.reply(id, { ok: true });
        this.sendGateway({ type: GW.approvalRespond, payload: { requestId, approved: false } });
        break;
      }
      case RPC.setPermissionMode: {
        const mode = asStr(params.permissionMode);
        // A remote client must never be able to relax the approval mode (M3). This denylist must
        // remain when P3 actually wires setPermissionMode, so the wiring physically can't expose
        // yolo/bypass to the relay leg.
        if (this.isRemote && /yolo|bypass|allow|unsafe|auto/i.test(mode)) {
          this.replyErr(id, -32001, `permission mode "${mode}" not allowed from a remote client`);
          break;
        }
        // P1/P2a: acknowledged but not enforced server-side. P3 wires this to a per-session overlay
        // on the ApprovalEngine (the elevations/denials precedent) via session.permissionMode.set.
        this.reply(id, { ok: true, permissionMode: mode });
        break;
      }
      case RPC.agentList:
        this.reply(id, { agents: [] });
        break;
      case RPC.daemonInfo:
        this.sendGateway({ type: GW.configGet, id: String(id) }, { appId: id, method });
        break;
      default:
        this.reply(id, {});
    }
  }

  /** Serialize one turn at a time per session (P1): queue while a turn is in flight. */
  private enqueueTurn(content: string): void {
    if (this.turnActive) {
      this.turnQueue.push(content);
      return;
    }
    this.startTurn(content);
  }

  private startTurn(content: string): void {
    this.turnActive = true;
    this.streamedThisTurn = false;
    this.sendGateway({ type: GW.chatMessage, payload: { content } });
  }

  /** Idempotent turn-end: fired by phase:"idle", chat.response, or the turn.complete envelope. */
  private onTurnEnd(): void {
    if (!this.turnActive) return;
    this.turnActive = false;
    const next = this.turnQueue.shift();
    if (next !== undefined) this.startTurn(next);
  }

  // ---- gateway {type} -> app JSON-RPC ----

  handleGatewayMessage(gw: GatewayEnvelope): void {
    const sid = this.appSessionId ?? "s-1";

    // Correlated responses (ping / config.get / session.list) echo the string id we sent.
    if (gw.id !== undefined && gw.id !== null && this.pending.has(String(gw.id))) {
      const entry = this.pending.get(String(gw.id));
      this.pending.delete(String(gw.id));
      const appId = entry?.appId ?? null;
      const method = entry?.method ?? "";
      if (gw.error !== undefined && gw.error !== null) {
        const text = asStr(gw.error) || JSON.stringify(gw.error);
        this.replyErr(appId, mapGatewayError(text), text);
        return;
      }
      if (method === RPC.healthPing) {
        this.reply(appId, { ok: true });
        return;
      }
      if (method === RPC.daemonInfo) {
        const llm = asObj(asObj(gw.payload).llm); // only safe fields — never the apiKey
        this.reply(appId, {
          model: asStr(llm.model),
          provider: asStr(llm.provider),
          baseUrl: asStr(llm.baseUrl),
        });
        return;
      }
      if (method === RPC.sessionList) {
        const sessions = asArr(gw.payload).map((r) => {
          const rec = asObj(r);
          return {
            sessionId: asStr(rec.sessionId) || asStr(rec.id),
            title: asStr(rec.label) || asStr(rec.sessionId) || asStr(rec.id),
            cwd: asStr(rec.workspaceRoot) || asStr(rec.repoRoot),
            subtitle: asStr(rec.preview) || asStr(rec.lastAssistantOutputPreview),
            status: rec.connected ? "working" : "idle",
            updated: "",
          };
        });
        this.reply(appId, { sessions });
        return;
      }
      this.reply(appId, asObj(gw.payload));
      return;
    }

    const payload = asObj(gw.payload);
    switch (gw.type) {
      case GW.chatSession:
        this.gatewaySessionId = asStr(payload.sessionId) || this.gatewaySessionId;
        break;
      case GW.chatHistory: {
        const items = asArr(gw.payload).map((h) => {
          const hh = asObj(h);
          const sender = asStr(hh.sender);
          return {
            role: sender === "agent" ? "assistant" : sender === "tool" ? "tool" : "user",
            text: asStr(hh.content),
          };
        });
        if (items.length) this.sessEvent(sid, { type: "session_configured", initialMessages: items });
        break;
      }
      case GW.agentStatus: {
        const phase = asStr(payload.phase);
        if (phase === "thinking") {
          this.sessEvent(sid, { type: "turn_started", turnId: `t-${Date.now()}` });
        } else if (phase === "idle") {
          this.sessEvent(sid, { type: "turn_complete", turnId: "t-done" });
          this.onTurnEnd();
        }
        break;
      }
      case GW.chatStream: {
        const c = asStr(payload.content);
        if (c) {
          this.streamedThisTurn = true;
          this.notify(NOTIFY.messageChunk, { sessionId: sid, delta: c });
        }
        break;
      }
      case GW.chatResponse:
        this.sessEvent(sid, { type: "turn_complete", turnId: "t-done" });
        this.onTurnEnd();
        break;
      case GW.turnComplete: {
        // Daemon's guaranteed, turn-id-stamped end signal (the core hardening). Authoritative.
        const turnId = asStr(payload.turnTraceId) || "t-done";
        this.sessEvent(sid, { type: "turn_complete", turnId });
        this.onTurnEnd();
        break;
      }
      case GW.chatUsage: {
        const econ = asObj(payload.economics);
        const total = asNum(payload.totalTokens);
        const prompt = asNum(payload.promptTokens);
        this.sessEvent(sid, {
          type: "token_count",
          input: prompt,
          output: Math.max(0, total - prompt),
          // The gateway has no USD price — surface the real abstract spend units (the app labels it).
          costUSD: asNum(econ.totalSpendUnits),
        });
        break;
      }
      case GW.toolsExecuting:
        this.notify(NOTIFY.toolRequest, {
          sessionId: sid,
          callId: asStr(payload.toolCallId),
          toolName: asStr(payload.toolName),
          title: asStr(payload.toolName) || "tool",
          kind: toolKind(asStr(payload.toolName)),
        });
        break;
      case GW.toolsResult:
        this.sessEvent(sid, {
          type: "tool_call_completed",
          callId: asStr(payload.toolCallId),
          result: short(payload.result),
          isError: Boolean(payload.isError),
        });
        break;
      case GW.approvalRequest: {
        const requestId = asStr(payload.requestId);
        const action = asStr(payload.action) || "tool";
        this.pendingApprovals.set(requestId, action); // so tool.approve can be scope-checked (M1)
        this.notify(NOTIFY.permissionRequest, {
          sessionId: sid,
          requestId,
          toolName: action,
          title: action || "Approve action",
          detail: asStr(payload.message) || short(payload.details),
          kind: "tool",
          permissions: [],
        });
        break;
      }
      case GW.chatMessage: {
        // The final full assistant message. If we already streamed via chat.stream this is a
        // duplicate (suppress); if the gateway one-shot the answer, THIS is the response.
        const sender = asStr(payload.sender) || "agent";
        const content = asStr(payload.content);
        if (sender === "agent" && !this.streamedThisTurn && content) {
          this.sessEvent(sid, { type: "agent_message", message: content });
        }
        break;
      }
      case GW.error:
        this.opts.logger?.(`[portal] gateway error: ${asStr(gw.error) || JSON.stringify(gw.error)}`);
        break;
      default:
        break; // chat.typing, pong, status, and unknown events are ignored
    }
  }

  /** Gateway socket dropped: fail any awaited app calls so the client isn't left hanging. */
  handleGatewayClose(): void {
    for (const [, entry] of this.pending) {
      this.replyErr(entry.appId, -32002, "gateway connection closed");
    }
    this.pending.clear();
  }

  // ---- helpers ----

  private sendGateway(
    envelope: Record<string, unknown>,
    pending?: { appId: RpcId; method: string },
  ): void {
    if (pending && envelope.id !== undefined && envelope.id !== null) {
      this.pending.set(String(envelope.id), pending);
    }
    this.opts.sendToGateway(envelope);
  }

  private reply(id: RpcId, result: unknown): void {
    this.opts.sendToApp({ jsonrpc: "2.0", id, result });
  }
  private replyErr(id: RpcId, code: number, message: string): void {
    this.opts.sendToApp({ jsonrpc: "2.0", id, error: { code, message } });
  }
  private notify(method: string, params: Record<string, unknown>): void {
    this.opts.sendToApp({ jsonrpc: "2.0", method, params });
  }
  private sessEvent(sid: string, event: Record<string, unknown>): void {
    this.notify(NOTIFY.sessionEvent, { sessionId: sid, event });
  }
}
