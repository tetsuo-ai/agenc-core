import { checkInstall as checkInstallImpl, cleanupNpmInstallations as cleanupNpmInstallationsImpl, cleanupOldVersions as cleanupOldVersionsImpl, cleanupShellAliases as cleanupShellAliasesImpl, installLatest as installLatestImpl, lockCurrentVersion as lockCurrentVersionImpl, removeInstalledSymlink as removeInstalledSymlinkImpl, type SetupMessage as InstallerSetupMessage } from './installer.js'

export type SetupMessage = InstallerSetupMessage
export function checkInstall(...args: Parameters<typeof checkInstallImpl>): ReturnType<typeof checkInstallImpl> { return checkInstallImpl(...args) }
export function cleanupNpmInstallations(...args: Parameters<typeof cleanupNpmInstallationsImpl>): ReturnType<typeof cleanupNpmInstallationsImpl> { return cleanupNpmInstallationsImpl(...args) }
export function cleanupOldVersions(...args: Parameters<typeof cleanupOldVersionsImpl>): ReturnType<typeof cleanupOldVersionsImpl> { return cleanupOldVersionsImpl(...args) }
export function cleanupShellAliases(...args: Parameters<typeof cleanupShellAliasesImpl>): ReturnType<typeof cleanupShellAliasesImpl> { return cleanupShellAliasesImpl(...args) }
export function installLatest(...args: Parameters<typeof installLatestImpl>): ReturnType<typeof installLatestImpl> { return installLatestImpl(...args) }
export function lockCurrentVersion(...args: Parameters<typeof lockCurrentVersionImpl>): ReturnType<typeof lockCurrentVersionImpl> { return lockCurrentVersionImpl(...args) }
export function removeInstalledSymlink(...args: Parameters<typeof removeInstalledSymlinkImpl>): ReturnType<typeof removeInstalledSymlinkImpl> { return removeInstalledSymlinkImpl(...args) }
