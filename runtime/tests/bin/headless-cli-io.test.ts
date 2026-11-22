import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: mocks.spawn,
}));

import { createHeadlessEmitters, openUrlDetached } from "../../src/bin/headless-cli-io.js";

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

describe("openUrlDetached", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.spawn.mockReset().mockReturnValue(child);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
  });

  it("opens a sign-in link on Windows with rundll32 and the whole URL as one argument", () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const url = "https://auth.example.test/oauth/authorize?client_id=a&redirect_uri=b&state=c";

    openUrlDetached(url);

    expect(mocks.spawn).toHaveBeenCalledWith("rundll32", ["url,OpenURL", url], {
      detached: true,
      stdio: "ignore",
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("leaves a link that is not http(s) to the printed URL", () => {
    openUrlDetached("file:///tmp/authorize.html");

    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
