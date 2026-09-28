import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { normalizeDaemonClientEnvOverrides } from "../app-server/client-env-snapshot.js";
import { resolveBuiltInProviderSlug } from "../llm/registry/provider-info.js";
import { telegramSessionFailure } from "./telegram-session-failure.js";
import QRCode from "qrcode";
import type { AgenCDaemonResponse, JsonObject } from "../app-server/protocol/index.js";
import { AGENC_DAEMON_PROTOCOL_VERSION } from "../app-server/protocol/index.js";
import { canonicalRemoteWorkspace, RemoteAccessBoundary, type RemoteSessionLookup } from "../remote/access.js";
import { RemoteApprovalProjection } from "../remote/approvals.js";
import { RemoteError } from "../remote/types.js";
import { FetchTelegramTransport, type TelegramTransport, type TelegramUpdate } from "./telegram-channel.js";
import { LEGACY_TELEGRAM_AGENT_ID, type OwnerTelegramStorage } from "./owner-telegram-storage.js";
import type { OwnerTelegramBinding, OwnerTelegramCapabilities, OwnerTelegramConfigureParams, OwnerTelegramMethod, OwnerTelegramStatus, TelegramAccountCandidate, TelegramAgentCreateParams, TelegramAgentPairing, TelegramAgentPairingResult, TelegramAgentRecord, TelegramAgentStatus, TelegramAgentUpdateParams } from "./owner-telegram-types.js";

export interface TelegramSessionOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly envOverrides?: Readonly<Record<string, string>>;
}
interface Connection { dispatch(message: JsonObject): Promise<AgenCDaemonResponse>; close(): Promise<void> }
export interface OwnerTelegramOptions {
  readonly home: string;
  readonly storage: OwnerTelegramStorage;
  readonly lookupSession: RemoteSessionLookup;
  readonly createSession: (workspacePath: string, title: string, signal: AbortSignal, selection?: TelegramSessionOptions) => Promise<{ sessionId: string; agentId: string }>;
  readonly createConnection: (access: RemoteAccessBoundary) => Connection;
  readonly assertControlSession?: (sessionId: string) => Promise<void>;
  readonly transport?: (token: string, signal: AbortSignal) => TelegramTransport;
  readonly instructions?: string;
  readonly displayName?: string;
  readonly managedAgentId?: string;
  readonly onSessionFailure?: (diagnostic: string) => void;
}

/** An isolated private-chat runtime; the manager below owns its identity and credentials. */
class OwnerTelegramRuntime {
  readonly #options: OwnerTelegramOptions;
  #binding: OwnerTelegramBinding | null;
  #enabled = false;
  #connected = false;
  #generation = 0;
  #controller = new AbortController();
  #transport?: TelegramTransport;
  #connection?: Connection;
  #timer?: ReturnType<typeof setTimeout>;
  #sessionId: string | null = null;
  #botUsername: string | null = null;
  #error: string | null = null;
  #sessionError: string | null = null;
  #lastUpdateAt: string | null = null;
  #creating = false;
  #creationFailure?: ReturnType<typeof telegramSessionFailure>;
  #turnActive = false;
  #handlers = 0;
  #startedAt = 0;
  #instructionsSent = false;
  readonly #notifiedApprovals = new Set<string>();

  constructor(options: OwnerTelegramOptions) { this.#options = options; this.#binding = options.storage.load(); }
  capabilities(): OwnerTelegramCapabilities { return { available: true, contractVersion: 2, multiAgent: true, providerSelection: true, accountLinking: "local-confirmation", ownerOnly: true, privateChatOnly: true, nativeCredentialStorage: true, approvals: "host-only", commands: ["new", "status", "cancel"] }; }
  status(): OwnerTelegramStatus { return { configured: this.#binding !== null, enabled: this.#enabled, state: (this.#sessionError ?? this.#error) ? "error" : !this.#binding ? "unconfigured" : !this.#enabled ? "stopped" : this.#connected ? "connected" : "connecting", ownerUserId: this.#binding?.ownerUserId ?? null, ownerChatId: this.#binding?.ownerChatId ?? null, workspacePath: this.#binding?.workspacePath ?? null, sessionId: this.#sessionId, botUsername: this.#botUsername, error: this.#sessionError ?? this.#error, lastUpdateAt: this.#lastUpdateAt }; }
  configure(params: OwnerTelegramConfigureParams): OwnerTelegramStatus {
    if (!params || typeof params.token !== "string" || params.token.length > 512 || !/^[0-9]+:[A-Za-z0-9_-]{16,}$/u.test(params.token) || typeof params.ownerUserId !== "string" || !/^[1-9]\d{0,15}$/u.test(params.ownerUserId) || !Number.isSafeInteger(Number(params.ownerUserId)) || (params.ownerChatId !== undefined && params.ownerChatId !== params.ownerUserId) || typeof params.workspacePath !== "string") throw new RemoteError("TELEGRAM_CONFIG_INVALID");
    const workspacePath = canonicalRemoteWorkspace(params.workspacePath, this.#options.home);
    this.stop();
    try {
      this.#options.storage.setToken(params.token);
      const binding = { ownerUserId: params.ownerUserId, ownerChatId: params.ownerUserId, workspacePath, lastUpdateId: -1, tokenFingerprint: createHash("sha256").update(params.token).digest("hex") };
      this.#options.storage.save(binding); this.#binding = binding; this.#sessionId = null; this.#botUsername = null;
      return this.status();
    } catch { this.#error = "TELEGRAM_CREDENTIAL_STORAGE_UNAVAILABLE"; throw new RemoteError(this.#error); }
  }
  #current(generation: number): boolean { return this.#enabled && generation === this.#generation && !this.#controller.signal.aborted; }
  async start(): Promise<OwnerTelegramStatus> {
    if (this.#enabled) return this.status();
    if (!this.#binding) throw new RemoteError("TELEGRAM_NOT_CONFIGURED");
    const binding = this.#binding;
    if (canonicalRemoteWorkspace(binding.workspacePath, this.#options.home) !== binding.workspacePath) throw new RemoteError("REMOTE_WORKSPACE_INVALID");
    let token: string | undefined;
    try { token = this.#options.storage.token(); } catch { throw new RemoteError("TELEGRAM_CREDENTIAL_STORAGE_UNAVAILABLE"); }
    if (!token) throw new RemoteError("TELEGRAM_TOKEN_MISSING");
    if (createHash("sha256").update(token).digest("hex") !== binding.tokenFingerprint) throw new RemoteError("TELEGRAM_CONFIGURATION_MISMATCH");
    this.#enabled = true; this.#connected = false; this.#generation++; this.#controller = new AbortController(); this.#error = null; this.#sessionId = null;
    this.#startedAt = Math.floor(Date.now() / 1000);
    const generation = this.#generation; const signal = this.#controller.signal;
    try {
      const transport = this.#options.transport?.(token, signal) ?? new FetchTelegramTransport({ token, fetchImpl: (url, init) => fetch(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }) });
      this.#transport = transport;
      const identity = await transport.getMe?.();
      if (!this.#current(generation)) return this.status();
      this.#botUsername = identity?.username ?? null;
      const access = new RemoteAccessBoundary({ workspaceId: randomUUID(), workspacePath: binding.workspacePath, sessionIds: [], role: "control", allowFiles: false, allowApprovals: false }, () => this.#current(generation), this.#options.lookupSession, this.#options.home, { approvals: new RemoteApprovalProjection(), assertControlSession: this.#options.assertControlSession, createSession: async (title) => {
        try { return await this.#options.createSession(binding.workspacePath, title, signal); }
        catch (error) {
          // The remote dispatcher deliberately replaces internal failures with
          // REMOTE_REQUEST_FAILED. Classify locally before that privacy boundary.
          if (this.#current(generation)) this.#creationFailure = telegramSessionFailure(error);
          throw error;
        }
      } });
      this.#connection = this.#options.createConnection(access);
      const initialized = await this.#rpc("initialize", { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION } });
      if (initialized.error) throw new RemoteError("TELEGRAM_CORE_UNAVAILABLE");
      if (!this.#current(generation)) return this.status();
      this.#connected = true; this.#schedule(generation, 0);
      return this.status();
    } catch (error) {
      if (!this.#current(generation)) return this.status();
      this.stop(); this.#error = error instanceof RemoteError ? error.code : "TELEGRAM_CONNECT_FAILED";
      return this.status();
    }
  }
  stop(): OwnerTelegramStatus {
    this.#enabled = false; this.#connected = false; this.#generation++; this.#controller.abort();
    if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined;
    void this.#connection?.close().catch(() => {}); this.#connection = undefined; this.#transport = undefined;
    this.#creating = false; this.#turnActive = false; this.#handlers = 0; this.#error = null; this.#sessionError = null; this.#creationFailure = undefined; this.#notifiedApprovals.clear();
    return this.status();
  }
  revoke(): OwnerTelegramStatus { this.stop(); try { this.#options.storage.revoke(); this.#binding = null; this.#sessionId = null; this.#botUsername = null; return this.status(); } catch { this.#error = "TELEGRAM_CREDENTIAL_STORAGE_UNAVAILABLE"; throw new RemoteError(this.#error); } }
  close(): void { this.stop(); }
  #schedule(generation: number, delay: number): void { if (!this.#current(generation)) return; this.#timer = setTimeout(() => { this.#timer = undefined; void this.#poll(generation); }, delay); this.#timer.unref?.(); }
  async #poll(generation: number): Promise<void> {
    if (!this.#current(generation) || !this.#binding) return;
    let delay = 100;
    try {
      const updates = await this.#transport!.getUpdates(this.#binding.lastUpdateId + 1, 20);
      if (!this.#current(generation)) return;
      this.#connected = true; if (this.#error === "TELEGRAM_POLL_FAILED") this.#error = null; this.#lastUpdateAt = new Date().toISOString();
      for (const update of updates.slice(0, 100)) {
        if (!this.#binding) return;
        if (!Number.isSafeInteger(update.update_id) || update.update_id <= this.#binding.lastUpdateId) continue;
        // Persist replay progress before a command can create work or send a prompt.
        const binding: OwnerTelegramBinding = { ...this.#binding, lastUpdateId: update.update_id };
        try { this.#options.storage.save(binding); }
        catch { this.stop(); this.#error = "TELEGRAM_STATE_STORAGE_FAILED"; return; }
        this.#binding = binding;
        if (!this.#allowed(update) || this.#handlers >= 4) continue;
        this.#handlers++;
        void this.#handleText(update.message!.text!, update.update_id, generation).then(() => { if (this.#current(generation) && this.#error === "TELEGRAM_COMMAND_FAILED") this.#error = null; }).catch(() => { if (this.#current(generation)) this.#error = "TELEGRAM_COMMAND_FAILED"; }).finally(() => { if (this.#current(generation)) this.#handlers--; });
      }
    } catch { if (this.#current(generation)) { this.#connected = false; this.#error = "TELEGRAM_POLL_FAILED"; delay = 5_000; } }
    this.#schedule(generation, delay);
  }
  #allowed(update: TelegramUpdate): boolean {
    const message = update.message;
    return !!message && typeof message.date === "number" && message.date >= this.#startedAt && message.chat.type === "private" && String(message.chat.id) === this.#binding?.ownerChatId && String(message.from?.id) === this.#binding?.ownerUserId && message.from?.is_bot !== true && !message.sender_chat && !("forward_origin" in message) && !("forward_from" in message) && typeof message.text === "string" && message.text.length > 0 && message.text.length <= 16_000;
  }
  async #rpc(method: string, params: JsonObject = {}): Promise<{ result?: JsonObject; error?: unknown }> {
    if (!this.#connection) throw new RemoteError("TELEGRAM_CORE_UNAVAILABLE");
    return await this.#connection.dispatch({ jsonrpc: "2.0", id: randomUUID(), method, params });
  }
  async #reply(text: string, generation: number): Promise<void> {
    if (!this.#current(generation) || !this.#binding || !this.#transport) return;
    // Plain text avoids interpreting agent output as bot HTML or commands.
    for (let offset = 0; offset < Math.min(text.length, 21_600); offset += 3600) {
      if (!this.#current(generation)) return;
      await this.#transport.sendMessage(this.#binding.ownerChatId, text.slice(offset, offset + 3600));
    }
  }
  async #newSession(generation: number): Promise<boolean> {
    if (this.#creating || this.#turnActive) { await this.#reply("A session is busy. Use /cancel before starting another.", generation); return false; }
    this.#creating = true; this.#creationFailure = undefined;
    try {
      canonicalRemoteWorkspace(this.#binding!.workspacePath, this.#options.home);
      const created = await this.#rpc("session.create", { title: this.#options.displayName ? `Telegram · ${this.#options.displayName}` : "Telegram owner session" });
      if (!this.#current(generation)) return false;
      if (created.error) throw created.error;
      if (typeof created.result?.sessionId !== "string") throw new Error("TELEGRAM_SESSION_RESPONSE_INVALID");
      this.#error = null; this.#sessionError = null; this.#sessionId = created.result.sessionId; this.#instructionsSent = false; return true;
    } catch (error) {
      if (!this.#current(generation)) return false;
      const failure = this.#creationFailure ?? telegramSessionFailure(error);
      this.#options.onSessionFailure?.(failure.diagnostic);
      this.#sessionError = failure.code;
      await this.#reply(failure.reply, generation);
      return false;
    } finally { if (this.#current(generation)) this.#creating = false; }
  }
  async #handleText(text: string, updateId: number, generation: number): Promise<void> {
    const command = text.trim().split(/\s/u, 1)[0]!.toLowerCase().split("@", 1)[0];
    if (command === "/status") { await this.#reply(this.#sessionId ? `Session ${this.#sessionId}: ${this.#turnActive ? "working" : "ready"}. Approvals are handled on the host.` : "Connected. Send a message or /new to begin in the configured workspace.", generation); return; }
    if (command === "/cancel") { if (this.#sessionId) await this.#rpc("session.cancelTurn", { sessionId: this.#sessionId, reason: "Telegram owner requested cancellation" }); await this.#reply("Cancellation requested.", generation); return; }
    if (command === "/new") { if (await this.#newSession(generation)) await this.#reply("New workspace session ready. Send your message.", generation); return; }
    if (text.trim().startsWith("/")) { await this.#reply("Use /new, /status, /cancel, or send a message. Approve tool requests in AgenC on the host.", generation); return; }
    if (!this.#sessionId && !(await this.#newSession(generation))) return;
    if (!this.#current(generation) || !this.#sessionId) return;
    if (this.#turnActive) { await this.#reply("The session is working. Use /status or /cancel.", generation); return; }
    this.#turnActive = true; const sessionId = this.#sessionId;
    try {
      const content = !this.#instructionsSent && this.#options.instructions ? `Agent instructions:\n${this.#options.instructions}\n\nMessage from the linked Telegram account:\n${text}` : text;
      const result = await this.#rpc("message.send", { sessionId, content, clientMessageId: `telegram:${this.#options.managedAgentId ? `${this.#options.managedAgentId}:` : ""}${this.#binding!.ownerUserId}:${updateId}`, ifBusy: "reject" });
      if (!this.#current(generation)) return;
      if (result.error) { await this.#reply("The request could not finish. Check the session on the host.", generation); return; }
      this.#instructionsSent = true;
      const terminal = result.result?.terminal as JsonObject | undefined;
      if (terminal?.code === 130) { await this.#reply("Task cancelled.", generation); return; }
      if (terminal?.code === 1) { await this.#reply("The task did not complete. Check the session on the host.", generation); return; }
      const transcript = await this.#rpc("session.transcript.v2", { sessionId });
      const messages = transcript.result?.messages;
      // Modern managed sessions never mistake an older answer for this request's result.
      const turnId = typeof result.result?.turnId === "string" ? result.result.turnId : null;
      const answer = Array.isArray(messages) ? [...messages].reverse().find((message) => message && typeof message === "object" && !Array.isArray(message) && message.role === "assistant" && (turnId ? message.turnId === turnId : !this.#options.managedAgentId)) as JsonObject | undefined : undefined;
      await this.#reply(typeof answer?.text === "string" ? answer.text : "Turn completed. Check AgenC on the host for details.", generation);
    } finally { if (this.#current(generation)) this.#turnActive = false; }
  }
  observeSessionEvent(sessionId: string, event: JsonObject): void {
    if (!this.#enabled || sessionId !== this.#sessionId || event.method !== "event.permission_request") return;
    const params = event.params as JsonObject | undefined;
    if (typeof params?.requestId !== "string" || this.#notifiedApprovals.has(params.requestId) || this.#notifiedApprovals.size >= 100) return;
    this.#notifiedApprovals.add(params.requestId);
    void this.#reply("This session needs permission to continue. Review and approve the tool request in AgenC on the host.", this.#generation).catch(() => {});
  }
  async handle(method: OwnerTelegramMethod, params: JsonObject): Promise<JsonObject> {
    try {
      const result = method === "telegram.capabilities" ? this.capabilities() : method === "telegram.configure" ? this.configure(params as unknown as OwnerTelegramConfigureParams) : method === "telegram.start" ? await this.start() : method === "telegram.stop" ? this.stop() : method === "telegram.revoke" ? this.revoke() : this.status();
      return result as unknown as JsonObject;
    } catch (error) { throw error instanceof RemoteError ? error : new RemoteError("TELEGRAM_OPERATION_FAILED"); }
  }
}

interface AgentEntry {
  record: TelegramAgentRecord;
  runtime: OwnerTelegramRuntime;
  pairing: PairingState | null;
  error: string | null;
  generation: number;
  operation: AbortController | null;
  envOverrides?: Readonly<Record<string, string>>;
}
interface PairingState {
  readonly challengeId: string;
  readonly url: string;
  readonly qrDataUrl: string;
  readonly expiresAt: string;
  readonly expiresAtMs: number;
  readonly startedAt: number;
  readonly controller: AbortController;
  readonly transport: TelegramTransport;
  nonceHash: Buffer | null;
  candidate: TelegramAccountCandidate | null;
  timer?: ReturnType<typeof setTimeout>;
  expiryTimer?: ReturnType<typeof setTimeout>;
}
const fingerprint = (token: string): string => createHash("sha256").update(token).digest("hex");
const validToken = (token: unknown): token is string => typeof token === "string" && token.length <= 512 && /^[0-9]+:[A-Za-z0-9_-]{16,}$/u.test(token);
const validIdentity = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
const cleanUsername = (value: unknown): string | null => typeof value === "string" && /^[a-zA-Z0-9_]{1,64}$/u.test(value) ? value : null;

/** Authenticated local management of independent, private Telegram agents. */
export class OwnerTelegramService {
  readonly #options: OwnerTelegramOptions;
  #legacy: OwnerTelegramRuntime;
  readonly #entries = new Map<string, AgentEntry>();
  readonly #operations = new AbortController();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: OwnerTelegramOptions) {
    this.#options = options;
    this.#legacy = new OwnerTelegramRuntime(options);
    for (const record of options.storage.agents?.load() ?? []) this.#addEntry(record);
  }
  #store() {
    if (!this.#options.storage.agents) throw new RemoteError("TELEGRAM_MULTI_AGENT_UNAVAILABLE");
    return this.#options.storage.agents;
  }
  #addEntry(record: TelegramAgentRecord): AgentEntry {
    const entry = { record, pairing: null, error: null, generation: 0, operation: null } as unknown as AgentEntry;
    const storage: OwnerTelegramStorage = {
      load: () => entry.record.ownerUserId ? { ownerUserId: entry.record.ownerUserId, ownerChatId: entry.record.ownerUserId, workspacePath: entry.record.workspacePath, lastUpdateId: entry.record.lastUpdateId, tokenFingerprint: entry.record.tokenFingerprint } : null,
      save: (binding) => { const next = { ...entry.record, lastUpdateId: binding.lastUpdateId }; this.#store().save(next); entry.record = next; },
      token: () => this.#store().token(record.agentId),
      setToken: (token) => this.#store().setToken(record.agentId, token),
      revoke: () => this.#store().remove(record.agentId),
    };
    entry.runtime = new OwnerTelegramRuntime({ ...this.#options,
      createSession: (workspace, title, signal) => this.#options.createSession(workspace, title, signal, {
        provider: entry.record.provider, model: entry.record.model, envOverrides: entry.envOverrides,
      }), storage, displayName: record.name, instructions: record.instructions, managedAgentId: record.agentId });
    this.#entries.set(record.agentId, entry);
    return entry;
  }
  #entry(agentId: unknown): AgentEntry {
    if (typeof agentId !== "string" || !this.#entries.has(agentId)) throw new RemoteError("TELEGRAM_AGENT_NOT_FOUND");
    return this.#entries.get(agentId)!;
  }
  #primary(): OwnerTelegramRuntime { return (this.#entries.get(LEGACY_TELEGRAM_AGENT_ID) ?? this.#entries.values().next().value)?.runtime ?? this.#legacy; }
  capabilities(): OwnerTelegramCapabilities { return this.#legacy.capabilities(); }
  status(): OwnerTelegramStatus { return this.#primary().status(); }
  configure(params: OwnerTelegramConfigureParams): OwnerTelegramStatus {
    if (this.#options.storage.agents && validToken(params?.token)) {
      const id = params.token.split(":", 1)[0];
      for (const candidate of this.#entries.values()) {
        if (candidate.record.agentId === LEGACY_TELEGRAM_AGENT_ID) continue;
        if (candidate.record.telegramIdentityId === id || candidate.record.tokenFingerprint === fingerprint(params.token)) throw new RemoteError("TELEGRAM_AGENT_DUPLICATE");
      }
    }
    const legacyEntry = this.#entries.get(LEGACY_TELEGRAM_AGENT_ID);
    if (legacyEntry) this.#stopEntry(legacyEntry);
    const status = this.#legacy.configure(params);
    const record = this.#options.storage.agents?.load().find((entry) => entry.agentId === LEGACY_TELEGRAM_AGENT_ID);
    if (record) this.#addEntry(record);
    return status;
  }
  async start(): Promise<OwnerTelegramStatus> {
    const entry = this.#entries.get(LEGACY_TELEGRAM_AGENT_ID) ?? this.#entries.values().next().value;
    if (entry) { await this.#startAgent(entry); return this.#primary().status(); }
    return this.#legacy.start();
  }
  stop(): OwnerTelegramStatus {
    this.#legacy.stop();
    for (const entry of this.#entries.values()) this.#stopEntry(entry);
    return this.status();
  }
  revoke(): OwnerTelegramStatus {
    const entry = this.#entries.get(LEGACY_TELEGRAM_AGENT_ID) ?? this.#entries.values().next().value;
    if (!entry) return this.#legacy.revoke();
    this.#stopEntry(entry); this.#store().remove(entry.record.agentId); this.#entries.delete(entry.record.agentId);
    if (entry.record.agentId === LEGACY_TELEGRAM_AGENT_ID) this.#legacy = new OwnerTelegramRuntime(this.#options);
    return this.status();
  }
  close(): void { this.#operations.abort(); this.stop(); }
  observeSessionEvent(sessionId: string, event: JsonObject): void {
    this.#legacy.observeSessionEvent(sessionId, event);
    for (const entry of this.#entries.values()) entry.runtime.observeSessionEvent(sessionId, event);
  }
  #status(entry: AgentEntry): TelegramAgentStatus {
    this.#expirePairing(entry);
    const { record, pairing } = entry;
    const runtime = entry.runtime.status();
    const state = entry.error || runtime.error ? "error" : pairing ? pairing.candidate ? "awaiting_confirmation" : "linking" : !record.ownerUserId ? "unlinked" : runtime.state === "connected" ? "running" : runtime.state === "connecting" ? "connecting" : "stopped";
    return { provider: record.provider, model: record.model, agentId: record.agentId, name: record.name, instructions: record.instructions, workspacePath: record.workspacePath, username: runtime.botUsername ?? record.username, ownerUserId: record.ownerUserId, ownerUsername: record.ownerUsername, enabled: runtime.enabled, state, sessionId: runtime.sessionId, error: entry.error ?? runtime.error, lastUpdateAt: runtime.lastUpdateAt, pairing: pairing ? this.#pairingProjection(pairing) : null };
  }
  list(): { agents: TelegramAgentStatus[] } { return { agents: [...this.#entries.values()].map((entry) => this.#status(entry)) }; }
  #pairingProjection(pairing: PairingState): TelegramAgentPairing { return { challengeId: pairing.challengeId, url: pairing.url, qrDataUrl: pairing.qrDataUrl, expiresAt: pairing.expiresAt, candidate: pairing.candidate }; }
  #validateProfile(params: { name: unknown; workspacePath: unknown; instructions?: unknown; provider?: unknown; model?: unknown }): { name: string; workspacePath: string; instructions: string; provider?: string; model?: string } {
    if (typeof params.name !== "string" || !params.name.trim() || params.name.length > 100 || /[\x00-\x1f\x7f]/u.test(params.name) || typeof params.workspacePath !== "string" || (params.instructions !== undefined && (typeof params.instructions !== "string" || params.instructions.length > 16_000))) throw new RemoteError("TELEGRAM_CONFIG_INVALID");
    if ((params.provider === undefined) !== (params.model === undefined) || (params.provider !== undefined && (typeof params.provider !== "string" || !resolveBuiltInProviderSlug(params.provider) || typeof params.model !== "string" || !params.model.trim() || params.model.length > 256 || /[\x00-\x1f\x7f]/u.test(params.model)))) throw new RemoteError("TELEGRAM_CONFIG_INVALID");
    return { provider: params.provider as string | undefined, model: params.model as string | undefined, name: params.name.trim(), workspacePath: canonicalRemoteWorkspace(params.workspacePath, this.#options.home), instructions: typeof params.instructions === "string" ? params.instructions : "" };
  }
  #transport(token: string, signal: AbortSignal): TelegramTransport {
    return this.#options.transport?.(token, signal) ?? new FetchTelegramTransport({ token, fetchImpl: (url, init) => fetch(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }) });
  }
  async #identity(token: unknown, exceptAgentId?: string, operationSignal?: AbortSignal): Promise<{ id: string; username: string }> {
    if (!validToken(token)) throw new RemoteError("TELEGRAM_CONFIG_INVALID");
    let identity;
    const controller = new AbortController();
    try { identity = await this.#transport(token, AbortSignal.any([controller.signal, this.#operations.signal, AbortSignal.timeout(30_000), ...(operationSignal ? [operationSignal] : [])])).getMe?.(); }
    catch { throw new RemoteError(operationSignal?.aborted || this.#operations.signal.aborted ? "TELEGRAM_OPERATION_CANCELLED" : "TELEGRAM_TOKEN_INVALID"); }
    finally { controller.abort(); }
    this.#operations.signal.throwIfAborted();
    if (operationSignal?.aborted) throw new RemoteError("TELEGRAM_OPERATION_CANCELLED");
    const username = cleanUsername(identity?.username);
    if (!validIdentity(identity?.id) || !username) throw new RemoteError("TELEGRAM_TOKEN_INVALID");
    const id = String(identity.id);
    for (const entry of this.#entries.values()) {
      if (entry.record.agentId === exceptAgentId) continue;
      // The numeric token prefix also catches a migrated identity before its first getMe.
      const migratedId = entry.record.telegramIdentityId === null ? this.#store().token(entry.record.agentId)?.split(":", 1)[0] : null;
      if (entry.record.telegramIdentityId === id || migratedId === id || entry.record.tokenFingerprint === fingerprint(token)) throw new RemoteError("TELEGRAM_AGENT_DUPLICATE");
    }
    return { id, username };
  }
  #token(entry: AgentEntry): string {
    let token;
    try { token = this.#store().token(entry.record.agentId); }
    catch { throw new RemoteError("TELEGRAM_CREDENTIAL_STORAGE_UNAVAILABLE"); }
    if (!token) throw new RemoteError("TELEGRAM_TOKEN_MISSING");
    if (fingerprint(token) !== entry.record.tokenFingerprint) throw new RemoteError("TELEGRAM_CONFIGURATION_MISMATCH");
    return token;
  }
  async #create(params: TelegramAgentCreateParams): Promise<TelegramAgentStatus> {
    const profile = this.#validateProfile(params);
    if (this.#entries.size >= 100) throw new RemoteError("TELEGRAM_AGENT_LIMIT");
    const identity = await this.#identity(params.token);
    const record: TelegramAgentRecord = { agentId: randomUUID(), ...profile, telegramIdentityId: identity.id, username: identity.username, ownerUserId: null, ownerUsername: null, lastUpdateId: -1, tokenFingerprint: fingerprint(params.token) };
    // Persist a discoverable, disabled identity first. If native storage then fails,
    // the user can update/remove this entry; metadata failure never creates an orphan key.
    try { this.#store().save(record); }
    catch { throw new RemoteError("TELEGRAM_STATE_STORAGE_FAILED"); }
    const entry = this.#addEntry(record);
    try { this.#store().setToken(record.agentId, params.token); }
    catch { entry.error = "TELEGRAM_CREDENTIAL_STORAGE_UNAVAILABLE"; throw new RemoteError(entry.error); }
    return this.#status(entry);
  }
  async #update(params: TelegramAgentUpdateParams): Promise<TelegramAgentStatus> {
    const entry = this.#entry(params.agentId);
    const signal = this.#beginOperation(entry);
    const profile = this.#validateProfile({ name: params.name ?? entry.record.name, workspacePath: params.workspacePath ?? entry.record.workspacePath, instructions: params.instructions ?? entry.record.instructions, provider: params.provider ?? entry.record.provider, model: params.model ?? entry.record.model });
    const identity = params.token !== undefined ? await this.#identity(params.token, params.agentId, signal) : null;
    signal.throwIfAborted();
    this.#cancelPairing(entry); entry.runtime.stop();
    const changedIdentity = identity !== null && identity.id !== entry.record.telegramIdentityId;
    const record: TelegramAgentRecord = { ...entry.record, ...profile, ...(identity ? { telegramIdentityId: identity.id, username: identity.username, tokenFingerprint: fingerprint(params.token!) } : {}), ...(changedIdentity ? { ownerUserId: null, ownerUsername: null, lastUpdateId: -1 } : {}) };
    try { if (params.token !== undefined) this.#store().setToken(record.agentId, params.token); this.#store().save(record); }
    catch { entry.error = "TELEGRAM_CREDENTIAL_STORAGE_UNAVAILABLE"; throw new RemoteError(entry.error); }
    return this.#status(this.#addEntry(record));
  }
  #cancelPairing(entry: AgentEntry): void {
    const pairing = entry.pairing; entry.pairing = null;
    if (!pairing) return;
    pairing.nonceHash = null; pairing.controller.abort();
    if (pairing.timer) clearTimeout(pairing.timer);
    if (pairing.expiryTimer) clearTimeout(pairing.expiryTimer);
  }
  #beginOperation(entry: AgentEntry): AbortSignal {
    entry.operation?.abort(); entry.operation = new AbortController();
    return entry.operation.signal;
  }
  #stopEntry(entry: AgentEntry): TelegramAgentStatus {
    entry.generation++; entry.operation?.abort(); entry.operation = null;
    this.#cancelPairing(entry); entry.runtime.stop(); entry.envOverrides = undefined; entry.error = null;
    return this.#status(entry);
  }
  #expirePairing(entry: AgentEntry): void { if (entry.pairing && entry.pairing.expiresAtMs <= Date.now()) this.#cancelPairing(entry); }
  async #beginPairing(entry: AgentEntry): Promise<TelegramAgentPairingResult> {
    const signal = this.#beginOperation(entry);
    this.#cancelPairing(entry); entry.runtime.stop(); entry.envOverrides = undefined; entry.error = null;
    const token = this.#token(entry);
    const identity = await this.#identity(token, entry.record.agentId, signal);
    const record = { ...entry.record, telegramIdentityId: identity.id, username: identity.username };
    this.#store().save(record); entry.record = record;
    const nonce = randomBytes(32).toString("base64url");
    const url = `https://t.me/${identity.username}?start=${nonce}`;
    const qrDataUrl = await QRCode.toDataURL(url, { width: 256, margin: 2 });
    this.#operations.signal.throwIfAborted();
    signal.throwIfAborted();
    const controller = new AbortController();
    const expiresAtMs = Date.now() + 5 * 60_000;
    const pairing: PairingState = { challengeId: randomUUID(), url, qrDataUrl, expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs, startedAt: Math.floor(Date.now() / 1000), controller, transport: this.#transport(token, AbortSignal.any([controller.signal, this.#operations.signal])), nonceHash: createHash("sha256").update(nonce).digest(), candidate: null };
    entry.pairing = pairing;
    pairing.expiryTimer = setTimeout(() => { if (entry.pairing === pairing) this.#cancelPairing(entry); }, 5 * 60_000);
    pairing.expiryTimer.unref?.();
    this.#schedulePairing(entry, pairing, 0);
    return { agentId: entry.record.agentId, challengeId: pairing.challengeId, url, qrDataUrl, expiresAt: pairing.expiresAt };
  }
  #schedulePairing(entry: AgentEntry, pairing: PairingState, delay: number): void {
    if (entry.pairing !== pairing || pairing.controller.signal.aborted || pairing.candidate) return;
    pairing.timer = setTimeout(() => { pairing.timer = undefined; void this.#pollPairing(entry, pairing); }, delay);
    pairing.timer.unref?.();
  }
  async #pollPairing(entry: AgentEntry, pairing: PairingState): Promise<void> {
    this.#expirePairing(entry);
    if (entry.pairing !== pairing || pairing.controller.signal.aborted) return;
    let delay = 100;
    try {
      const updates = await pairing.transport.getUpdates(entry.record.lastUpdateId + 1, 20);
      this.#expirePairing(entry);
      if (entry.pairing !== pairing || pairing.controller.signal.aborted) return;
      entry.error = null;
      for (const update of updates.slice(0, 100)) {
        if (!Number.isSafeInteger(update.update_id) || update.update_id <= entry.record.lastUpdateId) continue;
        const record = { ...entry.record, lastUpdateId: update.update_id };
        try { this.#store().save(record); entry.record = record; }
        catch { this.#cancelPairing(entry); entry.error = "TELEGRAM_STATE_STORAGE_FAILED"; return; }
        const message = update.message;
        if (!message || typeof message.date !== "number" || message.date < pairing.startedAt || message.chat.type !== "private" || !validIdentity(message.from?.id) || message.chat.id !== message.from.id || message.from.is_bot === true || message.sender_chat || "forward_origin" in message || "forward_from" in message || typeof message.text !== "string" || message.text.length > 200 || !pairing.nonceHash) continue;
        const match = /^\/start(?:@[a-zA-Z0-9_]+)? ([a-zA-Z0-9_-]{43})$/u.exec(message.text.trim());
        if (!match || !timingSafeEqual(createHash("sha256").update(match[1]!).digest(), pairing.nonceHash)) continue;
        pairing.nonceHash = null;
        pairing.candidate = { userId: String(message.from.id), username: cleanUsername(message.from.username), displayName: typeof message.from.first_name === "string" ? message.from.first_name.replace(/[\x00-\x1f\x7f]/gu, "").slice(0, 80) : "Telegram account" };
        // Stop polling immediately; only a trusted local confirmation can bind this candidate.
        pairing.controller.abort();
        return;
      }
    } catch { if (entry.pairing === pairing && !pairing.controller.signal.aborted) { entry.error = "TELEGRAM_POLL_FAILED"; delay = 5_000; } }
    this.#schedulePairing(entry, pairing, delay);
  }
  #confirmPairing(entry: AgentEntry, challengeId: unknown): TelegramAgentStatus {
    this.#expirePairing(entry);
    const pairing = entry.pairing;
    if (!pairing || typeof challengeId !== "string" || pairing.challengeId !== challengeId || !pairing.candidate) throw new RemoteError("TELEGRAM_PAIRING_NOT_PENDING");
    const record = { ...entry.record, ownerUserId: pairing.candidate.userId, ownerUsername: pairing.candidate.username };
    try { this.#store().save(record); }
    catch { throw new RemoteError("TELEGRAM_STATE_STORAGE_FAILED"); }
    this.#cancelPairing(entry);
    return this.#status(this.#addEntry(record));
  }
  async #startAgent(entry: AgentEntry, envOverrides?: unknown, provider?: unknown): Promise<TelegramAgentStatus> {
    let snapshot: Record<string, string> | undefined;
    if (envOverrides !== undefined) {
      if (typeof provider !== "string" || provider !== entry.record.provider) throw new RemoteError("TELEGRAM_PROVIDER_CHANGED");
      if (!envOverrides || typeof envOverrides !== "object" || Array.isArray(envOverrides) || Object.keys(envOverrides).length > 256 || Object.values(envOverrides).some(value => typeof value !== "string" || value.length > 32_768)) throw new RemoteError("TELEGRAM_CONFIG_INVALID");
      try { snapshot = normalizeDaemonClientEnvOverrides(envOverrides as Record<string, string>); }
      catch { throw new RemoteError("TELEGRAM_CONFIG_INVALID"); }
    }
    if (!entry.record.ownerUserId) throw new RemoteError("TELEGRAM_ACCOUNT_NOT_LINKED");
    this.#cancelPairing(entry);
    const signal = this.#beginOperation(entry);
    const identity = await this.#identity(this.#token(entry), entry.record.agentId, signal);
    if (entry.record.telegramIdentityId !== null && identity.id !== entry.record.telegramIdentityId) throw new RemoteError("TELEGRAM_CONFIGURATION_MISMATCH");
    const record = { ...entry.record, telegramIdentityId: identity.id, username: identity.username };
    this.#store().save(record); entry.record = record; entry.error = null;
    // Rehydrate replay progress changed by account-link polling before a new activation.
    if (!entry.runtime.status().enabled) {
      const replacement = this.#addEntry(record);
      replacement.envOverrides = snapshot;
      replacement.operation = entry.operation;
      replacement.generation = entry.generation;
      await replacement.runtime.start();
      return this.#status(replacement);
    }
    if (snapshot !== undefined) entry.envOverrides = snapshot;
    return this.#status(entry);
  }
  async #handle(method: OwnerTelegramMethod, params: JsonObject): Promise<unknown> {
    switch (method) {
      case "telegram.agents.create": return this.#create(params as unknown as TelegramAgentCreateParams);
      case "telegram.agents.update": return this.#update(params as unknown as TelegramAgentUpdateParams);
      case "telegram.agents.start": return this.#startAgent(this.#entry(params.agentId), params.envOverrides, params.provider);
      case "telegram.agents.stop": return this.#stopEntry(this.#entry(params.agentId));
      case "telegram.agents.remove": {
        const entry = this.#entry(params.agentId); this.#stopEntry(entry); this.#store().remove(entry.record.agentId); this.#entries.delete(entry.record.agentId);
        if (entry.record.agentId === LEGACY_TELEGRAM_AGENT_ID) this.#legacy = new OwnerTelegramRuntime(this.#options);
        return { removed: true, agentId: entry.record.agentId };
      }
      case "telegram.agents.pair.begin": return this.#beginPairing(this.#entry(params.agentId));
      case "telegram.agents.pair.confirm": return this.#confirmPairing(this.#entry(params.agentId), params.challengeId);
      case "telegram.agents.pair.cancel": { const entry = this.#entry(params.agentId); if (params.challengeId !== undefined && entry.pairing?.challengeId !== params.challengeId) throw new RemoteError("TELEGRAM_PAIRING_NOT_PENDING"); return this.#stopEntry(entry); }
      case "telegram.configure": {
        const existing = this.#entries.get(LEGACY_TELEGRAM_AGENT_ID);
        const signal = existing ? this.#beginOperation(existing) : undefined;
        const identity = this.#options.storage.agents ? await this.#identity(params.token, LEGACY_TELEGRAM_AGENT_ID, signal) : null;
        if (existing && (signal?.aborted || this.#entries.get(LEGACY_TELEGRAM_AGENT_ID) !== existing)) throw new RemoteError("TELEGRAM_OPERATION_CANCELLED");
        const status = this.configure(params as unknown as OwnerTelegramConfigureParams);
        const entry = this.#entries.get(LEGACY_TELEGRAM_AGENT_ID);
        if (entry && identity) {
          const record = { ...entry.record, telegramIdentityId: identity.id, username: identity.username };
          this.#store().save(record); this.#addEntry(record);
        }
        return status;
      }
      case "telegram.start": return this.start();
      case "telegram.stop": return this.stop();
      case "telegram.revoke": return this.revoke();
      case "telegram.capabilities": return this.capabilities();
      case "telegram.agents.list": return this.list();
      case "telegram.status": return this.status();
    }
  }
  async handle(method: OwnerTelegramMethod, params: JsonObject): Promise<JsonObject> {
    if (["telegram.capabilities", "telegram.status", "telegram.agents.list", "telegram.agents.stop", "telegram.agents.remove", "telegram.agents.pair.cancel", "telegram.stop"].includes(method)) {
      try { return await this.#handle(method, params) as JsonObject; }
      catch (error) { throw error instanceof RemoteError ? error : new RemoteError("TELEGRAM_OPERATION_FAILED"); }
    }
    const target = typeof params.agentId === "string" ? this.#entries.get(params.agentId) : method === "telegram.configure" ? this.#entries.get(LEGACY_TELEGRAM_AGENT_ID) : undefined;
    const generation = target?.generation;
    const operation = this.#queue.then(async () => {
      try {
        this.#operations.signal.throwIfAborted();
        if (target && (target.generation !== generation || this.#entries.get(target.record.agentId) !== target)) throw new RemoteError("TELEGRAM_OPERATION_CANCELLED");
        return await this.#handle(method, params) as JsonObject;
      }
      catch (error) { throw error instanceof RemoteError ? error : new RemoteError("TELEGRAM_OPERATION_FAILED"); }
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
}
