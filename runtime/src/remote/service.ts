import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import QRCode from "qrcode";
import WebSocket from "ws";
import { RemoteApprovalProjection } from "./approvals.js";
import type { AgenCDaemonResponse, JsonObject } from "../app-server/protocol/index.js";
import { canonicalRemoteWorkspace, publicDevice, RemoteAccessBoundary, type RemoteGrant, type RemoteSessionLookup } from "./access.js";
import { RemoteError, type RemoteBackend, type RemoteBackendPair, type RemoteBackendPoll, type RemoteCapabilities, type RemoteDevice, type RemoteMethod, type RemotePairing, type RemotePairParams, type RemoteStatus } from "./types.js";

interface BrowserConnection { dispatch(message: JsonObject): Promise<AgenCDaemonResponse>; close(): Promise<void> }
interface PairRecord {
  readonly pair: RemoteBackendPair;
  readonly grant: RemoteGrant;
  readonly controller: AbortController;
  readonly generation: number;
  readonly peers: Map<string, { connection: BrowserConnection; queued: number; bytes: number }>;
  readonly seen: Set<string>;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
  pairing: RemotePairing;
  device?: RemoteDevice;
  socket?: WebSocket;
  polling: boolean;
  connecting: boolean;
  creatingSession?: boolean;
}
export interface RemoteServiceOptions {
  readonly home: string;
  readonly backend: RemoteBackend;
  readonly lookupSession: RemoteSessionLookup;
  readonly createConnection: (access: RemoteAccessBoundary) => BrowserConnection;
  readonly socket?: (url: string, protocols: string[]) => WebSocket;
  readonly now?: () => number;
  readonly qrDataUrl?: (value: string) => Promise<string>;
  readonly createSession?: (workspacePath: string, title: string, signal: AbortSignal) => Promise<{ sessionId: string; agentId: string }>;
  readonly assertControlSession?: (sessionId: string) => Promise<void>;
}

/** Daemon-owned, opt-in browser service. Grants are ephemeral and require approval after restart. */
export class RemoteService {
  readonly #options: RemoteServiceOptions;
  #enabled = false;
  #generation = 0;
  #controller = new AbortController();
  #pending?: PairRecord;
  #records = new Map<string, PairRecord>();
  #beginning = false;
  #pairingOperation = 0;
  #beginController?: AbortController;
  #error: string | null = null;
  readonly #approvals = new RemoteApprovalProjection();

  constructor(options: RemoteServiceOptions) { this.#options = options; }
  capabilities(): RemoteCapabilities { return { available: true, contractVersion: 1, browserProtocol: "agenc-browser-v2", roles: ["view", "control"], workspaceScope: "explicit-sessions", supportsFiles: true, supportsApprovals: true, supportsSessionCreate: this.#options.createSession !== undefined, supportsPendingApprovals: true, requiresLocalApproval: true, requiresSignIn: true }; }
  observeSessionEvent(sessionId: string, event: JsonObject): void { this.#approvals.observe(sessionId, event); }
  status(): RemoteStatus {
    const devices = [...this.#records.values()].flatMap((record) => record.device ? [publicDevice({ ...record.device, connected: record.socket?.readyState === WebSocket.OPEN && record.peers.size > 0 })] : []);
    const connectedDevices = devices.filter((device) => device.connected).length;
    return { enabled: this.#enabled, state: !this.#enabled ? "stopped" : this.#error ? "error" : connectedDevices ? "connected" : this.#pending ? "pairing" : this.#records.size ? ([...this.#records.values()].some((record) => record.socket?.readyState === WebSocket.OPEN) ? "idle" : [...this.#records.values()].some((record) => record.connecting) ? "connecting" : "reconnecting") : "idle", connectedDevices, devices, pairing: this.#pending ? { ...this.#pending.pairing, sessionIds: [...this.#pending.pairing.sessionIds] } : null, error: this.#error };
  }
  start(): RemoteStatus {
    if (!this.#enabled) { this.#enabled = true; this.#generation++; this.#controller = new AbortController(); this.#error = null; }
    return this.status();
  }
  stop(): RemoteStatus {
    this.#enabled = false; this.#generation++; this.#controller.abort(); this.#beginController?.abort(); this.#pairingOperation++; this.#beginning = false;
    const records = new Set([...this.#records.values(), ...(this.#pending ? [this.#pending] : [])]);
    this.#pending = undefined; this.#records.clear(); this.#error = null;
    for (const record of records) { this.#dispose(record); this.#revokeBackend(record.pair); }
    return this.status();
  }
  close(): void { this.stop(); }
  #valid(record: PairRecord): boolean { return this.#enabled && record.generation === this.#generation && !record.controller.signal.aborted; }
  #assertGeneration(generation: number): void { if (!this.#enabled || generation !== this.#generation) throw new RemoteError("REMOTE_OPERATION_CANCELLED"); }
  #later(record: PairRecord, delay: number, callback: () => void): void {
    if (!this.#valid(record)) return;
    const timer = setTimeout(() => { record.timers.delete(timer); if (this.#valid(record)) callback(); }, delay);
    timer.unref?.(); record.timers.add(timer);
  }
  #dispose(record: PairRecord): void {
    record.controller.abort();
    for (const timer of record.timers) clearTimeout(timer);
    record.timers.clear();
    const socket = record.socket; record.socket = undefined;
    if (socket) { try { socket.terminate(); } catch { /* already closed */ } }
    for (const peer of record.peers.values()) void peer.connection.close().catch(() => {});
    record.peers.clear();
  }
  #revokeBackend(pair: RemoteBackendPair): void { void this.#options.backend.revoke(pair, AbortSignal.timeout(10_000)).catch(() => {}); }

  async begin(params: RemotePairParams): Promise<RemoteStatus> {
    if (!this.#enabled) throw new RemoteError("REMOTE_NOT_STARTED");
    if (this.#beginning || this.#pending) throw new RemoteError("REMOTE_PAIRING_EXISTS");
    if (this.#records.size >= 8) throw new RemoteError("REMOTE_DEVICE_LIMIT");
    if (!params || typeof params.workspacePath !== "string" || !["view", "control"].includes(params.role) || !Array.isArray(params.sessionIds) || (params.sessionIds.length < 1 && params.role === "view") || params.sessionIds.length > 64 || params.sessionIds.some((id) => typeof id !== "string" || id.length > 512) || (params.allowFiles !== undefined && typeof params.allowFiles !== "boolean") || (params.allowApprovals !== undefined && typeof params.allowApprovals !== "boolean")) throw new RemoteError("REMOTE_GRANT_INVALID");
    const generation = this.#generation;
    const operation = ++this.#pairingOperation;
    const controller = new AbortController(); this.#beginController = controller;
    const signal = AbortSignal.any([controller.signal, this.#controller.signal]);
    const assertCurrent = () => { this.#assertGeneration(generation); if (operation !== this.#pairingOperation || signal.aborted) throw new RemoteError("REMOTE_OPERATION_CANCELLED"); };
    this.#beginning = true;
    let pair: RemoteBackendPair | undefined;
    try {
      const grant: RemoteGrant = { workspaceId: randomUUID(), workspacePath: canonicalRemoteWorkspace(params.workspacePath, this.#options.home), sessionIds: [...new Set(params.sessionIds)], role: params.role, allowFiles: params.allowFiles === true, allowApprovals: params.role === "control" && params.allowApprovals === true };
      const access = new RemoteAccessBoundary(grant, () => this.#enabled && generation === this.#generation, this.#options.lookupSession, this.#options.home);
      for (const id of grant.sessionIds) { await access.assertSession(id); if (grant.role === "control") await this.#options.assertControlSession?.(id); }
      assertCurrent();
      pair = await this.#options.backend.start({ machineName: hostname() || "Computer", role: grant.role, workspaceIds: [grant.workspaceId] }, signal);
      assertCurrent();
      const qrDataUrl = await (this.#options.qrDataUrl ?? ((value) => QRCode.toDataURL(value, { width: 256, margin: 2 })))(pair.pairUrl);
      assertCurrent();
      const record: PairRecord = { pair, grant, generation, controller: new AbortController(), peers: new Map(), seen: new Set(), timers: new Set(), polling: false, connecting: false, pairing: { pairingId: pair.pairingId, code: pair.code, pairUrl: pair.pairUrl, qrDataUrl, expiresAt: pair.expiresAt, status: "pending", ...grant } };
      this.#pending = record; this.#error = null;
      this.#later(record, 1_500, () => { void this.#pollPending(record); });
      return this.status();
    } catch (error) {
      if (pair) this.#revokeBackend(pair);
      // The caller receives this refusal. It describes one request (a task
      // that cannot be shared, a folder outside the project), not the
      // service, so it is not kept as the service's error: that turned every
      // later status into "error" until the next successful pairing.
      throw error instanceof RemoteError ? error : new RemoteError("REMOTE_PAIRING_FAILED");
    } finally { if (generation === this.#generation && operation === this.#pairingOperation) { this.#beginning = false; this.#beginController = undefined; } }
  }
  async refresh(): Promise<RemoteStatus> {
    const record = this.#pending;
    if (!record) throw new RemoteError("REMOTE_PAIRING_MISSING");
    const params: RemotePairParams = { workspacePath: record.grant.workspacePath, sessionIds: record.grant.sessionIds, role: record.grant.role, allowFiles: record.grant.allowFiles, allowApprovals: record.grant.allowApprovals };
    this.cancelPair(); return this.begin(params);
  }
  cancelPair(): RemoteStatus {
    this.#pairingOperation++; this.#beginController?.abort(); this.#beginController = undefined; this.#beginning = false;
    const record = this.#pending; this.#pending = undefined;
    if (record) { this.#dispose(record); this.#revokeBackend(record.pair); }
    return this.status();
  }
  #verifyPoll(record: PairRecord, poll: RemoteBackendPoll): void {
    if (poll.pairingId !== record.pair.pairingId || (poll.device && (poll.device.role !== record.grant.role || poll.device.workspaceIds.length !== 1 || poll.device.workspaceIds[0] !== record.grant.workspaceId))) throw new RemoteError("REMOTE_DEVICE_MISMATCH");
  }
  async #pollPending(record: PairRecord): Promise<void> {
    if (!this.#valid(record) || this.#pending !== record || record.polling) return;
    if (Date.parse(record.pair.expiresAt) <= (this.#options.now?.() ?? Date.now())) { this.cancelPair(); this.#error = "REMOTE_PAIRING_EXPIRED"; return; }
    record.polling = true;
    try {
      const poll = await this.#options.backend.poll(record.pair, record.controller.signal);
      if (!this.#valid(record) || this.#pending !== record) return;
      this.#verifyPoll(record, poll);
      this.#error = null;
      if (poll.status === "revoked" || poll.status === "expired") { this.cancelPair(); this.#error = "REMOTE_PAIRING_EXPIRED"; return; }
      if (poll.device) record.pairing = { ...record.pairing, status: "claimed", deviceId: poll.device.deviceId, deviceLabel: poll.device.label };
    } catch { if (this.#valid(record)) this.#error = "REMOTE_BACKEND_UNREACHABLE"; }
    finally { record.polling = false; if (this.#pending === record) this.#later(record, 2_000, () => { void this.#pollPending(record); }); }
  }
  async approve(deviceId: string): Promise<RemoteStatus> {
    const record = this.#pending;
    if (!record || !deviceId || record.pairing.deviceId !== deviceId) throw new RemoteError("REMOTE_DEVICE_NOT_PENDING");
    // Remove the pending action synchronously: double clicks cannot approve twice.
    this.#pending = undefined;
    this.#records.set(deviceId, record);
    try {
      const poll = await this.#options.backend.approve(record.pair, deviceId, record.controller.signal);
      if (!this.#valid(record) || this.#records.get(deviceId) !== record) throw new RemoteError("REMOTE_OPERATION_CANCELLED");
      this.#verifyPoll(record, poll);
      if (poll.status !== "active" || poll.device?.deviceId !== deviceId || !poll.hostTicket) throw new RemoteError("REMOTE_APPROVAL_FAILED");
      record.device = { ...record.grant, deviceId, label: poll.device.label.slice(0, 128), connected: false, approvedAt: new Date(this.#options.now?.() ?? Date.now()).toISOString() };
      this.#error = null; this.#connect(record, poll);
      return this.status();
    } catch (error) { if (this.#records.get(deviceId) === record) this.#records.delete(deviceId); this.#dispose(record); this.#revokeBackend(record.pair); throw error instanceof RemoteError ? error : new RemoteError("REMOTE_APPROVAL_FAILED"); }
  }
  revoke(deviceId: string): RemoteStatus {
    const record = this.#records.get(deviceId); this.#records.delete(deviceId);
    if (record) { this.#dispose(record); this.#revokeBackend(record.pair); }
    return this.status();
  }

  #connect(record: PairRecord, poll: RemoteBackendPoll): void {
    if (!this.#valid(record) || !record.device) return;
    if (!poll.hostTicket) { this.#error = "REMOTE_TICKET_EXPIRED"; this.#later(record, 5_000, () => { void this.#reconnect(record); }); return; }
    const expiry = Date.parse(poll.ticketExpiresAt ?? "");
    if (!Number.isFinite(expiry) || expiry <= (this.#options.now?.() ?? Date.now()) + 5_000) { this.#error = "REMOTE_TICKET_EXPIRED"; this.#later(record, 5_000, () => { void this.#reconnect(record); }); return; }
    const url = new URL("/v2/host", record.pair.relayUrl);
    record.connecting = true;
    const socket = (this.#options.socket ?? ((address, protocols) => new WebSocket(address, protocols, { maxPayload: 512 * 1024, handshakeTimeout: 15_000 })))(url.toString(), ["agenc-browser-v2", poll.hostTicket]);
    record.socket = socket;
    socket.on("open", () => {
      if (!this.#valid(record) || record.socket !== socket) { socket.terminate(); return; }
      record.connecting = false; this.#error = null;
      const heartbeat = () => {
        if (record.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
        try { socket.send(JSON.stringify({ t: "ping" })); } catch { socket.terminate(); return; }
        this.#later(record, 25_000, heartbeat);
      };
      this.#later(record, 25_000, heartbeat);
    });
    socket.on("message", (data) => { if (this.#valid(record) && record.socket === socket) this.#receive(record, data.toString()); });
    socket.on("error", () => { /* close handles retry; never expose ticket-bearing diagnostics */ });
    socket.on("close", () => {
      if (record.socket !== socket) return;
      record.socket = undefined; record.connecting = false;
      for (const peer of record.peers.values()) void peer.connection.close().catch(() => {});
      record.peers.clear();
      this.#later(record, 2_000, () => { void this.#reconnect(record); });
    });
    this.#later(record, Math.max(1_000, expiry - (this.#options.now?.() ?? Date.now()) - 30_000), () => { if (record.socket === socket) socket.terminate(); });
  }
  async #reconnect(record: PairRecord): Promise<void> {
    try {
      const poll = await this.#options.backend.poll(record.pair, record.controller.signal);
      if (!this.#valid(record)) return;
      this.#verifyPoll(record, poll);
      if (poll.status !== "active" || poll.device?.deviceId !== record.device?.deviceId) { if (record.device) this.revoke(record.device.deviceId); return; }
      this.#connect(record, poll);
    } catch { if (this.#valid(record)) { this.#error = "REMOTE_BACKEND_UNREACHABLE"; this.#later(record, 5_000, () => { void this.#reconnect(record); }); } }
  }
  #send(record: PairRecord, cid: string, response: unknown): void {
    if (!this.#valid(record) || record.socket?.readyState !== WebSocket.OPEN) return;
    let envelope = JSON.stringify({ t: "data", cid, payload: JSON.stringify(response) });
    if (Buffer.byteLength(envelope) > 1024 * 1024) {
      const id = response && typeof response === "object" && "id" in response ? response.id : null;
      envelope = JSON.stringify({ t: "data", cid, payload: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Remote response exceeds the supported size", data: { code: "REMOTE_RESPONSE_LIMIT" } } }) });
    }
    if (record.socket.bufferedAmount + Buffer.byteLength(envelope) > 1024 * 1024) { record.socket.terminate(); return; }
    try { record.socket.send(envelope); } catch { record.socket.terminate(); }
  }
  #receive(record: PairRecord, raw: string): void {
    if (Buffer.byteLength(raw) > 512 * 1024) { record.socket?.terminate(); return; }
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (!frame || typeof frame.cid !== "string" || frame.cid.length > 128) return;
    const cid = frame.cid;
    if (frame.t === "peer" && frame.event === "close") { const peer = record.peers.get(cid); record.peers.delete(cid); void peer?.connection.close().catch(() => {}); return; }
    // All identity fields are relay-authenticated metadata, never parsed from payload.
    if (!record.device || frame.deviceId !== record.device.deviceId || frame.role !== record.grant.role || !Array.isArray(frame.workspaceIds) || frame.workspaceIds.length !== 1 || frame.workspaceIds[0] !== record.grant.workspaceId) return;
    if (frame.t !== "data" || typeof frame.payload !== "string") return;
    let message: JsonObject;
    try { message = JSON.parse(frame.payload) as JsonObject; } catch { return; }
    if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.id !== "string" || message.id.length < 1 || message.id.length > 128 || typeof message.method !== "string") return;
    const fail = (code: string) => this.#send(record, cid, { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: code, data: { code } } });
    const mutation = ["session.create", "message.send", "session.cancelTurn", "tool.approve", "tool.deny"].includes(message.method);
    // Read polling cannot exhaust mutation replay protection. Mutation IDs are never
    // evicted while their grant is live; a new explicit pairing resets that ledger.
    if (mutation && (record.seen.has(message.id) || record.seen.size >= 4096)) { fail("REMOTE_REPLAY_DENIED"); return; }
    if (mutation) record.seen.add(message.id);
    let peer = record.peers.get(cid);
    if (!peer) {
      if (record.peers.size >= 4) { fail("REMOTE_PEER_LIMIT"); return; }
      const access = new RemoteAccessBoundary(record.grant, () => this.#valid(record) && this.#records.get(record.device!.deviceId) === record && record.peers.has(cid), this.#options.lookupSession, this.#options.home, { approvals: this.#approvals, assertControlSession: this.#options.assertControlSession, ...(this.#options.createSession ? { createSession: async (title: string) => {
        if (record.creatingSession) throw new RemoteError("REMOTE_SESSION_CREATE_BUSY");
        record.creatingSession = true;
        try { return await this.#options.createSession!(record.grant.workspacePath, title, record.controller.signal); }
        finally { record.creatingSession = false; }
      } } : {}) });
      peer = { connection: this.#options.createConnection(access), queued: 0, bytes: 0 };
      record.peers.set(cid, peer);
    }
    const bytes = Buffer.byteLength(frame.payload);
    if (peer.queued >= 32 || peer.bytes + bytes > 1024 * 1024) { fail("REMOTE_QUEUE_LIMIT"); return; }
    peer.queued++; peer.bytes += bytes;
    const current = peer;
    // Requests use the daemon's own turn admission. Control and read requests
    // must remain available while message.send is awaiting a long-running turn.
    void (async () => {
      if (!this.#valid(record) || record.peers.get(cid) !== current) return;
      const result = await current.connection.dispatch(message);
      if (this.#valid(record) && record.peers.get(cid) === current) this.#send(record, cid, result);
    })().catch(() => { fail("REMOTE_REQUEST_FAILED"); }).finally(() => { current.queued--; current.bytes -= bytes; });
  }

  async handle(method: RemoteMethod, params: JsonObject): Promise<JsonObject> {
    let result: unknown;
    switch (method) {
      case "remote.capabilities": result = this.capabilities(); break;
      case "remote.status": result = this.status(); break;
      case "remote.start": result = this.start(); break;
      case "remote.stop": result = this.stop(); break;
      case "remote.pair.begin": result = await this.begin(params as unknown as RemotePairParams); break;
      case "remote.pair.refresh": result = await this.refresh(); break;
      case "remote.pair.cancel": result = this.cancelPair(); break;
      case "remote.devices": result = { devices: this.status().devices }; break;
      case "remote.pending": result = { pending: this.#pending?.pairing.deviceId ? [this.status().pairing] : [] }; break;
      case "remote.approve": result = await this.approve(typeof params.deviceId === "string" ? params.deviceId : ""); break;
      case "remote.revoke": result = this.revoke(typeof params.deviceId === "string" ? params.deviceId : ""); break;
    }
    return result as JsonObject;
  }
}
