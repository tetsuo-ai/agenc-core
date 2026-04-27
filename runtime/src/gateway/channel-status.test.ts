import { describe, expect, it } from "vitest";

import { buildGatewayChannelStatus } from "./channel-status.js";

describe("buildGatewayChannelStatus", () => {
  it("derives telegram polling mode and healthy summary from target config", () => {
    const status = buildGatewayChannelStatus("telegram", {
      targetConfig: {
        enabled: true,
        botToken: "test-token",
      },
      active: true,
      health: "healthy",
      pendingRestart: false,
    });

    expect(status.mode).toBe("polling");
    expect(status.abi).toEqual({
      plugin_api_version: "1.0.0",
      host_api_version: "1.0.0",
    });
    expect(status.summary).toBe("Connector is active and healthy.");
  });

  it("reports pending restart when a live connector still exists after removal", () => {
    const status = buildGatewayChannelStatus("telegram", {
      targetConfig: undefined,
      active: true,
      health: "healthy",
      pendingRestart: true,
      gatewayRunning: true,
    });

    expect(status.configured).toBe(false);
    expect(status.summary).toBe(
      "Live daemon still has this connector active; restart required to remove it.",
    );
  });

  it("reports live daemon config drift when gateway config lags behind disk", () => {
    const status = buildGatewayChannelStatus("telegram", {
      targetConfig: {
        enabled: true,
        botToken: "new-token",
      },
      liveConfig: {
        enabled: true,
        botToken: "old-token",
      },
      active: false,
      health: "unknown",
      pendingRestart: false,
      gatewayRunning: true,
    });

    expect(status.summary).toBe("Connector config differs from the live daemon state.");
  });

  it("keeps abi attached for a hosted plugin still live after disk removal (pending restart)", () => {
    // Regression: a non-telegram hosted plugin connector that was removed from
    // disk but is still active in the live daemon must keep its ABI on the
    // channel-status surface — the read of `targetConfig` alone would drop it
    // and inconsistently hide ABI from a connector that is still running.
    const status = buildGatewayChannelStatus("custom-plugin", {
      targetConfig: undefined,
      liveConfig: {
        type: "plugin",
        enabled: true,
      },
      active: true,
      health: "healthy",
      pendingRestart: true,
      gatewayRunning: true,
    });

    expect(status.configured).toBe(false);
    expect(status.active).toBe(true);
    expect(status.pendingRestart).toBe(true);
    expect(status.abi).toEqual({
      plugin_api_version: "1.0.0",
      host_api_version: "1.0.0",
    });
    expect(status.summary).toBe(
      "Live daemon still has this connector active; restart required to remove it.",
    );
  });
});
