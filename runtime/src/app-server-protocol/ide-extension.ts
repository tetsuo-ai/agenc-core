import {
  AGENC_DAEMON_METHODS,
  AGENC_DAEMON_NOTIFICATION_METHODS,
  AGENC_DAEMON_PROTOCOL_PACKAGE_NAME,
  AGENC_DAEMON_PROTOCOL_VERSION,
  type AgenCDaemonMethod,
  type AgenCDaemonNotificationMethod,
  type InitializeParams,
  type JsonObject,
} from "../app-server/protocol/index.js";

export const AGENC_IDE_EXTENSION_REPOSITORY_NAME = "agenc-vscode" as const;
export const AGENC_IDE_EXTENSION_PACKAGE_NAME =
  "@tetsuo-ai/agenc-vscode" as const;
export const AGENC_IDE_EXTENSION_TARGET = "vscode" as const;
export const AGENC_IDE_EXTENSION_CAPABILITY_NAMESPACE = "ide" as const;
export const AGENC_IDE_EXTENSION_LSP_CAPABILITY = "lsp" as const;

export const AGENC_IDE_REQUIRED_METHODS = [
  "initialize",
  "health.ping",
  "auth.whoami",
] as const satisfies readonly AgenCDaemonMethod[];

export const AGENC_IDE_REQUIRED_NOTIFICATIONS = [
  "event.session_event",
] as const satisfies readonly AgenCDaemonNotificationMethod[];

export type AgenCIdeRequiredMethod =
  (typeof AGENC_IDE_REQUIRED_METHODS)[number];
export type AgenCIdeRequiredNotification =
  (typeof AGENC_IDE_REQUIRED_NOTIFICATIONS)[number];

export interface AgenCIdeExtensionScaffold {
  readonly repositoryName: typeof AGENC_IDE_EXTENSION_REPOSITORY_NAME;
  readonly packageName: typeof AGENC_IDE_EXTENSION_PACKAGE_NAME;
  readonly extensionTarget: typeof AGENC_IDE_EXTENSION_TARGET;
  readonly protocolPackageName: typeof AGENC_DAEMON_PROTOCOL_PACKAGE_NAME;
  readonly protocolVersion: typeof AGENC_DAEMON_PROTOCOL_VERSION;
  readonly requiredMethods: readonly AgenCIdeRequiredMethod[];
  readonly requiredNotifications: readonly AgenCIdeRequiredNotification[];
  readonly capabilityNamespace: typeof AGENC_IDE_EXTENSION_CAPABILITY_NAMESPACE;
  readonly lspCapability: typeof AGENC_IDE_EXTENSION_LSP_CAPABILITY;
}

export interface AgenCIdeInitializeOptions {
  readonly clientName?: string;
  readonly authCookie?: string;
  readonly extraCapabilities?: JsonObject;
}

export interface AgenCIdeProtocolSurfaceCheck {
  readonly missingMethods: readonly AgenCIdeRequiredMethod[];
  readonly missingNotifications: readonly AgenCIdeRequiredNotification[];
}

export const AGENC_IDE_EXTENSION_SCAFFOLD = {
  repositoryName: AGENC_IDE_EXTENSION_REPOSITORY_NAME,
  packageName: AGENC_IDE_EXTENSION_PACKAGE_NAME,
  extensionTarget: AGENC_IDE_EXTENSION_TARGET,
  protocolPackageName: AGENC_DAEMON_PROTOCOL_PACKAGE_NAME,
  protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
  requiredMethods: AGENC_IDE_REQUIRED_METHODS,
  requiredNotifications: AGENC_IDE_REQUIRED_NOTIFICATIONS,
  capabilityNamespace: AGENC_IDE_EXTENSION_CAPABILITY_NAMESPACE,
  lspCapability: AGENC_IDE_EXTENSION_LSP_CAPABILITY,
} as const satisfies AgenCIdeExtensionScaffold;

export function isAgenCIdeRequiredMethod(
  value: string,
): value is AgenCIdeRequiredMethod {
  return (AGENC_IDE_REQUIRED_METHODS as readonly string[]).includes(value);
}

export function isAgenCIdeRequiredNotification(
  value: string,
): value is AgenCIdeRequiredNotification {
  return (AGENC_IDE_REQUIRED_NOTIFICATIONS as readonly string[]).includes(
    value,
  );
}

export function createAgenCIdeInitializeParams(
  options: AgenCIdeInitializeOptions = {},
): InitializeParams {
  return {
    protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
    clientName: options.clientName ?? AGENC_IDE_EXTENSION_REPOSITORY_NAME,
    ...(options.authCookie !== undefined
      ? { authCookie: options.authCookie }
      : {}),
    capabilities: {
      ...(options.extraCapabilities ?? {}),
      [AGENC_IDE_EXTENSION_CAPABILITY_NAMESPACE]: {
        target: AGENC_IDE_EXTENSION_TARGET,
        [AGENC_IDE_EXTENSION_LSP_CAPABILITY]: true,
        protocolPackage: AGENC_DAEMON_PROTOCOL_PACKAGE_NAME,
        requiredMethods: [...AGENC_IDE_REQUIRED_METHODS],
        requiredNotifications: [...AGENC_IDE_REQUIRED_NOTIFICATIONS],
      },
    },
  };
}

export function checkAgenCIdeProtocolSurface(): AgenCIdeProtocolSurfaceCheck {
  const daemonMethods = new Set<string>(AGENC_DAEMON_METHODS);
  const daemonNotifications = new Set<string>(AGENC_DAEMON_NOTIFICATION_METHODS);
  return {
    missingMethods: AGENC_IDE_REQUIRED_METHODS.filter(
      (method) => !daemonMethods.has(method),
    ),
    missingNotifications: AGENC_IDE_REQUIRED_NOTIFICATIONS.filter(
      (method) => !daemonNotifications.has(method),
    ),
  };
}
