import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import type {
  HomeContext,
  HomeEnvironment,
} from '../../config/home.js'
import type { SecureStorageMigrationIdentity } from './index.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  formatRetiredSecureStorageServiceName,
  getSecureStorageServiceName,
  getUsername,
} from './macOsKeychainHelpers.js'
import { fileSuffixForOauthConfig } from '../../constants/oauth.js'

function oldRuntimeHomePath(
  env: HomeEnvironment,
  platformHome: string,
): string {
  return (
    env.AGENC_CONFIG_DIR ||
    env.AGENC_HOME ||
    join(platformHome, '.agenc')
  ).normalize('NFC')
}

/**
 * Reconstruct the exact pre-cutover namespace identity. The retired runtime
 * hashed only an explicitly set AGENC_CONFIG_DIR; AGENC_HOME changed the file
 * location but, incorrectly, did not change the service name.
 */
export function getRetiredSecureStorageIdentity(
  env: HomeEnvironment,
  platformHome: string,
  accountNameOverride?: string,
): SecureStorageMigrationIdentity {
  const homePath = oldRuntimeHomePath(env, platformHome)
  return Object.freeze({
    serviceName: formatRetiredSecureStorageServiceName(
      CREDENTIALS_SERVICE_SUFFIX,
      env.AGENC_CONFIG_DIR ? homePath : undefined,
      fileSuffixForOauthConfig(env),
    ),
    accountName: accountNameOverride ?? getUsername(env),
    homePath,
  })
}

export function getCanonicalSecureStorageIdentity(
  home: HomeContext,
): SecureStorageMigrationIdentity {
  return Object.freeze({
    serviceName: getSecureStorageServiceName(
      home,
      CREDENTIALS_SERVICE_SUFFIX,
    ),
    accountName: home.secureStorageAccount,
    homePath: home.path,
  })
}

/** Platform-aware identity comparison: only DPAPI stores bytes under home. */
export function secureStorageIdentitiesDiffer(
  canonical: SecureStorageMigrationIdentity,
  retired: SecureStorageMigrationIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') {
    return canonical.serviceName !== retired.serviceName ||
      canonical.accountName !== retired.accountName
  }
  return windowsSecureStorageTargetIdentity(canonical) !==
      windowsSecureStorageTargetIdentity(retired) ||
    canonical.accountName !== retired.accountName
}

export function windowsSecureStorageTargetIdentity(
  identity: SecureStorageMigrationIdentity,
): string {
  const safeServiceName = identity.serviceName.replace(
    /[^a-zA-Z0-9._-]/g,
    '_',
  )
  const target = join(identity.homePath, `${safeServiceName}.secure.dpapi`)
  let physicalTarget: string
  if (existsSync(target)) {
    physicalTarget = realpathSync(target)
  } else {
    const parent = dirname(target)
    physicalTarget = join(
      existsSync(parent) ? realpathSync(parent) : resolve(parent),
      basename(target),
    )
  }
  // Windows path identity is case-insensitive even when this comparison is
  // exercised by a cross-platform migration test.
  return physicalTarget.normalize('NFC').toLocaleLowerCase('en-US')
}
