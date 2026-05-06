import { describe, expect, it } from "vitest";
import {
  AGENC_DAEMON_METHODS,
  AGENC_DAEMON_NOTIFICATION_METHODS,
  AGENC_DAEMON_PROTOCOL_PACKAGE_NAME,
  AGENC_DAEMON_PROTOCOL_VERSION,
} from "../app-server/protocol/index.js";
import {
  AGENC_IDE_EXTENSION_CAPABILITY_NAMESPACE,
  AGENC_IDE_EXTENSION_LSP_CAPABILITY,
  AGENC_IDE_EXTENSION_PACKAGE_NAME,
  AGENC_IDE_EXTENSION_REPOSITORY_NAME,
  AGENC_IDE_EXTENSION_SCAFFOLD,
  AGENC_IDE_EXTENSION_TARGET,
  AGENC_IDE_REQUIRED_METHODS,
  AGENC_IDE_REQUIRED_NOTIFICATIONS,
  checkAgenCIdeProtocolSurface,
  createAgenCIdeInitializeParams,
  isAgenCIdeRequiredMethod,
  isAgenCIdeRequiredNotification,
} from "./ide-extension.js";

describe("AgenC IDE extension scaffold protocol", () => {
  it("pins the first extension repo to the VS Code target", () => {
    expect(AGENC_IDE_EXTENSION_REPOSITORY_NAME).toBe("agenc-vscode");
    expect(AGENC_IDE_EXTENSION_PACKAGE_NAME).toBe("agenc-vscode");
    expect(AGENC_IDE_EXTENSION_TARGET).toBe("vscode");

    expect(AGENC_IDE_EXTENSION_SCAFFOLD).toEqual({
      repositoryName: AGENC_IDE_EXTENSION_REPOSITORY_NAME,
      packageName: AGENC_IDE_EXTENSION_PACKAGE_NAME,
      extensionTarget: AGENC_IDE_EXTENSION_TARGET,
      protocolPackageName: AGENC_DAEMON_PROTOCOL_PACKAGE_NAME,
      protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
      requiredMethods: AGENC_IDE_REQUIRED_METHODS,
      requiredNotifications: AGENC_IDE_REQUIRED_NOTIFICATIONS,
      capabilityNamespace: AGENC_IDE_EXTENSION_CAPABILITY_NAMESPACE,
      lspCapability: AGENC_IDE_EXTENSION_LSP_CAPABILITY,
    });
  });

  it("keeps the IDE bootstrap contract on the daemon method list", () => {
    expect(checkAgenCIdeProtocolSurface()).toEqual({
      missingMethods: [],
      missingNotifications: [],
    });

    for (const method of AGENC_IDE_REQUIRED_METHODS) {
      expect(AGENC_DAEMON_METHODS).toContain(method);
      expect(isAgenCIdeRequiredMethod(method)).toBe(true);
    }
    for (const method of AGENC_IDE_REQUIRED_NOTIFICATIONS) {
      expect(AGENC_DAEMON_NOTIFICATION_METHODS).toContain(method);
      expect(isAgenCIdeRequiredNotification(method)).toBe(true);
    }

    expect(isAgenCIdeRequiredMethod("message.send")).toBe(false);
    expect(isAgenCIdeRequiredNotification("event.message_chunk")).toBe(false);
  });

  it("builds initialize params that advertise IDE and LSP capability", () => {
    expect(
      createAgenCIdeInitializeParams({
        authCookie: "cookie-1",
        extraCapabilities: { diagnostics: true },
      }),
    ).toEqual({
      protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
      clientName: AGENC_IDE_EXTENSION_REPOSITORY_NAME,
      authCookie: "cookie-1",
      capabilities: {
        diagnostics: true,
        ide: {
          target: "vscode",
          lsp: true,
          protocolPackage: AGENC_DAEMON_PROTOCOL_PACKAGE_NAME,
          requiredMethods: [...AGENC_IDE_REQUIRED_METHODS],
          requiredNotifications: [...AGENC_IDE_REQUIRED_NOTIFICATIONS],
        },
      },
    });
  });
});
