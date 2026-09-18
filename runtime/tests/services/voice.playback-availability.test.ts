import { describe, expect, test } from "vitest";

import {
  checkPlaybackAvailability,
  checkRealtimeAudioAvailability,
  resolveRealtimePlaybackBackend,
} from "../../src/services/voice.js";

describe("realtime playback capability detection", () => {
  test("rejects a working microphone when no playback command exists", async () => {
    const hasCommand = (command: string): boolean => command === "arecord";

    expect(
      resolveRealtimePlaybackBackend({
        hasCommand,
        platform: "linux",
      }),
    ).toBeNull();

    await expect(
      checkPlaybackAvailability({
        hasCommand,
        platform: "linux",
        isRemote: false,
      }),
    ).resolves.toMatchObject({
      available: false,
      reason: expect.stringMatching(/play|aplay/i),
    });
  });

  test.each([
    ["darwin", "play", "play"],
    ["linux", "play", "play"],
    ["linux", "aplay", "aplay"],
    ["win32", "play", "play"],
  ] as const)(
    "accepts %s when `%s` is on PATH",
    async (platform, present, backend) => {
      const hasCommand = (command: string): boolean => command === present;

      expect(resolveRealtimePlaybackBackend({ hasCommand, platform })).toBe(
        backend,
      );
      await expect(
        checkPlaybackAvailability({
          hasCommand,
          platform,
          isRemote: false,
        }),
      ).resolves.toEqual({ available: true, reason: null });
    },
  );

  test("does not treat Windows native capture as a playback backend", async () => {
    await expect(
      checkPlaybackAvailability({
        hasCommand: () => false,
        platform: "win32",
        isRemote: false,
      }),
    ).resolves.toMatchObject({
      available: false,
      reason: expect.stringMatching(/native audio module can record but cannot play/i),
    });
  });

  test("does not treat macOS native capture as a playback backend", async () => {
    await expect(
      checkPlaybackAvailability({
        hasCommand: () => false,
        platform: "darwin",
        isRemote: false,
      }),
    ).resolves.toMatchObject({
      available: false,
      reason: expect.stringMatching(/brew install sox/i),
    });
  });

  test("does not accept aplay as a Windows or macOS playback backend", () => {
    const onlyAplay = (command: string): boolean => command === "aplay";

    expect(
      resolveRealtimePlaybackBackend({
        hasCommand: onlyAplay,
        platform: "win32",
      }),
    ).toBeNull();
    expect(
      resolveRealtimePlaybackBackend({
        hasCommand: onlyAplay,
        platform: "darwin",
      }),
    ).toBeNull();
  });

  test("rejects remote environments even when playback commands exist", async () => {
    await expect(
      checkPlaybackAvailability({
        hasCommand: () => true,
        platform: "linux",
        isRemote: true,
      }),
    ).resolves.toMatchObject({
      available: false,
      reason: expect.stringMatching(/run AgenC locally/i),
    });
  });

  test("combined realtime readiness keeps a recording-only success from passing", async () => {
    await expect(
      checkRealtimeAudioAvailability({
        checkRecordingAvailability: async () => ({
          available: true,
          reason: null,
        }),
        hasCommand: () => false,
        platform: "linux",
        isRemote: false,
      }),
    ).resolves.toMatchObject({
      available: false,
      reason: expect.stringMatching(/play|aplay/i),
    });
  });

  test("combined realtime readiness reports the recording failure first", async () => {
    await expect(
      checkRealtimeAudioAvailability({
        checkRecordingAvailability: async () => ({
          available: false,
          reason: "microphone denied",
        }),
        hasCommand: () => true,
        platform: "linux",
        isRemote: false,
      }),
    ).resolves.toEqual({
      available: false,
      reason: "microphone denied",
    });
  });
});
