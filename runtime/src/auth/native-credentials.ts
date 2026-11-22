import { updateNativeSecureStorage, readNativeSecureStorage } from "../utils/secureStorage/native.js";
import type {
  LocalAuthSecureStorage,
} from "../utils/secureStorage/index.js";
import type { HomeContext } from "../config/home.js";

export type LocalByokCredential = NonNullable<
  LocalAuthSecureStorage["byokKeys"]
>[string];

const LOCAL_AUTH_STORAGE_UNAVAILABLE =
  "Native secure storage is required for saved provider keys";

export function readLocalByokCredential(
  home: HomeContext,
  provider: string,
): LocalByokCredential | undefined {
  const credential = readNativeSecureStorage(home).localAuth?.byokKeys?.[provider];
  return isLocalByokCredential(credential)
    ? structuredClone(credential)
    : undefined;
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

/** Remove a saved provider key. Returns whether one was stored. */
export function clearLocalByokCredential(
  home: HomeContext,
  provider: string,
): boolean {
  let removed = false;
  updateNativeSecureStorage(
    home,
    (current) => {
      const localAuth = localAuthState(current.localAuth);
      const byokKeys = localAuth.byokKeys;
      if (byokKeys === undefined || !(provider in byokKeys)) return current;
      const { [provider]: _removed, ...remaining } = byokKeys;
      removed = true;
      return {
        ...current,
        localAuth: { ...localAuth, byokKeys: remaining },
      };
    },
    LOCAL_AUTH_STORAGE_UNAVAILABLE,
  );
  return removed;
}

function localAuthState(
  value: Readonly<LocalAuthSecureStorage> | undefined,
): LocalAuthSecureStorage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return structuredClone(value);
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
