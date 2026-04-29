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
});
