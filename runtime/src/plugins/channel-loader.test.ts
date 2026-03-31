import { describe, expect, it } from "vitest";
import {
  loadConfiguredPluginChannel,
} from "./channel-loader.js";

describe("loadConfiguredPluginChannel", () => {
  const trustedPackages = [
    {
      packageName: "@tetsuo-ai/plugin-kit-channel-fixture",
      allowedSubpaths: ["mock"],
    },
  ] as const;

  it("loads a trusted channel adapter package", async () => {
    const loaded = await loadConfiguredPluginChannel({
      channelName: "fixture-chat",
      channelConfig: {
        type: "plugin",
        moduleSpecifier: "@tetsuo-ai/plugin-kit-channel-fixture/mock",
        config: {
          token: "abc",
        },
      },
      trustedPackages,
    });

    expect(loaded.manifest.plugin_id).toBe("fixtures/mock");
    expect(loaded.manifest.channel_name).toBe("fixture-chat");
    expect(loaded.channel.name).toBe("fixture-chat");
  });

  it("rejects channel names that shadow built-in runtime channels", async () => {
    await expect(
      loadConfiguredPluginChannel({
        channelName: "discord",
        channelConfig: {
          type: "plugin",
          moduleSpecifier: "@tetsuo-ai/plugin-kit-channel-fixture/mock",
          config: {
            token: "abc",
          },
        },
        trustedPackages,
      }),
    ).rejects.toThrow(
      'Gateway config validation failed: channels.discord — channel name "discord" is reserved for built-in runtime channels',
    );
  });

  it("rejects subpath imports that are not explicitly trusted", async () => {
    await expect(
      loadConfiguredPluginChannel({
        channelName: "fixture-chat",
        channelConfig: {
          type: "plugin",
          moduleSpecifier: "@tetsuo-ai/plugin-kit-channel-fixture/mock",
          config: {
            token: "abc",
          },
        },
        trustedPackages: [
          {
            packageName: "@tetsuo-ai/plugin-kit-channel-fixture",
          },
        ],
      }),
    ).rejects.toThrow(
      'Gateway config validation failed: channels.fixture-chat.moduleSpecifier — trusted package "@tetsuo-ai/plugin-kit-channel-fixture" does not allow subpath "mock"',
    );
  });

  it("rejects manifest and config key mismatches", async () => {
    await expect(
      loadConfiguredPluginChannel({
        channelName: "custom",
        channelConfig: {
          type: "plugin",
          moduleSpecifier: "@tetsuo-ai/plugin-kit-channel-fixture/mock",
          config: {
            token: "abc",
          },
        },
        trustedPackages,
      }),
    ).rejects.toThrow(
      'Gateway config validation failed: channels.custom.moduleSpecifier — plugin manifest.channel_name "fixture-chat" must match the config key "custom"',
    );
  });

  it("surfaces adapter config validation as a gateway config error", async () => {
    await expect(
      loadConfiguredPluginChannel({
        channelName: "fixture-chat",
        channelConfig: {
          type: "plugin",
          moduleSpecifier: "@tetsuo-ai/plugin-kit-channel-fixture/mock",
          config: {},
        },
        trustedPackages,
      }),
    ).rejects.toThrow(
      "Gateway config validation failed: channels.fixture-chat.config — config.token must be a non-empty string",
    );
  });
});
