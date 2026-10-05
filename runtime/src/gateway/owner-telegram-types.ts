export const TELEGRAM_AGENT_METHODS = ["telegram.agents.list", "telegram.agents.create", "telegram.agents.update", "telegram.agents.start", "telegram.agents.stop", "telegram.agents.remove", "telegram.agents.pair.begin", "telegram.agents.pair.confirm", "telegram.agents.pair.cancel"] as const;
export const OWNER_TELEGRAM_METHODS = ["telegram.capabilities", "telegram.status", "telegram.configure", "telegram.start", "telegram.stop", "telegram.revoke", ...TELEGRAM_AGENT_METHODS] as const;
export type OwnerTelegramMethod = (typeof OWNER_TELEGRAM_METHODS)[number];
export interface OwnerTelegramConfigureParams {
  readonly token: string;
  readonly ownerUserId: string;
  readonly ownerChatId?: string;
  readonly workspacePath: string;
}
export interface OwnerTelegramStatus {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly state: "unconfigured" | "stopped" | "connecting" | "connected" | "error";
  readonly ownerUserId: string | null;
  readonly ownerChatId: string | null;
  readonly workspacePath: string | null;
  readonly sessionId: string | null;
  readonly botUsername: string | null;
  readonly error: string | null;
  readonly lastUpdateAt: string | null;
}
export interface OwnerTelegramCapabilities {
  readonly available: true;
  readonly contractVersion: 2;
  readonly multiAgent: true;
  readonly providerSelection?: true;
  readonly accountLinking: "local-confirmation";
  readonly ownerOnly: true;
  readonly privateChatOnly: true;
  readonly nativeCredentialStorage: true;
  readonly approvals: "host-only";
  readonly commands: readonly ["new", "status", "cancel"];
}
export interface TelegramAgentCreateParams {
  readonly provider?: string;
  readonly model?: string;
  readonly name: string;
  readonly token: string;
  readonly workspacePath: string;
  readonly instructions?: string;
}
export interface TelegramAgentUpdateParams {
  readonly provider?: string;
  readonly model?: string;
  readonly agentId: string;
  readonly name?: string;
  readonly token?: string;
  readonly workspacePath?: string;
  readonly instructions?: string;
}
/** Ephemeral client snapshot. Never stored in agent metadata or returned in status. */
export interface TelegramAgentStartParams {
  readonly agentId: string;
  /** Binds the snapshot to the saved provider; stale clients must refresh. */
  readonly provider?: string;
  readonly envOverrides?: Readonly<Record<string, string>>;
}
export interface TelegramAccountCandidate {
  readonly userId: string;
  readonly username: string | null;
  readonly displayName: string;
}
export interface TelegramAgentPairing {
  readonly challengeId: string;
  readonly url: string;
  readonly qrDataUrl: string;
  readonly expiresAt: string;
  readonly candidate: TelegramAccountCandidate | null;
}
export interface TelegramAgentPairingResult {
  readonly agentId: string;
  readonly challengeId: string;
  readonly url: string;
  readonly qrDataUrl: string;
  readonly expiresAt: string;
}
export interface TelegramAgentStatus {
  readonly provider?: string;
  readonly model?: string;
  readonly agentId: string;
  readonly name: string;
  readonly instructions: string;
  readonly workspacePath: string;
  readonly username: string | null;
  readonly ownerUserId: string | null;
  readonly ownerUsername: string | null;
  readonly enabled: boolean;
  readonly state: "unlinked" | "linking" | "awaiting_confirmation" | "stopped" | "connecting" | "running" | "error";
  readonly sessionId: string | null;
  readonly error: string | null;
  readonly lastUpdateAt: string | null;
  readonly pairing: TelegramAgentPairing | null;
}
export interface OwnerTelegramBinding {
  readonly ownerUserId: string;
  readonly ownerChatId: string;
  readonly workspacePath: string;
  readonly lastUpdateId: number;
  /** Binds the non-secret configuration to exactly the native-stored credential. */
  readonly tokenFingerprint: string;
}
/** Non-secret durable identity. Account-link challenges are memory-only. */
export interface TelegramAgentRecord {
  readonly provider?: string;
  readonly model?: string;
  readonly agentId: string;
  readonly name: string;
  readonly instructions: string;
  readonly workspacePath: string;
  readonly telegramIdentityId: string | null;
  readonly username: string | null;
  readonly ownerUserId: string | null;
  readonly ownerUsername: string | null;
  readonly lastUpdateId: number;
  readonly tokenFingerprint: string;
}
