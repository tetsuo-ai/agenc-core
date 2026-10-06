import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { DOWNLOAD_IDLE_MS } from "../../src/audio/whisper.js";

describe("Whisper download idle-clock docs", () => {
  it("pins the 60 s silence bound and stall failure", async () => {
    expect(DOWNLOAD_IDLE_MS).toBe(60_000);

    const whisper = await readFile("../docs/whisper-local.md", "utf8");

    expect(whisper).toContain("## Download idle clock");
    expect(whisper).toContain("**60 seconds**");
    expect(whisper).toContain("`DOWNLOAD_IDLE_MS`");
    expect(whisper).toContain("Every received chunk");
    expect(whisper).toContain("WHISPER_DOWNLOAD_FAILED");
    expect(whisper).toContain(
      "The Whisper model download stopped receiving data. Check your connection and try again.",
    );
    expect(whisper).toContain("not `REQUEST_CANCELLED`");
    expect(whisper).toContain("not a ten-minute wall clock");
    expect(whisper).toContain("no environment or `config.toml` override");
    expect(whisper).toContain("90 second execution deadline");
    expect(whisper).not.toMatch(/Download deadline is ten minutes/);
  });

  it("points INDEX, architecture, env, and daemon notes at the same contract", async () => {
    const [index, architecture, env, daemon] = await Promise.all([
      readFile("../docs/INDEX.md", "utf8"),
      readFile("../docs/ARCHITECTURE.md", "utf8"),
      readFile("../docs/reference/env.md", "utf8"),
      readFile("../docs/reference/daemon.md", "utf8"),
    ]);

    expect(index).toContain("whisper-local.md#download-idle-clock");
    expect(architecture).toContain("whisper-local.md#download-idle-clock");
    expect(architecture).toContain("`audio/`");
    expect(env).toContain("whisper-local.md#download-idle-clock");
    expect(env).toContain("AGENC_WHISPER_CLI");
    expect(env).toContain("host daemon startup only");
    expect(daemon).toContain("whisper-local.md#download-idle-clock");
    expect(daemon).toContain("audio.whisper.install");
    expect(daemon).toContain("JSON-RPC `-32601`");
  });
});
