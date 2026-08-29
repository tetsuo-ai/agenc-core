import type {
  RemoteRuntimeAuthSecureStorage,
  SecureStorageData,
} from "./index.js";
import {
  readNativeSecureStorage,
  updateNativeSecureStorage,
} from "./native.js";
import type { HomeContext } from "../../config/home.js";

export type RemoteRuntimeCredentialName =
  keyof RemoteRuntimeAuthSecureStorage;

const REMOTE_RUNTIME_STORAGE_UNAVAILABLE =
  "Native secure storage is required for remote runtime credentials";

export function readRemoteRuntimeCredential(
  home: HomeContext,
  name: RemoteRuntimeCredentialName,
): string | null {
  const value = readNativeSecureStorage(home).remoteRuntimeAuth?.[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function storeRemoteRuntimeCredential(
  home: HomeContext,
  name: RemoteRuntimeCredentialName,
  credential: string,
): void {
  const normalized = credential.trim();
  if (normalized.length === 0) {
    throw new Error(`Remote runtime ${name} credential must not be empty`);
  }
  updateNativeSecureStorage(
    home,
    (current) => withRemoteRuntimeCredential(current, name, normalized),
    REMOTE_RUNTIME_STORAGE_UNAVAILABLE,
  );
}

function withRemoteRuntimeCredential(
  current: Readonly<SecureStorageData>,
  name: RemoteRuntimeCredentialName,
  credential: string,
): SecureStorageData {
  return {
    ...current,
    remoteRuntimeAuth: {
      ...current.remoteRuntimeAuth,
      [name]: credential,
    },
  };
}
