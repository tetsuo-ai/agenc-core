import { describe, expect, it, vi } from "vitest";

import { createHeadlessEmitters } from "../../src/bin/headless-cli-io.js";

function io() {
  return {
    stdout: { write: vi.fn(() => true) },
    stderr: { write: vi.fn(() => true) },
  };
}

describe("createHeadlessEmitters", () => {
  it("writes one JSON record per emit in --json mode", () => {
    const streams = io();
    const emitters = createHeadlessEmitters(true, streams, "grok-login");

    emitters.emit({ ok: true, stage: "authorize" }, "Opening browser…");

    expect(streams.stdout.write).toHaveBeenCalledWith(
      `${JSON.stringify({ ok: true, stage: "authorize" })}\n`,
    );
    expect(streams.stderr.write).not.toHaveBeenCalled();
  });

  it("writes the plain line and leaves JSON off stdout when not in --json mode", () => {
    const streams = io();
    const emitters = createHeadlessEmitters(false, streams, "grok-login");

    emitters.emit({ ok: true }, "Opening browser…");

    expect(streams.stdout.write).toHaveBeenCalledWith("Opening browser…\n");
    expect(streams.stderr.write).not.toHaveBeenCalled();
  });

  it("emits a structured failure on stdout in --json mode and returns 1", () => {
    const streams = io();
    const emitters = createHeadlessEmitters(true, streams, "grok-login");

    expect(emitters.fail("cancelled", "user_cancelled")).toBe(1);
    expect(streams.stdout.write).toHaveBeenCalledWith(
      `${JSON.stringify({ ok: false, error: "cancelled", code: "user_cancelled" })}\n`,
    );
    expect(streams.stderr.write).not.toHaveBeenCalled();
  });

  it("omits code from the JSON failure when none is supplied", () => {
    const streams = io();
    const emitters = createHeadlessEmitters(true, streams, "grok-login");

    expect(emitters.fail("missing token")).toBe(1);
    expect(streams.stdout.write).toHaveBeenCalledWith(
      `${JSON.stringify({ ok: false, error: "missing token" })}\n`,
    );
  });

  it("writes a prefixed failure to stderr in plain mode and returns 1", () => {
    const streams = io();
    const emitters = createHeadlessEmitters(false, streams, "grok-login");

    expect(emitters.fail("cancelled", "user_cancelled")).toBe(1);
    expect(streams.stderr.write).toHaveBeenCalledWith("grok-login: cancelled\n");
    expect(streams.stdout.write).not.toHaveBeenCalled();
  });
});
