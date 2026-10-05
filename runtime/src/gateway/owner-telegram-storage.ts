import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HomeContext } from "../config/home.js";
import { readNativeSecureStorage, updateNativeSecureStorage } from "../utils/secureStorage/native.js";
import type { OwnerTelegramBinding, TelegramAgentRecord } from "./owner-telegram-types.js";

export interface TelegramAgentStorage {
  load(): TelegramAgentRecord[];
  save(record: TelegramAgentRecord): void;
  token(agentId: string): string | undefined;
  setToken(agentId: string, token: string): void;
  remove(agentId: string): void;
}

export interface OwnerTelegramStorage {
  load(): OwnerTelegramBinding | null;
  save(binding: OwnerTelegramBinding): void;
  token(): string | undefined;
  setToken(token: string): void;
  revoke(): void;
  readonly agents?: TelegramAgentStorage;
}
export const LEGACY_TELEGRAM_AGENT_ID = "legacy";
const identity = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,15}$/u.test(value) && Number.isSafeInteger(Number(value));
function validRecord(value: TelegramAgentRecord): boolean {
  return !!value && typeof value.agentId === "string" && /^[a-zA-Z0-9-]{1,64}$/u.test(value.agentId)
    && typeof value.name === "string" && value.name.length <= 100 && typeof value.instructions === "string" && value.instructions.length <= 16_000
    && (value.provider === undefined || typeof value.provider === "string" && /^[a-z0-9-]{1,64}$/u.test(value.provider))
    && (value.model === undefined || typeof value.model === "string" && value.model.length > 0 && value.model.length <= 256 && !/[\x00-\x1f\x7f]/u.test(value.model))
    && typeof value.workspacePath === "string" && (value.ownerUserId === null || identity(value.ownerUserId))
    && (value.telegramIdentityId === null || identity(value.telegramIdentityId))
    && (value.username === null || typeof value.username === "string" && /^[a-zA-Z0-9_]{1,64}$/u.test(value.username))
    && (value.ownerUsername === null || typeof value.ownerUsername === "string" && /^[a-zA-Z0-9_]{1,64}$/u.test(value.ownerUsername))
    && Number.isSafeInteger(value.lastUpdateId) && value.lastUpdateId >= -1 && /^[a-f0-9]{64}$/u.test(value.tokenFingerprint);
}
/** Metadata is atomic and non-secret; every credential is separately keyed in native storage. */
export function createOwnerTelegramStorage(home: HomeContext): OwnerTelegramStorage {
  const directory = join(home.path, "gateway");
  const file = join(directory, "telegram-agents.json");
  const legacyFile = join(directory, "owner-telegram.json");
  function load(): TelegramAgentRecord[] {
    let source: string;
    try { source = readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Read-only migration: the old token is not copied or removed until a local mutation.
      try {
        const old = JSON.parse(readFileSync(legacyFile, "utf8")) as OwnerTelegramBinding;
        if (!identity(old.ownerUserId) || old.ownerChatId !== old.ownerUserId) return [];
        const record: TelegramAgentRecord = { agentId: LEGACY_TELEGRAM_AGENT_ID, name: "Telegram agent", instructions: "", workspacePath: old.workspacePath, telegramIdentityId: null, username: null, ownerUserId: old.ownerUserId, ownerUsername: null, lastUpdateId: old.lastUpdateId, tokenFingerprint: old.tokenFingerprint };
        return validRecord(record) ? [record] : [];
      } catch { return []; }
    }
    const parsed = JSON.parse(source) as { version: number; agents: TelegramAgentRecord[] };
    if (parsed.version !== 2 || !Array.isArray(parsed.agents) || parsed.agents.length > 100 || !parsed.agents.every(validRecord) || new Set(parsed.agents.map((record) => record.agentId)).size !== parsed.agents.length) throw new Error("TELEGRAM_STATE_STORAGE_INVALID");
    return parsed.agents;
  }
  function persist(agents: TelegramAgentRecord[]): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `telegram-agents-${randomUUID()}.tmp`);
    try { writeFileSync(temporary, JSON.stringify({ version: 2, agents }), { flag: "wx", mode: 0o600 }); renameSync(temporary, file); }
    finally { rmSync(temporary, { force: true }); }
  }
  const agents: TelegramAgentStorage = {
    load,
    save(record) {
      if (!validRecord(record)) throw new Error("TELEGRAM_STATE_STORAGE_INVALID");
      const records = load(); const index = records.findIndex((entry) => entry.agentId === record.agentId);
      if (index < 0) records.push(record); else records[index] = record;
      if (records.length > 100) throw new Error("TELEGRAM_AGENT_LIMIT");
      persist(records);
    },
    token(agentId) {
      const gateway = readNativeSecureStorage(home).gateway;
      return gateway?.ownerControlAgentTokens?.[agentId] ?? (agentId === LEGACY_TELEGRAM_AGENT_ID ? gateway?.ownerControlBotToken : undefined);
    },
    setToken(agentId, token) {
      updateNativeSecureStorage(home, (current) => ({ ...current, gateway: { ...current.gateway, ownerControlAgentTokens: { ...current.gateway?.ownerControlAgentTokens, [agentId]: token } } }), "Native secure storage is required for Telegram agents");
    },
    remove(agentId) {
      // Remove authority before removing metadata. A later storage failure leaves a disabled entry.
      updateNativeSecureStorage(home, (current) => {
        const tokens = { ...current.gateway?.ownerControlAgentTokens }; delete tokens[agentId];
        const gateway = { ...current.gateway, ownerControlAgentTokens: tokens };
        if (agentId === LEGACY_TELEGRAM_AGENT_ID) delete gateway.ownerControlBotToken;
        return { ...current, gateway };
      }, "Native secure storage is required to remove a Telegram agent");
      persist(load().filter((entry) => entry.agentId !== agentId));
      if (agentId === LEGACY_TELEGRAM_AGENT_ID) rmSync(legacyFile, { force: true });
    },
  };
  return {
    agents,
    load() {
      const record = load().find((entry) => entry.agentId === LEGACY_TELEGRAM_AGENT_ID);
      return record?.ownerUserId ? { ownerUserId: record.ownerUserId, ownerChatId: record.ownerUserId, workspacePath: record.workspacePath, lastUpdateId: record.lastUpdateId, tokenFingerprint: record.tokenFingerprint } : null;
    },
    save(binding) {
      const old = load().find((entry) => entry.agentId === LEGACY_TELEGRAM_AGENT_ID);
      agents.save({ agentId: LEGACY_TELEGRAM_AGENT_ID, name: old?.name ?? "Telegram agent", instructions: old?.instructions ?? "", username: old?.username ?? null, telegramIdentityId: old?.telegramIdentityId ?? null, ownerUsername: old?.ownerUsername ?? null, ownerUserId: binding.ownerUserId, workspacePath: binding.workspacePath, lastUpdateId: binding.lastUpdateId, tokenFingerprint: binding.tokenFingerprint });
    },
    token: () => agents.token(LEGACY_TELEGRAM_AGENT_ID),
    setToken: (token) => agents.setToken(LEGACY_TELEGRAM_AGENT_ID, token),
    revoke: () => agents.remove(LEGACY_TELEGRAM_AGENT_ID),
  };
}
