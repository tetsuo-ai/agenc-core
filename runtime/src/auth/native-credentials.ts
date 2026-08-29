import {
  NativeSecureStorageError,
  readNativeSecureStorage,
  rollbackNativeSecureStorage,
  type NativeSecureStorageTransaction,
  updateNativeSecureStorage,
} from "../utils/secureStorage/native.js";
import type {
  LocalAuthSecureStorage,
  RemoteAuthSecureStorage,
  SecureStorageData,
} from "../utils/secureStorage/index.js";
import type { HomeContext } from "../config/home.js";

export type LocalLoginCredential = NonNullable<
  LocalAuthSecureStorage["login"]
>;
export type LocalByokCredential = NonNullable<
  LocalAuthSecureStorage["byokKeys"]
>[string];
export type RemoteBearerCredential = RemoteAuthSecureStorage;

const LOCAL_AUTH_STORAGE_UNAVAILABLE =
  "Native secure storage is required for local authentication credentials";
const REMOTE_AUTH_STORAGE_UNAVAILABLE =
  "Native secure storage is required for remote authentication credentials";

export function readLocalLoginCredential(
  home: HomeContext,
): LocalLoginCredential | undefined {
  const credential = readNativeSecureStorage(home).localAuth?.login;
  return isLocalLoginCredential(credential)
    ? structuredClone(credential)
    : undefined;
}

export function readLocalByokCredential(
  home: HomeContext,
  provider: string,
): LocalByokCredential | undefined {
  const credential = readNativeSecureStorage(home).localAuth?.byokKeys?.[provider];
  return isLocalByokCredential(credential)
    ? structuredClone(credential)
    : undefined;
}

export function storeLocalLoginCredential(
  home: HomeContext,
  credential: LocalLoginCredential,
): NativeSecureStorageTransaction | null {
  return updateNativeSecureStorage(
    home,
    (current) => withLocalLoginCredential(current, credential),
    LOCAL_AUTH_STORAGE_UNAVAILABLE,
  );
}

export function clearLocalLoginCredential(
  home: HomeContext,
): NativeSecureStorageTransaction | null {
  return updateNativeSecureStorage(
    home,
    (current) => withLocalLoginCredential(current, undefined),
    LOCAL_AUTH_STORAGE_UNAVAILABLE,
  );
}

export function rollbackLocalLoginCredential(
  home: HomeContext,
  transaction: NativeSecureStorageTransaction | null,
): void {
  rollbackNativeSecureStorage(
    home,
    transaction,
    (current, completed) => {
      const expected = completed.written.localAuth?.login;
      if (!sameCredential(current.localAuth?.login, expected)) {
        throw new NativeSecureStorageError(
          "Local authentication credential changed during rollback",
        );
      }
      return withLocalLoginCredential(
        current,
        completed.previous.localAuth?.login,
      );
    },
    "Failed to roll back the local authentication credential",
  );
}

export function storeLocalByokCredential(
  home: HomeContext,
  provider: string,
  credential: LocalByokCredential,
): void {
  updateNativeSecureStorage(
    home,
    (current) => {
      const localAuth = localAuthState(current.localAuth);
      return {
        ...current,
        localAuth: {
          ...localAuth,
          byokKeys: {
            ...localAuth.byokKeys,
            [provider]: structuredClone(credential),
          },
        },
      };
    },
    LOCAL_AUTH_STORAGE_UNAVAILABLE,
  );
}

export function readRemoteBearerCredential(
  home: HomeContext,
): RemoteBearerCredential | undefined {
  const credential = readNativeSecureStorage(home).remoteAuth;
  return isRemoteBearerCredential(credential)
    ? structuredClone(credential)
    : undefined;
}

export function storeRemoteBearerCredential(
  home: HomeContext,
  credential: RemoteBearerCredential,
): NativeSecureStorageTransaction | null {
  return updateNativeSecureStorage(
    home,
    (current) => ({
      ...current,
      remoteAuth: structuredClone(credential),
    }),
    REMOTE_AUTH_STORAGE_UNAVAILABLE,
  );
}

export function clearRemoteBearerCredential(
  home: HomeContext,
  expected?: RemoteBearerCredential,
): NativeSecureStorageTransaction | null {
  return updateNativeSecureStorage(
    home,
    (current) => {
      if (
        expected !== undefined &&
        !sameCredential(current.remoteAuth, expected)
      ) {
        throw new NativeSecureStorageError(
          "Remote authentication credential changed before sign-out",
        );
      }
      return withRemoteBearerCredential(current, undefined);
    },
    REMOTE_AUTH_STORAGE_UNAVAILABLE,
  );
}

export function rollbackRemoteBearerCredential(
  home: HomeContext,
  transaction: NativeSecureStorageTransaction | null,
): void {
  rollbackNativeSecureStorage(
    home,
    transaction,
    (current, completed) => {
      if (!sameCredential(current.remoteAuth, completed.written.remoteAuth)) {
        throw new NativeSecureStorageError(
          "Remote authentication credential changed during rollback",
        );
      }
      return withRemoteBearerCredential(
        current,
        completed.previous.remoteAuth,
      );
    },
    "Failed to roll back the remote authentication credential",
  );
}

function withLocalLoginCredential(
  current: Readonly<SecureStorageData>,
  credential: LocalLoginCredential | undefined,
): SecureStorageData {
  const next: SecureStorageData = { ...current };
  const localAuth = localAuthState(current.localAuth);
  if (credential === undefined) {
    delete localAuth.login;
  } else {
    localAuth.login = structuredClone(credential);
  }
  if (Object.keys(localAuth).length === 0) {
    delete next.localAuth;
  } else {
    next.localAuth = localAuth;
  }
  return next;
}

function withRemoteBearerCredential(
  current: Readonly<SecureStorageData>,
  credential: RemoteBearerCredential | undefined,
): SecureStorageData {
  const next: SecureStorageData = { ...current };
  if (credential === undefined) {
    delete next.remoteAuth;
  } else {
    next.remoteAuth = structuredClone(credential);
  }
  return next;
}

function localAuthState(
  value: Readonly<LocalAuthSecureStorage> | undefined,
): LocalAuthSecureStorage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return structuredClone(value);
}

function isLocalLoginCredential(
  value: unknown,
): value is LocalLoginCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const credential = value as Partial<LocalLoginCredential>;
  return (
    typeof credential.token === "string" &&
    credential.token.trim().length > 0 &&
    typeof credential.createdAt === "string" &&
    credential.createdAt.trim().length > 0
  );
}

function isLocalByokCredential(
  value: unknown,
): value is LocalByokCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const credential = value as Partial<LocalByokCredential>;
  return (
    typeof credential.provider === "string" &&
    credential.provider.trim().length > 0 &&
    typeof credential.apiKey === "string" &&
    credential.apiKey.trim().length > 0 &&
    !/\s/u.test(credential.apiKey) &&
    typeof credential.savedAt === "string" &&
    credential.savedAt.trim().length > 0
  );
}

function isRemoteBearerCredential(
  value: unknown,
): value is RemoteBearerCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const credential = value as Partial<RemoteBearerCredential>;
  return (
    typeof credential.bearerToken === "string" &&
    credential.bearerToken.trim().length > 0 &&
    typeof credential.createdAt === "string" &&
    credential.createdAt.trim().length > 0
  );
}

function sameCredential(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
