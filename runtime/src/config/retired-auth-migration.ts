import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import { GATEWAY_CREDENTIAL_ENV_NAMES } from "../gateway/credentials.js";
import { parseChatgptAccountId } from "../services/api/openAiCodeOAuthShared.js";
import type {
  LocalAuthSecureStorage,
  RemoteAuthSecureStorage,
  SecureStorageData,
} from "../utils/secureStorage/index.js";
import type { HomeContext, HomeEnvironment } from "./home.js";
import { duplicateJsonObjectPaths } from "./json.js";
import {
  migrateRetiredOpenAiCredential,
  OpenAiCredentialMigrationError,
  type RetiredOpenAiCredential,
} from "./openai-credential-migration.js";
import { readStableFile } from "./stable-file.js";

export type RetiredAuthSourceKind =
  | "auth-json"
  | "byok-json"
  | "remote-oauth-token"
  | "remote-api-key"
  | "remote-session-ingress-token"
  | "provider-code-auth-json"
  | "gateway-env"
  | "gateway-hooks-token"
  | "gateway-webchat-token";

export interface RetiredAuthMigrationEnvironment extends HomeEnvironment {
  readonly AGENC_REMOTE_TOKEN_DIR?: string;
  readonly AGENC_SESSION_INGRESS_TOKEN_FILE?: string;
  readonly PROVIDER_CODE_AUTH_JSON_PATH?: string;
  readonly PROVIDER_CODE_HOME?: string;
  readonly PROVIDER_CODE_ACCOUNT_ID?: string;
  readonly CHATGPT_ACCOUNT_ID?: string;
  readonly AGENC_ACCOUNT_ID?: string;
  readonly AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT?: string;
}

export interface RetiredAuthMigrationInput {
  readonly kind: RetiredAuthSourceKind;
  readonly path: string;
  readonly sha256: string;
  readonly mode: number;
}

export interface RetiredAuthMigrationConflict {
  readonly kind:
    | RetiredAuthSourceKind
    | "retired-native-openai-oauth"
    | "retired-windows-password-vault";
  readonly path?: string;
  readonly field?: string;
  readonly reason: string;
}

export interface RetiredAuthFileActionDescriptor {
  readonly kind: "delete" | "rewrite";
  readonly path: string;
  readonly beforeSha256: string;
  readonly afterSha256?: string;
}

/** Safe to attach to or print with the ordinary config migration plan. */
export interface RetiredAuthMigrationDescriptor {
  readonly inputs: readonly RetiredAuthMigrationInput[];
  readonly fileActions: readonly RetiredAuthFileActionDescriptor[];
  /** Stable field name retained for serialized migration-plan compatibility. */
  readonly vaultFields: readonly string[];
  readonly conflicts: readonly RetiredAuthMigrationConflict[];
}

export interface RetiredAuthFileAction
  extends RetiredAuthFileActionDescriptor {
  readonly mode: number;
  /** Present only for a metadata-only rewrite; it never contains a secret. */
  readonly content?: string;
}

export interface RetiredAuthSecureStorageWrite {
  readonly field: string;
  /** Structured path segments; unlike `field`, provider slugs are not parsed. */
  readonly path: readonly string[];
  readonly expectedPresent: boolean;
  readonly expectedValue?: unknown;
  readonly desiredPresent: boolean;
  readonly value?: unknown;
}

/**
 * In-memory apply payload. It contains credentials and must never be written to
 * a migration plan, journal, backup, archive, log, or diagnostic response.
 */
export interface RetiredAuthSecureStorageMutation {
  /** Stable field name retained for serialized journal compatibility. */
  readonly vaultWrites: readonly RetiredAuthSecureStorageWrite[];
  readonly fileActions: readonly RetiredAuthFileAction[];
}

export class RetiredAuthSecureStorageConflictError extends Error {
  readonly name = "RetiredAuthSecureStorageConflictError";
  readonly field: string;

  constructor(field: string) {
    super(
      `Native secure storage changed after retired credential discovery at ${field}; run migration check again`,
    );
    this.field = field;
  }
}

export interface RetiredAuthMigrationDiscovery {
  readonly descriptor: RetiredAuthMigrationDescriptor;
  readonly mutation?: RetiredAuthSecureStorageMutation;
}

export interface DiscoverRetiredAuthMigrationOptions {
  readonly home: HomeContext;
  /** The OS user home used by the retired remote and ProviderCode defaults. */
  readonly platformHome: string;
  readonly env?: RetiredAuthMigrationEnvironment;
  readonly currentSecureStorage: Readonly<SecureStorageData>;
}

interface Candidate {
  readonly kind: RetiredAuthSourceKind;
  readonly path: string;
}

interface ReadCandidate extends Candidate {
  readonly bytes: Buffer;
  readonly text: string;
  readonly sha256: string;
  readonly mode: number;
}

interface LocalLoginCredential {
  readonly token: string;
  readonly createdAt: string;
}

interface ByokCredential {
  readonly provider: string;
  readonly apiKey: string;
  readonly savedAt: string;
}

interface ParsedProviderCodeCredential {
  readonly apiKey?: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly accountId?: string;
}

const GATEWAY_CREDENTIAL_ENV_NAME_SET: ReadonlySet<string> = new Set(
  GATEWAY_CREDENTIAL_ENV_NAMES,
);
const RETIRED_GATEWAY_HOOKS_ENV_NAME = "AGENC_GATEWAY_HOOKS_TOKEN";
const CANONICAL_GATEWAY_HOOKS_ENV_NAME = "AGENC_HOOKS_TOKEN";
const MIN_GATEWAY_SURFACE_TOKEN_LENGTH = 16;

class DiscoveryBuilder {
  readonly inputs: RetiredAuthMigrationInput[] = [];
  readonly actions: RetiredAuthFileAction[] = [];
  readonly conflicts: RetiredAuthMigrationConflict[] = [];
  readonly vaultFields = new Set<string>();
  readonly sourceByVaultField = new Map<string, string>();
  readonly pathByVaultField = new Map<string, readonly string[]>();
  readonly initialVault: Readonly<SecureStorageData>;
  nextVault: SecureStorageData;

  constructor(currentVault: Readonly<SecureStorageData>) {
    this.initialVault = structuredClone(currentVault);
    this.nextVault = structuredClone(currentVault);
  }

  conflict(
    kind: RetiredAuthMigrationConflict["kind"],
    reason: string,
    options: { readonly path?: string; readonly field?: string } = {},
  ): void {
    this.conflicts.push(Object.freeze({ kind, reason, ...options }));
  }

  input(candidate: ReadCandidate): void {
    this.inputs.push(Object.freeze({
      kind: candidate.kind,
      path: candidate.path,
      sha256: candidate.sha256,
      mode: candidate.mode,
    }));
  }

  action(action: RetiredAuthFileAction): void {
    this.actions.push(Object.freeze(action));
  }

  registerField(
    field: string,
    sourcePath: string,
    path: readonly string[] = field.split("."),
  ): void {
    for (const [registeredField, registeredPath] of this.pathByVaultField) {
      if (pathStartsWith(path, registeredPath)) {
        // The existing parent write reads its final value from nextVault after
        // discovery, so it already includes this descendant mutation.
        return;
      }
      if (pathStartsWith(registeredPath, path)) {
        // Replace descendant writes with the newly registered parent. Keeping
        // both would make the first write invalidate the second write's CAS
        // expectation even though they belong to one atomic migration.
        this.vaultFields.delete(registeredField);
        this.pathByVaultField.delete(registeredField);
        this.sourceByVaultField.delete(registeredField);
      }
    }
    this.vaultFields.add(field);
    this.pathByVaultField.set(field, Object.freeze([...path]));
    if (!this.sourceByVaultField.has(field)) {
      this.sourceByVaultField.set(field, sourcePath);
    }
  }
}

function pathStartsWith(
  path: readonly string[],
  prefix: readonly string[],
): boolean {
  return prefix.length <= path.length &&
    prefix.every((segment, index) => path[index] === segment);
}

/**
 * Discover retired credential files without mutating disk or native storage.
 * Every path authority is explicit: no process environment, cwd, or homedir is
 * consulted. If any source is ambiguous, malformed, or conflicts with the
 * current native secure storage, `mutation` is omitted so callers must plan
 * zero writes.
 */
export async function discoverRetiredAuthMigration(
  options: DiscoverRetiredAuthMigrationOptions,
): Promise<RetiredAuthMigrationDiscovery> {
  const builder = new DiscoveryBuilder(options.currentSecureStorage);
  migrateRetiredNativeOpenAiOauth(builder);
  const env = options.env ?? {};
  const platformHome = absoluteMigrationPath(
    options.platformHome,
    "platformHome",
    builder,
    "auth-json",
  );

  if (env.AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT !== undefined) {
    builder.conflict(
      "retired-windows-password-vault",
      "The retired Windows PasswordVault credential source cannot be imported safely by this migration. Remove the retired environment variable after exporting credentials through a supported AgenC version, then run migration again.",
      { field: "AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT" },
    );
  }

  if (platformHome === undefined) {
    return finishDiscovery(builder);
  }

  const candidates = migrationCandidates(
    options.home,
    platformHome,
    env,
    builder,
  );
  const readable = await readCandidates(candidates, builder);
  const collisions = candidatePathCollisions(readable);
  for (const collision of collisions) {
    builder.conflict(
      collision[0]?.kind ?? "auth-json",
      `One retired credential file was selected for multiple incompatible source formats: ${collision.map((item) => item.kind).join(", ")}`,
      { path: collision[0]?.path },
    );
  }
  const collidedPaths = new Set(
    collisions.flatMap((items) => items.map((item) => item.path)),
  );

  for (const candidate of readable) {
    if (collidedPaths.has(candidate.path)) continue;
    switch (candidate.kind) {
      case "auth-json":
        parseAuthJson(candidate, builder);
        break;
      case "byok-json":
        parseByokJson(candidate, builder);
        break;
      case "remote-oauth-token":
        parseRemoteRuntimeToken(candidate, "oauthToken", builder);
        break;
      case "remote-api-key":
        parseRemoteRuntimeToken(candidate, "apiKey", builder);
        break;
      case "remote-session-ingress-token":
        parseRemoteRuntimeToken(candidate, "sessionIngressToken", builder);
        break;
      case "provider-code-auth-json":
        parseProviderCodeAuthJson(candidate, env, builder);
        break;
      case "gateway-env":
        parseGatewayEnv(candidate, builder);
        break;
      case "gateway-hooks-token":
        parseGatewayGeneratedToken(candidate, "hooks", builder);
        break;
      case "gateway-webchat-token":
        parseGatewayGeneratedToken(candidate, "webchat", builder);
        break;
    }
  }

  return finishDiscovery(builder);
}

/**
 * Apply only the imported credential leaves to the snapshot captured under
 * the native secure storage lock. Unrelated concurrent namespace changes are
 * preserved; a changed imported leaf fails closed instead of being clobbered.
 */
export function applyRetiredAuthSecureStorageMutation(
  current: Readonly<SecureStorageData>,
  mutation: Pick<RetiredAuthSecureStorageMutation, "vaultWrites">,
): SecureStorageData {
  let next = structuredClone(current) as SecureStorageData;
  for (const write of mutation.vaultWrites) {
    const existing = nestedField(next, write.path);
    const matchesDiscovery = existing.present === write.expectedPresent &&
      (!existing.present || sameValue(existing.value, write.expectedValue));
    if (!matchesDiscovery) {
      throw new RetiredAuthSecureStorageConflictError(write.field);
    }
    if (!write.desiredPresent) {
      if (existing.present) next = withoutNestedValue(next, write.path);
    } else if (!existing.present || !sameValue(existing.value, write.value)) {
      next = withNestedValue(next, write.path, write.value);
    }
  }
  return next;
}

/** Verify only the credential leaves owned by this migration mutation. */
export function assertRetiredAuthSecureStorageMutationCommitted(
  current: Readonly<SecureStorageData>,
  mutation: Pick<RetiredAuthSecureStorageMutation, "vaultWrites">,
): void {
  for (const write of mutation.vaultWrites) {
    const existing = nestedField(current, write.path);
    if (
      existing.present !== write.desiredPresent ||
      (write.desiredPresent && !sameValue(existing.value, write.value))
    ) {
      throw new RetiredAuthSecureStorageConflictError(write.field);
    }
  }
}

/**
 * Compensate a just-applied retired-auth secure-storage mutation before any
 * plaintext source has been deleted or rewritten. The compare step prevents
 * rollback from overwriting a concurrent update to an imported leaf.
 */
export function rollbackRetiredAuthSecureStorageMutation(
  current: Readonly<SecureStorageData>,
  mutation: Pick<RetiredAuthSecureStorageMutation, "vaultWrites">,
): SecureStorageData {
  let next = structuredClone(current) as SecureStorageData;
  for (const write of [...mutation.vaultWrites].reverse()) {
    const existing = nestedField(next, write.path);
    if (
      existing.present !== write.desiredPresent ||
      (write.desiredPresent && !sameValue(existing.value, write.value))
    ) {
      throw new RetiredAuthSecureStorageConflictError(write.field);
    }
    next = write.expectedPresent
      ? withNestedValue(next, write.path, write.expectedValue)
      : withoutNestedValue(next, write.path);
  }
  return next;
}

function migrationCandidates(
  home: HomeContext,
  platformHome: string,
  env: RetiredAuthMigrationEnvironment,
  builder: DiscoveryBuilder,
): readonly Candidate[] {
  const candidates: Candidate[] = [
    { kind: "auth-json", path: home.authPath },
    { kind: "byok-json", path: join(home.path, "byok-keys.json") },
    { kind: "gateway-env", path: join(home.path, "gateway", "env") },
    {
      kind: "gateway-hooks-token",
      path: join(home.path, "gateway", "hooks-token"),
    },
    {
      kind: "gateway-webchat-token",
      path: join(home.path, "gateway", "webchat-token"),
    },
  ];

  const remoteDirectory = env.AGENC_REMOTE_TOKEN_DIR === undefined
    ? join(platformHome, ".agenc", "remote")
    : absoluteMigrationPath(
        env.AGENC_REMOTE_TOKEN_DIR,
        "AGENC_REMOTE_TOKEN_DIR",
        builder,
        "remote-oauth-token",
      );
  if (remoteDirectory !== undefined) {
    candidates.push(
      { kind: "remote-oauth-token", path: join(remoteDirectory, ".oauth_token") },
      { kind: "remote-api-key", path: join(remoteDirectory, ".api_key") },
    );
  }
  const ingressPath = env.AGENC_SESSION_INGRESS_TOKEN_FILE === undefined
    ? remoteDirectory === undefined
      ? undefined
      : join(remoteDirectory, ".session_ingress_token")
    : absoluteMigrationPath(
        env.AGENC_SESSION_INGRESS_TOKEN_FILE,
        "AGENC_SESSION_INGRESS_TOKEN_FILE",
        builder,
        "remote-session-ingress-token",
      );
  if (ingressPath !== undefined) {
    candidates.push({
      kind: "remote-session-ingress-token",
      path: ingressPath,
    });
  }

  const providerPath = providerCodeAuthPath(env, platformHome, builder);
  if (providerPath !== undefined) {
    candidates.push({ kind: "provider-code-auth-json", path: providerPath });
  }
  return Object.freeze(candidates.map((candidate) => Object.freeze({
    ...candidate,
    path: resolve(candidate.path).normalize("NFC"),
  })));
}

function providerCodeAuthPath(
  env: RetiredAuthMigrationEnvironment,
  platformHome: string,
  builder: DiscoveryBuilder,
): string | undefined {
  const explicitPath = env.PROVIDER_CODE_AUTH_JSON_PATH === undefined
    ? undefined
    : absoluteMigrationPath(
        env.PROVIDER_CODE_AUTH_JSON_PATH,
        "PROVIDER_CODE_AUTH_JSON_PATH",
        builder,
        "provider-code-auth-json",
      );
  const explicitHome = env.PROVIDER_CODE_HOME === undefined
    ? undefined
    : absoluteMigrationPath(
        env.PROVIDER_CODE_HOME,
        "PROVIDER_CODE_HOME",
        builder,
        "provider-code-auth-json",
      );
  if (explicitPath !== undefined && explicitHome !== undefined) {
    const fromHome = join(explicitHome, "auth.json");
    if (resolve(explicitPath) !== resolve(fromHome)) {
      builder.conflict(
        "provider-code-auth-json",
        "PROVIDER_CODE_AUTH_JSON_PATH and PROVIDER_CODE_HOME select different retired credential files; migration refuses to assign precedence",
        { path: explicitPath, field: "ProviderCode credential path" },
      );
      return undefined;
    }
  }
  if (explicitPath !== undefined) return explicitPath;
  if (explicitHome !== undefined) return join(explicitHome, "auth.json");
  return join(platformHome, ".providerCode", "auth.json");
}

function absoluteMigrationPath(
  value: string,
  field: string,
  builder: DiscoveryBuilder,
  kind: RetiredAuthSourceKind,
): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) {
    builder.conflict(
      kind,
      `${field} must be a non-empty absolute path during credential migration`,
      { field },
    );
    return undefined;
  }
  return resolve(trimmed).normalize("NFC");
}

async function readCandidates(
  candidates: readonly Candidate[],
  builder: DiscoveryBuilder,
): Promise<readonly ReadCandidate[]> {
  const result: ReadCandidate[] = [];
  for (const candidate of candidates) {
    try {
      const snapshot = await readStableFile(candidate.path);
      if (snapshot === null) continue;
      result.push(Object.freeze({
        ...candidate,
        bytes: snapshot.bytes,
        text: snapshot.bytes.toString("utf8"),
        sha256: sha256(snapshot.bytes),
        mode: snapshot.mode || 0o600,
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      builder.conflict(
        candidate.kind,
        `Credential migration could not inspect input: ${safeErrorCode(error)}`,
        { path: candidate.path },
      );
    }
  }
  return Object.freeze(result);
}

function candidatePathCollisions(
  candidates: readonly ReadCandidate[],
): readonly (readonly ReadCandidate[])[] {
  const byPath = new Map<string, ReadCandidate[]>();
  for (const candidate of candidates) {
    const values = byPath.get(candidate.path) ?? [];
    values.push(candidate);
    byPath.set(candidate.path, values);
  }
  return Object.freeze(
    [...byPath.values()]
      .filter((values) => new Set(values.map((value) => value.kind)).size > 1)
      .map((values) => Object.freeze(values)),
  );
}

function parseAuthJson(
  candidate: ReadCandidate,
  builder: DiscoveryBuilder,
): void {
  const parsed = parseJsonRecord(candidate, builder);
  if (parsed === undefined) return;
  const hasToken = Object.hasOwn(parsed, "token");
  const hasByok = Object.hasOwn(parsed, "byokKeys");
  const metadata = metadataOnlyAuthState(parsed);
  const content = `${JSON.stringify(metadata, null, 2)}\n`;
  const needsRewrite = sha256(content) !== candidate.sha256;
  if (!hasToken && !hasByok && !needsRewrite) return;

  builder.input(candidate);
  const provider = trimmedString(parsed.provider);
  if (hasToken) {
    const token = trimmedString(parsed.token);
    const createdAt = trimmedString(parsed.createdAt);
    if (token === undefined || createdAt === undefined) {
      builder.conflict(
        candidate.kind,
        "Legacy auth.json token requires non-empty token and createdAt fields",
        { path: candidate.path, field: "token" },
      );
    } else if (provider === "local") {
      mergeLocalLogin({ token, createdAt }, candidate.path, builder);
    } else if (provider === "remote") {
      mergeRemoteBearer(
        { bearerToken: token, createdAt },
        candidate.path,
        builder,
      );
    } else {
      builder.conflict(
        candidate.kind,
        "Legacy auth.json token has no recognized local/remote provider owner",
        { path: candidate.path, field: "provider" },
      );
    }
  }
  if (hasByok) {
    const byok = parseByokMap(parsed.byokKeys, candidate, builder);
    if (byok !== undefined) mergeByokMap(byok, candidate.path, builder);
  }

  if (needsRewrite) {
    builder.action({
      kind: "rewrite",
      path: candidate.path,
      beforeSha256: candidate.sha256,
      afterSha256: sha256(content),
      mode: candidate.mode,
      content,
    });
  }
}

function metadataOnlyAuthState(
  parsed: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const field of [
    "version",
    "provider",
    "createdAt",
    "identity",
    "subscriptionTier",
    "expiresAt",
  ] as const) {
    if (parsed[field] !== undefined) {
      metadata[field] = structuredClone(parsed[field]);
    }
  }
  return metadata;
}

function parseByokJson(
  candidate: ReadCandidate,
  builder: DiscoveryBuilder,
): void {
  const parsed = parseJsonRecord(candidate, builder);
  if (parsed === undefined) return;
  if (parsed.version !== 1 || !Object.hasOwn(parsed, "byokKeys")) {
    builder.conflict(
      candidate.kind,
      "Retired byok-keys.json must be a version 1 document with byokKeys",
      { path: candidate.path },
    );
    return;
  }
  builder.input(candidate);
  const byok = parseByokMap(parsed.byokKeys, candidate, builder);
  if (byok !== undefined) mergeByokMap(byok, candidate.path, builder);
  builder.action(deleteAction(candidate));
}

function parseByokMap(
  value: unknown,
  candidate: ReadCandidate,
  builder: DiscoveryBuilder,
): Record<string, ByokCredential> | undefined {
  if (!isRecord(value)) {
    builder.conflict(
      candidate.kind,
      "Retired BYOK credentials must be an object keyed by provider",
      { path: candidate.path, field: "byokKeys" },
    );
    return undefined;
  }
  const result: Record<string, ByokCredential> = {};
  for (const [providerKey, raw] of Object.entries(value)) {
    if (!isRecord(raw)) {
      builder.conflict(
        candidate.kind,
        `Retired BYOK record is not an object for provider ${providerKey}`,
        { path: candidate.path, field: `byokKeys.${providerKey}` },
      );
      continue;
    }
    const provider = trimmedString(raw.provider);
    const apiKey = trimmedString(raw.apiKey);
    const savedAt = trimmedString(raw.savedAt);
    if (
      provider === undefined ||
      provider !== providerKey ||
      provider !== provider.toLowerCase() ||
      /\s/u.test(provider) ||
      apiKey === undefined ||
      /\s/u.test(apiKey) ||
      savedAt === undefined
    ) {
      builder.conflict(
        candidate.kind,
        `Retired BYOK record is malformed for provider ${providerKey}`,
        { path: candidate.path, field: `byokKeys.${providerKey}` },
      );
      continue;
    }
    result[provider] = { provider, apiKey, savedAt };
  }
  return result;
}

function parseGatewayEnv(
  candidate: ReadCandidate,
  builder: DiscoveryBuilder,
): void {
  builder.input(candidate);
  const conflictCount = builder.conflicts.length;
  if (!Buffer.from(candidate.text, "utf8").equals(candidate.bytes)) {
    builder.conflict(
      candidate.kind,
      "Retired gateway/env is not valid UTF-8",
      { path: candidate.path },
    );
    return;
  }

  const entries = new Map<string, string>();
  const seenNames = new Set<string>();
  const lines = candidate.text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (
      separator <= 0 ||
      line.includes("\0") ||
      line.includes("\r")
    ) {
      builder.conflict(
        candidate.kind,
        `Retired gateway/env line ${index + 1} is malformed; expected NAME=VALUE`,
        { path: candidate.path },
      );
      continue;
    }
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (name.trim() !== name || !/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      builder.conflict(
        candidate.kind,
        `Retired gateway/env line ${index + 1} has a malformed environment name`,
        { path: candidate.path },
      );
      continue;
    }
    if (seenNames.has(name)) {
      builder.conflict(
        candidate.kind,
        `Retired gateway/env contains duplicate credential key ${name}`,
        { path: candidate.path, field: name },
      );
      continue;
    }
    seenNames.add(name);
    if (
      !GATEWAY_CREDENTIAL_ENV_NAME_SET.has(name) &&
      name !== RETIRED_GATEWAY_HOOKS_ENV_NAME
    ) {
      builder.conflict(
        candidate.kind,
        `Retired gateway/env contains unsupported non-secret or unknown key ${name}; persistent non-secret settings belong in config.toml`,
        { path: candidate.path, field: name },
      );
      continue;
    }
    if (value.length === 0 || value.trim().length === 0) {
      builder.conflict(
        candidate.kind,
        `Retired gateway/env credential ${name} is empty`,
        { path: candidate.path, field: name },
      );
      continue;
    }
    entries.set(name, value);
  }

  const retiredHooks = entries.get(RETIRED_GATEWAY_HOOKS_ENV_NAME);
  const canonicalHooks = entries.get(CANONICAL_GATEWAY_HOOKS_ENV_NAME);
  if (
    retiredHooks !== undefined &&
    canonicalHooks !== undefined &&
    retiredHooks !== canonicalHooks
  ) {
    builder.conflict(
      candidate.kind,
      "Retired AGENC_GATEWAY_HOOKS_TOKEN conflicts with AGENC_HOOKS_TOKEN; migration refuses to assign precedence",
      { path: candidate.path, field: CANONICAL_GATEWAY_HOOKS_ENV_NAME },
    );
  } else if (retiredHooks !== undefined && canonicalHooks === undefined) {
    entries.set(CANONICAL_GATEWAY_HOOKS_ENV_NAME, retiredHooks);
  }
  entries.delete(RETIRED_GATEWAY_HOOKS_ENV_NAME);

  for (const name of [
    "AGENC_WEBCHAT_TOKEN",
    CANONICAL_GATEWAY_HOOKS_ENV_NAME,
  ] as const) {
    const value = entries.get(name);
    if (
      value !== undefined &&
      value.trim().length < MIN_GATEWAY_SURFACE_TOKEN_LENGTH
    ) {
      builder.conflict(
        candidate.kind,
        `Retired gateway/env credential ${name} is shorter than ${MIN_GATEWAY_SURFACE_TOKEN_LENGTH} characters`,
        { path: candidate.path, field: name },
      );
    }
  }

  if (builder.conflicts.length !== conflictCount) return;
  for (const [name, value] of entries) {
    mergeGatewayEnvironmentCredential(name, value, candidate, builder);
  }
  builder.action(deleteAction(candidate));
}

function mergeGatewayEnvironmentCredential(
  name: string,
  value: string,
  candidate: ReadCandidate,
  builder: DiscoveryBuilder,
): void {
  const field = `gateway.environment[${JSON.stringify(name)}]`;
  const current = builder.nextVault.gateway?.environment?.[name];
  if (current !== undefined && current !== value) {
    secureStorageConflict(field, candidate, builder);
    return;
  }
  builder.nextVault = {
    ...builder.nextVault,
    gateway: {
      ...builder.nextVault.gateway,
      environment: {
        ...builder.nextVault.gateway?.environment,
        [name]: value,
      },
    },
  };
  builder.registerField(
    field,
    candidate.path,
    ["gateway", "environment", name],
  );
}

function parseGatewayGeneratedToken(
  candidate: ReadCandidate,
  name: "hooks" | "webchat",
  builder: DiscoveryBuilder,
): void {
  builder.input(candidate);
  const credential = candidate.text.trim();
  const field = `gateway.generatedTokens.${name}`;
  if (credential.length < MIN_GATEWAY_SURFACE_TOKEN_LENGTH) {
    builder.conflict(
      candidate.kind,
      credential.length === 0
        ? "Retired gateway surface token file is empty"
        : `Retired gateway surface token is shorter than ${MIN_GATEWAY_SURFACE_TOKEN_LENGTH} characters`,
      { path: candidate.path, field },
    );
    return;
  }
  const current = builder.nextVault.gateway?.generatedTokens?.[name];
  if (current !== undefined && current !== credential) {
    secureStorageConflict(field, candidate, builder);
    return;
  }
  builder.nextVault = {
    ...builder.nextVault,
    gateway: {
      ...builder.nextVault.gateway,
      generatedTokens: {
        ...builder.nextVault.gateway?.generatedTokens,
        [name]: credential,
      },
    },
  };
  builder.registerField(
    field,
    candidate.path,
    ["gateway", "generatedTokens", name],
  );
  builder.action(deleteAction(candidate));
}

function parseRemoteRuntimeToken(
  candidate: ReadCandidate,
  field: "apiKey" | "oauthToken" | "sessionIngressToken",
  builder: DiscoveryBuilder,
): void {
  builder.input(candidate);
  const credential = candidate.text.trim();
  if (credential.length === 0) {
    builder.conflict(
      candidate.kind,
      "Retired remote credential file is empty",
      { path: candidate.path, field },
    );
    return;
  }
  const current = builder.nextVault.remoteRuntimeAuth?.[field];
  if (current !== undefined && current !== credential) {
    secureStorageConflict(
      fieldPath("remoteRuntimeAuth", field),
      candidate,
      builder,
    );
    return;
  }
  builder.nextVault = {
    ...builder.nextVault,
    remoteRuntimeAuth: {
      ...builder.nextVault.remoteRuntimeAuth,
      [field]: credential,
    },
  };
  builder.registerField(fieldPath("remoteRuntimeAuth", field), candidate.path);
  builder.action(deleteAction(candidate));
}

function parseProviderCodeAuthJson(
  candidate: ReadCandidate,
  env: RetiredAuthMigrationEnvironment,
  builder: DiscoveryBuilder,
): void {
  const parsed = parseJsonRecord(candidate, builder);
  if (parsed === undefined) return;
  builder.input(candidate);
  const conflictCount = builder.conflicts.length;
  const credential = providerCodeCredential(parsed, env, candidate, builder);
  if (credential === undefined) {
    if (builder.conflicts.length === conflictCount) {
      builder.conflict(
        candidate.kind,
        "ProviderCode auth.json contains no importable credential; migration will not delete an unrecognized credential file",
        { path: candidate.path, field: "ProviderCode credential" },
      );
    }
    return;
  }
  mergeProviderCodeCredential(credential, candidate, builder);
  builder.action(deleteAction(candidate));
}

function migrateRetiredNativeOpenAiOauth(builder: DiscoveryBuilder): void {
  const retiredVault = builder.nextVault as SecureStorageData & {
    readonly agenc?: RetiredOpenAiCredential;
  };
  const retired = retiredVault.agenc;
  if (retired === undefined) return;

  const source = "native secure storage";
  let openAiOauth: NonNullable<SecureStorageData["openAiOauth"]>;
  try {
    openAiOauth = migrateRetiredOpenAiCredential(
      retired,
      builder.nextVault.openAiOauth,
    );
  } catch (error) {
    const field = error instanceof OpenAiCredentialMigrationError
      ? error.field
      : "agenc";
    builder.conflict(
      "retired-native-openai-oauth",
      error instanceof OpenAiCredentialMigrationError
        ? error.message
        : "Retired native OpenAI credentials could not be migrated safely.",
      { field },
    );
    return;
  }

  const next: SecureStorageData & { agenc?: RetiredOpenAiCredential } = {
    ...builder.nextVault,
    openAiOauth,
  };
  delete next.agenc;
  builder.nextVault = next;
  builder.registerField("openAiOauth", source, ["openAiOauth"]);
  builder.registerField("agenc", source, ["agenc"]);
}

function providerCodeCredential(
  parsed: Record<string, unknown>,
  env: RetiredAuthMigrationEnvironment,
  candidate: ReadCandidate,
  builder: DiscoveryBuilder,
): ParsedProviderCodeCredential | undefined {
  const apiKey = uniqueCredentialString(
    nestedStrings(parsed, [
      ["openai_api_key"],
      ["openaiApiKey"],
    ]),
    "ProviderCode API key",
    candidate,
    builder,
  );
  const accessToken = uniqueCredentialString(
    nestedStrings(parsed, [
      ["access_token"],
      ["accessToken"],
      ["tokens", "access_token"],
      ["tokens", "accessToken"],
      ["auth", "access_token"],
      ["auth", "accessToken"],
      ["token", "access_token"],
      ["token", "accessToken"],
    ]),
    "ProviderCode access token",
    candidate,
    builder,
  );
  const refreshToken = uniqueCredentialString(
    nestedStrings(parsed, [
      ["refresh_token"],
      ["refreshToken"],
      ["tokens", "refresh_token"],
      ["tokens", "refreshToken"],
    ]),
    "ProviderCode refresh token",
    candidate,
    builder,
  );
  if (apiKey === undefined && accessToken === undefined) return undefined;
  const idToken = uniqueCredentialString(
    nestedStrings(parsed, [
      ["id_token"],
      ["idToken"],
      ["tokens", "id_token"],
      ["tokens", "idToken"],
    ]),
    "ProviderCode identity token",
    candidate,
    builder,
  );
  if (builder.conflicts.some((conflict) =>
    conflict.path === candidate.path &&
    conflict.field === "ProviderCode identity token"
  )) {
    return undefined;
  }
  const accountId = uniqueCredentialString(
    [
      ...environmentStrings(env, [
        "PROVIDER_CODE_ACCOUNT_ID",
        "CHATGPT_ACCOUNT_ID",
        "AGENC_ACCOUNT_ID",
      ]),
      ...nestedStrings(parsed, [
      ["account_id"],
      ["accountId"],
      ["tokens", "account_id"],
      ["tokens", "accountId"],
      ["auth", "account_id"],
      ["auth", "accountId"],
      ]),
      ...derivedCredentialStrings([
        ["access-token JWT claim", parseChatgptAccountId(accessToken)],
        ["identity JWT claim", parseChatgptAccountId(idToken)],
      ]),
    ],
    "ProviderCode account id",
    candidate,
    builder,
  );
  if (builder.conflicts.some((conflict) =>
    conflict.path === candidate.path &&
    conflict.field === "ProviderCode account id"
  )) {
    return undefined;
  }
  if (apiKey === undefined && accountId === undefined) {
    builder.conflict(
      candidate.kind,
      "ProviderCode access token has no ChatGPT account id; migration cannot construct a usable subscription credential",
      { path: candidate.path, field: "ProviderCode account id" },
    );
    return undefined;
  }
  return {
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(accessToken !== undefined ? { accessToken } : {}),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(idToken !== undefined ? { idToken } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
  };
}

function mergeLocalLogin(
  credential: LocalLoginCredential,
  sourcePath: string,
  builder: DiscoveryBuilder,
): void {
  const field = "localAuth.login";
  const current = builder.nextVault.localAuth?.login;
  if (current !== undefined && !sameValue(current, credential)) {
    secureStorageConflict(
      field,
      { kind: "auth-json", path: sourcePath },
      builder,
    );
    return;
  }
  builder.nextVault = {
    ...builder.nextVault,
    localAuth: {
      ...builder.nextVault.localAuth,
      login: structuredClone(credential),
    },
  };
  builder.registerField(field, sourcePath);
}

function mergeRemoteBearer(
  credential: RemoteAuthSecureStorage,
  sourcePath: string,
  builder: DiscoveryBuilder,
): void {
  const field = "remoteAuth";
  const current = builder.nextVault.remoteAuth;
  if (current !== undefined && !sameValue(current, credential)) {
    secureStorageConflict(
      field,
      { kind: "auth-json", path: sourcePath },
      builder,
    );
    return;
  }
  builder.nextVault = {
    ...builder.nextVault,
    remoteAuth: structuredClone(credential),
  };
  builder.registerField(field, sourcePath);
}

function mergeByokMap(
  byok: Readonly<Record<string, ByokCredential>>,
  sourcePath: string,
  builder: DiscoveryBuilder,
): void {
  const localAuth: LocalAuthSecureStorage = structuredClone(
    builder.nextVault.localAuth ?? {},
  );
  const nextByok = { ...(localAuth.byokKeys ?? {}) };
  for (const [provider, credential] of Object.entries(byok)) {
    const field = `localAuth.byokKeys[${JSON.stringify(provider)}]`;
    const current = nextByok[provider];
    if (current !== undefined && !sameValue(current, credential)) {
      secureStorageConflict(
        field,
        { kind: "byok-json", path: sourcePath },
        builder,
      );
      continue;
    }
    Object.defineProperty(nextByok, provider, {
      value: structuredClone(credential),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    builder.registerField(
      field,
      sourcePath,
      ["localAuth", "byokKeys", provider],
    );
  }
  if (Object.keys(byok).length > 0) {
    localAuth.byokKeys = nextByok;
    builder.nextVault = { ...builder.nextVault, localAuth };
  }
}

function mergeProviderCodeCredential(
  credential: ParsedProviderCodeCredential,
  candidate: ReadCandidate,
  builder: DiscoveryBuilder,
): void {
  const existing = builder.nextVault.openAiOauth ?? {};
  const imported = {
    ...credential,
    authMode: credential.apiKey === undefined ? "chatgpt" : "apiKey",
  } satisfies NonNullable<SecureStorageData["openAiOauth"]>;
  for (const [field, value] of Object.entries(imported)) {
    const current = existing[field as keyof typeof existing];
    if (current !== undefined && !sameValue(current, value)) {
      secureStorageConflict(`openAiOauth.${field}`, candidate, builder);
      return;
    }
  }
  builder.nextVault = {
    ...builder.nextVault,
    openAiOauth: { ...existing, ...imported },
  };
  for (const field of Object.keys(imported)) {
    builder.registerField(`openAiOauth.${field}`, candidate.path);
  }
}

function secureStorageConflict(
  field: string,
  candidate: Pick<Candidate, "kind" | "path">,
  builder: DiscoveryBuilder,
): void {
  const earlier = builder.sourceByVaultField.get(field);
  builder.conflict(
    candidate.kind,
    earlier === undefined
      ? `Retired credential conflicts with native secure storage field ${field}`
      : `Retired credential conflicts with another retired source for native secure storage field ${field}`,
    { path: candidate.path, field },
  );
}

function parseJsonRecord(
  candidate: ReadCandidate,
  builder: DiscoveryBuilder,
): Record<string, unknown> | undefined {
  if (duplicateJsonObjectPaths(candidate.text).length > 0) {
    builder.conflict(
      candidate.kind,
      "Credential JSON contains duplicate object keys",
      { path: candidate.path },
    );
    return undefined;
  }
  try {
    const parsed = JSON.parse(candidate.text) as unknown;
    if (!isRecord(parsed)) {
      builder.conflict(
        candidate.kind,
        "Credential JSON root must be an object",
        { path: candidate.path },
      );
      return undefined;
    }
    return parsed;
  } catch {
    builder.conflict(
      candidate.kind,
      "Credential JSON is malformed",
      { path: candidate.path },
    );
    return undefined;
  }
}

interface CredentialStringCandidate {
  readonly source: string;
  readonly value: string;
}

function nestedStrings(
  value: Readonly<Record<string, unknown>>,
  paths: readonly (readonly string[])[],
): readonly CredentialStringCandidate[] {
  const result: CredentialStringCandidate[] = [];
  for (const path of paths) {
    let current: unknown = value;
    for (const key of path) {
      if (!isRecord(current)) {
        current = undefined;
        break;
      }
      current = current[key];
    }
    const parsed = trimmedString(current);
    if (parsed !== undefined) {
      result.push({ source: path.join("."), value: parsed });
    }
  }
  return result;
}

function environmentStrings(
  env: RetiredAuthMigrationEnvironment,
  fields: readonly (keyof RetiredAuthMigrationEnvironment)[],
): readonly CredentialStringCandidate[] {
  return fields.flatMap((field) => {
    const value = trimmedString(env[field]);
    return value === undefined ? [] : [{ source: String(field), value }];
  });
}

function derivedCredentialStrings(
  values: readonly (readonly [source: string, value: string | undefined])[],
): readonly CredentialStringCandidate[] {
  return values.flatMap(([source, value]) =>
    value === undefined ? [] : [{ source, value }]
  );
}

function uniqueCredentialString(
  candidates: readonly CredentialStringCandidate[],
  field: string,
  candidate: Pick<Candidate, "kind" | "path">,
  builder: DiscoveryBuilder,
): string | undefined {
  const byValue = new Map<string, string[]>();
  for (const value of candidates) {
    const sources = byValue.get(value.value) ?? [];
    sources.push(value.source);
    byValue.set(value.value, sources);
  }
  if (byValue.size === 0) return undefined;
  if (byValue.size > 1) {
    builder.conflict(
      candidate.kind,
      `Retired ${field} aliases disagree (${candidates.map((value) => value.source).join(", ")}); migration refuses to assign precedence`,
      { path: candidate.path, field },
    );
    return undefined;
  }
  return byValue.keys().next().value;
}

function finishDiscovery(
  builder: DiscoveryBuilder,
): RetiredAuthMigrationDiscovery {
  const inputs = sortedInputs(builder.inputs);
  const actions = sortedActions(builder.actions);
  const conflicts = Object.freeze([...builder.conflicts].sort((left, right) =>
    `${left.path ?? ""}\0${left.field ?? ""}\0${left.reason}`.localeCompare(
      `${right.path ?? ""}\0${right.field ?? ""}\0${right.reason}`,
    )
  ));
  const descriptor: RetiredAuthMigrationDescriptor = Object.freeze({
    inputs,
    fileActions: Object.freeze(actions.map(({ mode: _mode, content: _content, ...action }) =>
      Object.freeze(action)
    )),
    vaultFields: Object.freeze([...builder.vaultFields].sort()),
    conflicts,
  });
  if (conflicts.length > 0) return Object.freeze({ descriptor });
  return Object.freeze({
    descriptor,
    mutation: Object.freeze({
      vaultWrites: Object.freeze(
        [...builder.vaultFields]
          .sort()
          .map((field) => {
            const path = builder.pathByVaultField.get(field);
            if (path === undefined) {
              throw new Error(
                `Missing retired-auth native secure storage path for ${field}`,
              );
            }
            const expected = nestedField(builder.initialVault, path);
            const desired = nestedField(builder.nextVault, path);
            return Object.freeze({
              field,
              path,
              expectedPresent: expected.present,
              ...(expected.present
                ? { expectedValue: structuredClone(expected.value) }
                : {}),
              desiredPresent: desired.present,
              ...(desired.present
                ? { value: structuredClone(desired.value) }
                : {}),
            });
          }),
      ),
      fileActions: actions,
    }),
  });
}

function sortedInputs(
  values: readonly RetiredAuthMigrationInput[],
): readonly RetiredAuthMigrationInput[] {
  return Object.freeze([...values].sort((left, right) =>
    `${left.path}\0${left.kind}`.localeCompare(`${right.path}\0${right.kind}`)
  ));
}

function sortedActions(
  values: readonly RetiredAuthFileAction[],
): readonly RetiredAuthFileAction[] {
  return Object.freeze([...values].sort((left, right) =>
    `${left.path}\0${left.kind}`.localeCompare(`${right.path}\0${right.kind}`)
  ));
}

function deleteAction(candidate: ReadCandidate): RetiredAuthFileAction {
  return {
    kind: "delete",
    path: candidate.path,
    beforeSha256: candidate.sha256,
    mode: candidate.mode,
  };
}

function fieldPath(parent: string, child: string): string {
  return `${parent}.${child}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function nestedField(
  value: unknown,
  path: readonly string[],
): { readonly present: boolean; readonly value?: unknown } {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return { present: false };
    }
    current = current[segment];
  }
  return { present: true, value: current };
}

function withNestedValue(
  value: Readonly<SecureStorageData>,
  path: readonly string[],
  replacement: unknown,
): SecureStorageData {
  const root = structuredClone(value) as Record<string, unknown>;
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const existing = current[segment];
    const child = isRecord(existing) ? structuredClone(existing) : {};
    Object.defineProperty(current, segment, {
      value: child,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    current = child;
  }
  const leaf = path.at(-1);
  if (leaf === undefined) return root as unknown as SecureStorageData;
  Object.defineProperty(current, leaf, {
    value: structuredClone(replacement),
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return root as unknown as SecureStorageData;
}

function withoutNestedValue(
  value: Readonly<SecureStorageData>,
  path: readonly string[],
): SecureStorageData {
  const root = structuredClone(value) as unknown as Record<string, unknown>;
  const parents: Array<{
    readonly record: Record<string, unknown>;
    readonly segment: string;
  }> = [];
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const child = current[segment];
    if (!isRecord(child) || !Object.hasOwn(current, segment)) {
      return root as unknown as SecureStorageData;
    }
    parents.push({ record: current, segment });
    current = child;
  }
  const leaf = path.at(-1);
  if (leaf === undefined || !Object.hasOwn(current, leaf)) {
    return root as unknown as SecureStorageData;
  }
  delete current[leaf];
  for (const { record, segment } of parents.reverse()) {
    const child = record[segment];
    if (!isRecord(child) || Reflect.ownKeys(child).length > 0) break;
    delete record[segment];
  }
  return root as unknown as SecureStorageData;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function safeErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && code.length > 0 ? code : "read failed";
}
