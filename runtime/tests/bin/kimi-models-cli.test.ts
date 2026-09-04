import { describe, expect, test, vi } from "vitest";

import {
  formatKimiModelsCliHelpText,
  KIMI_MODELS_REQUEST_TIMEOUT_MS,
  parseKimiModelsCliArgs,
  runKimiModelsCli,
  type KimiModelsCliIo,
} from "../../src/bin/kimi-models-cli.js";
import { KIMI_CHAT_MODELS } from "../../src/llm/providers/kimi/index.js";
import { BUILT_IN_PROVIDER_BASE_URLS } from "../../src/llm/registry/provider-info.js";
import {
  captureHeadlessModelsCliIo,
  lastHeadlessJson,
} from "./headless-models-cli-test-helpers.js";

function captureIo(fetchImpl: KimiModelsCliIo["fetchImpl"]) {
  return captureHeadlessModelsCliIo<KimiModelsCliIo>(fetchImpl);
}

describe("headless Kimi model discovery CLI", () => {
  test("parses only the command, --json, and help", () => {
    expect(parseKimiModelsCliArgs(["kimi-models", "--json"])).toEqual({
      kind: "list",
      json: true,
    });
    expect(parseKimiModelsCliArgs(["kimi-models"])).toEqual({
      kind: "list",
      json: false,
    });
    expect(parseKimiModelsCliArgs(["kimi-models", "--help"])).toEqual({
      kind: "help",
    });
    expect(
      parseKimiModelsCliArgs(["kimi-models", "--api-key", "secret"]),
    ).toEqual({
      kind: "error",
      message: "kimi-models accepts only --json or --help",
    });
    expect(
      parseKimiModelsCliArgs([
        "kimi-models",
        "--base-url",
        "https://example.test",
      ]),
    ).toEqual({
      kind: "error",
      message: "kimi-models accepts only --json or --help",
    });
    expect(parseKimiModelsCliArgs(["providers"])).toBeNull();
  });

  test("queries the fixed global endpoint with bearer auth and a bounded timeout", async () => {
    expect(KIMI_MODELS_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    const fetchImpl = vi.fn(
      async (
        url: string,
        init?: {
          headers?: Record<string, string>;
          redirect?: RequestRedirect;
          signal?: AbortSignal;
        },
      ) => {
        expect(url).toBe(`${BUILT_IN_PROVIDER_BASE_URLS.kimi}/models`);
        expect(init?.headers).toEqual({ Authorization: "Bearer moonshot-test" });
        expect(init?.redirect).toBe("error");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "kimi-k3" }] }),
        };
      },
    );
    const { io, stdout } = captureIo(fetchImpl);

    const code = await runKimiModelsCli(
      { kind: "list", json: true },
      { environment: Object.freeze({ MOONSHOT_API_KEY: " moonshot-test " }) },
      io,
    );

    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lastHeadlessJson(stdout())).toEqual({
      ok: true,
      models: ["kimi-k3"],
    });
  });

  test("returns the exact native allowlist intersection in canonical order", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "kimi-k2.6" },
          { id: "kimi-k2.7-code-highspeed" },
          { id: "kimi-k3" },
          { id: "kimi-k3" },
          { id: " KIMI-K3 " },
          { id: "not-supported" },
          { id: KIMI_CHAT_MODELS[1] },
        ],
      }),
    }));
    const { io, stdout } = captureIo(fetchImpl);

    const code = await runKimiModelsCli(
      { kind: "list", json: true },
      { environment: Object.freeze({ MOONSHOT_API_KEY: "moonshot-test" }) },
      io,
    );

    expect(code).toBe(0);
    expect(lastHeadlessJson(stdout())).toEqual({
      ok: true,
      models: [
        "kimi-k3",
        "kimi-k2.7-code",
        "kimi-k2.7-code-highspeed",
        "kimi-k2.6",
      ],
    });
  });

  test("treats a valid empty data array as a successful empty result", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    }));
    const { io, stdout } = captureIo(fetchImpl);

    const code = await runKimiModelsCli(
      { kind: "list", json: true },
      { environment: Object.freeze({ MOONSHOT_API_KEY: "moonshot-test" }) },
      io,
    );

    expect(code).toBe(0);
    expect(lastHeadlessJson(stdout())).toEqual({ ok: true, models: [] });
  });

  test.each([
    undefined,
    null,
    {},
    { data: "not-an-array" },
    { data: [{}] },
    { data: [{ id: 42 }] },
  ])("rejects malformed model payload %#", async (payload) => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
    }));
    const { io, stdout } = captureIo(fetchImpl);

    const code = await runKimiModelsCli(
      { kind: "list", json: true },
      { environment: Object.freeze({ MOONSHOT_API_KEY: "moonshot-test" }) },
      io,
    );

    expect(code).toBe(1);
    expect(lastHeadlessJson(stdout())).toEqual({
      ok: false,
      error: "Kimi returned a malformed models response.",
    });
  });

  test("reports non-2xx responses without parsing or leaking the key", async () => {
    const secret = "moonshot-super-secret";
    const json = vi.fn(async () => ({ error: secret }));
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json }));
    const { io, stdout } = captureIo(fetchImpl);

    const code = await runKimiModelsCli(
      { kind: "list", json: true },
      { environment: Object.freeze({ MOONSHOT_API_KEY: secret }) },
      io,
    );

    expect(code).toBe(1);
    expect(json).not.toHaveBeenCalled();
    expect(lastHeadlessJson(stdout())).toEqual({
      ok: false,
      error: "Kimi refused the models request (HTTP 401).",
    });
    expect(stdout()).not.toContain(secret);
  });

  test.each([undefined, "", "   "])(
    "fails before fetch when MOONSHOT_API_KEY is missing",
    async (apiKey) => {
      const fetchImpl = vi.fn();
      const { io, stdout } = captureIo(fetchImpl);

      const code = await runKimiModelsCli(
        { kind: "list", json: true },
        {
          environment: Object.freeze({
            ...(apiKey === undefined ? {} : { MOONSHOT_API_KEY: apiKey }),
          }),
        },
        io,
      );

      expect(code).toBe(1);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(lastHeadlessJson(stdout())).toEqual({
        ok: false,
        error: "Add a Kimi API key before refreshing models.",
      });
    },
  );

  test("redacts the credential from network and JSON parser failures", async () => {
    const secret = "moonshot-super-secret";
    const failures = [
      vi.fn(async () => {
        throw new Error(`Bearer ${secret} could not connect`);
      }),
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error(`invalid response for ${secret}`);
        },
      })),
    ];

    for (const fetchImpl of failures) {
      const { io, stdout } = captureIo(fetchImpl);
      const code = await runKimiModelsCli(
        { kind: "list", json: true },
        { environment: Object.freeze({ MOONSHOT_API_KEY: secret }) },
        io,
      );
      expect(code).toBe(1);
      expect(lastHeadlessJson(stdout()).ok).toBe(false);
      expect(stdout()).not.toContain(secret);
      expect(stdout()).toContain("[redacted]");
    }
  });

  test("help documents the fixed credential contract without secret flags", () => {
    const text = formatKimiModelsCliHelpText();
    expect(text).toContain("kimi-models");
    expect(text).toContain("MOONSHOT_API_KEY");
    expect(text).not.toContain("--api-key");
    expect(text).not.toContain("--base-url");
  });
});
