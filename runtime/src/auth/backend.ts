import type { ProviderSlug } from "../config/resolve-provider.js";

export type AuthJsonPrimitive = string | number | boolean | null;
export type AuthJsonArray = readonly AuthJsonValue[];
export type AuthJsonValue = AuthJsonPrimitive | AuthJsonArray | AuthJsonObject;
export interface AuthJsonObject {
  readonly [key: string]: AuthJsonValue | undefined;
}

export type AuthBackendKind = "local" | "remote";
export type AuthProviderSlug = ProviderSlug | "agenc";
export type AuthSessionId = string;
export type AuthSubscriptionTier = "free" | "pro" | "team" | "enterprise";

export interface AuthIdentity extends AuthJsonObject {
  readonly accountId?: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly plan?: string;
}

export interface AuthSessionRef extends AuthJsonObject {
  readonly sessionId?: AuthSessionId;
}

export interface AuthLoginParams extends AuthSessionRef {
  readonly provider?: AuthBackendKind;
}

export interface AuthLogoutParams extends AuthSessionRef {}

export interface AuthWhoamiParams extends AuthSessionRef {}

export interface AuthLoginResult extends AuthJsonObject {
  readonly authenticated: true;
  readonly provider?: AuthBackendKind;
  readonly sessionId?: AuthSessionId;
  readonly identity?: AuthIdentity;
}

export interface AuthWhoamiResult extends AuthJsonObject {
  readonly authenticated: boolean;
  readonly provider?: AuthBackendKind;
  readonly identity?: AuthIdentity;
}

export interface AuthLogoutResult extends AuthJsonObject {
  readonly authenticated: false;
}

export interface AuthVendedKey extends AuthJsonObject {
  readonly provider: string;
  readonly sessionId: AuthSessionId;
  readonly apiKey: string;
  readonly expiresAt?: string;
}

export interface AuthInferAgencModelParams extends AuthSessionRef {
  readonly requestedModel?: string;
  readonly provider?: AuthProviderSlug | string;
  readonly subscriptionTier?: AuthSubscriptionTier;
  readonly metadata?: AuthJsonObject;
}

export interface AuthInferredAgencModel extends AuthJsonObject {
  readonly provider: AuthProviderSlug | string;
  readonly model: string;
  readonly subscriptionTier?: AuthSubscriptionTier;
  readonly reason?: string;
  // Optional URL the daemon should use for AgenC-native model inference
  // when present. Lets the backend route per-tier or per-region (e.g.
  // free-tier users → us.agenc.tech) without daemon-side configuration
  // changes. Daemon implementations may ignore this field; if absent or
  // unhandled, the daemon falls back to its existing default URL.
  readonly endpointUrl?: string;
}

export interface AuthBackend {
  readonly kind?: AuthBackendKind;
  login(params?: AuthLoginParams): AuthLoginResult | Promise<AuthLoginResult>;
  logout(
    params?: AuthLogoutParams,
  ): AuthLogoutResult | Promise<AuthLogoutResult>;
  whoami(
    params?: AuthWhoamiParams,
  ): AuthWhoamiResult | Promise<AuthWhoamiResult>;
  vendKey(
    provider: AuthProviderSlug | string,
    sessionId: AuthSessionId,
  ): AuthVendedKey | Promise<AuthVendedKey>;
  inferAgencModel(
    params?: AuthInferAgencModelParams,
  ): AuthInferredAgencModel | Promise<AuthInferredAgencModel>;
  getSubscriptionTier(
    params?: AuthSessionRef,
  ): AuthSubscriptionTier | Promise<AuthSubscriptionTier>;
}
