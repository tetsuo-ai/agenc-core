import type { LookupAddress, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";

import type { Dispatcher } from "undici";
import { describe, expect, test, vi } from "vitest";

import {
  createQwenDnsLookup,
  createQwenOfficialDnsTransport,
  isQwenDnsFallbackError,
  type QwenDnsTransportDependencies,
} from "../../../../src/llm/providers/qwen/dns-transport.js";

const OFFICIAL_HOST = "dashscope-intl.aliyuncs.com";

type LookupResult = {
  readonly error: NodeJS.ErrnoException | null;
  readonly address: string | LookupAddress[];
  readonly family?: number;
};

function callLookup(
  lookup: LookupFunction,
  hostname: string,
  options: LookupOptions,
): Promise<LookupResult> {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address, family) => {
      resolve({ error, address, family });
    });
  });
}

function resolver(
  addresses: readonly string[] | NodeJS.ErrnoException,
): QwenDnsTransportDependencies["resolve4"] {
  return vi.fn((_hostname, callback) => {
    queueMicrotask(() => {
      if (addresses instanceof Error) {
        callback(addresses, []);
      } else {
        callback(null, addresses);
      }
    });
  });
}

function lookupDependencies(args?: {
  readonly ipv4?: readonly string[] | NodeJS.ErrnoException;
  readonly ipv6?: readonly string[] | NodeJS.ErrnoException;
  readonly fallbackLookup?: QwenDnsTransportDependencies["fallbackLookup"];
}): Pick<
  QwenDnsTransportDependencies,
  "resolve4" | "resolve6" | "fallbackLookup"
> {
  return {
    resolve4: resolver(args?.ipv4 ?? ["203.0.113.10"]),
    resolve6: resolver(args?.ipv6 ?? ["2001:db8::10"]),
    fallbackLookup:
      args?.fallbackLookup ??
      ((_hostname, _options, callback) =>
        callback(null, "198.51.100.20", 4)),
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("QwenCloud DNS lookup", () => {
  test("returns all A and AAAA answers with Node lookup all semantics", async () => {
    const dependencies = lookupDependencies({
      ipv4: ["203.0.113.10", "203.0.113.11"],
      ipv6: ["2001:db8::10"],
    });
    const lookup = createQwenDnsLookup(OFFICIAL_HOST, dependencies);

    const result = await callLookup(lookup, OFFICIAL_HOST, {
      all: true,
      family: 0,
      order: "ipv6first",
    });

    expect(result).toEqual({
      error: null,
      address: [
        { address: "2001:db8::10", family: 6 },
        { address: "203.0.113.10", family: 4 },
        { address: "203.0.113.11", family: 4 },
      ],
      family: undefined,
    });
    expect(dependencies.resolve4).toHaveBeenCalledOnce();
    expect(dependencies.resolve6).toHaveBeenCalledOnce();
  });

  test.each([
    {
      family: 4 as const,
      expectedAddress: "203.0.113.10",
      expectedFamily: 4,
      resolve4Calls: 1,
      resolve6Calls: 0,
    },
    {
      family: "IPv6" as const,
      expectedAddress: "2001:db8::10",
      expectedFamily: 6,
      resolve4Calls: 0,
      resolve6Calls: 1,
    },
  ])(
    "honors the requested $family family for a scalar lookup",
    async ({
      family,
      expectedAddress,
      expectedFamily,
      resolve4Calls,
      resolve6Calls,
    }) => {
      const dependencies = lookupDependencies();
      const lookup = createQwenDnsLookup(OFFICIAL_HOST, dependencies);

      const result = await callLookup(lookup, OFFICIAL_HOST, { family });

      expect(result).toEqual({
        error: null,
        address: expectedAddress,
        family: expectedFamily,
      });
      expect(dependencies.resolve4).toHaveBeenCalledTimes(resolve4Calls);
      expect(dependencies.resolve6).toHaveBeenCalledTimes(resolve6Calls);
    },
  );

  test("uses the surviving family when the other DNS query fails", async () => {
    const dependencies = lookupDependencies({ ipv4: errno("ETIMEOUT") });
    const lookup = createQwenDnsLookup(OFFICIAL_HOST, dependencies);

    await expect(
      callLookup(lookup, OFFICIAL_HOST, { all: false, family: 0 }),
    ).resolves.toEqual({
      error: null,
      address: "2001:db8::10",
      family: 6,
    });
  });

  test("fails once with a normal errno when no family resolves", async () => {
    const dependencies = lookupDependencies({
      ipv4: errno("ETIMEOUT"),
      ipv6: errno("ENODATA"),
    });
    const lookup = createQwenDnsLookup(OFFICIAL_HOST, dependencies);

    const result = await callLookup(lookup, OFFICIAL_HOST, { all: true });

    expect(result.address).toBe("");
    expect(result.family).toBeUndefined();
    expect(result.error).toMatchObject({
      code: "ETIMEOUT",
      hostname: OFFICIAL_HOST,
    });
    expect(result.error?.message).toBe(
      `DNS resolution failed for ${OFFICIAL_HOST}`,
    );
  });

  test("delegates every non-official hostname to the system lookup seam", async () => {
    const fallback = vi.fn<QwenDnsTransportDependencies["fallbackLookup"]>(
      (_hostname, _options, callback) =>
        callback(null, "198.51.100.42", 4),
    );
    const dependencies = lookupDependencies({ fallbackLookup: fallback });
    const lookup = createQwenDnsLookup(OFFICIAL_HOST, dependencies);

    await expect(
      callLookup(lookup, "redirect.example", { all: false }),
    ).resolves.toEqual({
      error: null,
      address: "198.51.100.42",
      family: 4,
    });
    expect(fallback).toHaveBeenCalledOnce();
    expect(dependencies.resolve4).not.toHaveBeenCalled();
    expect(dependencies.resolve6).not.toHaveBeenCalled();
  });

  test("rejects unsupported families and malformed DNS answers cleanly", async () => {
    const invalidFamilyLookup = createQwenDnsLookup(
      OFFICIAL_HOST,
      lookupDependencies(),
    );
    const invalidFamily = await callLookup(invalidFamilyLookup, OFFICIAL_HOST, {
      family: 5,
    });
    expect(invalidFamily).toMatchObject({
      address: "",
      error: { code: "EINVAL", hostname: OFFICIAL_HOST },
    });

    const malformedLookup = createQwenDnsLookup(
      OFFICIAL_HOST,
      lookupDependencies({ ipv4: ["not-an-ip"] }),
    );
    const malformed = await callLookup(malformedLookup, OFFICIAL_HOST, {
      family: "IPv4",
    });
    expect(malformed).toMatchObject({
      address: "",
      error: { code: "EBADRESP", hostname: OFFICIAL_HOST },
    });
  });
});

describe("QwenCloud DNS transport", () => {
  function transportDependencies(primaryResult?: Response | Error) {
    const close = vi.fn(async () => {});
    const dispatcher = { close } as unknown as Dispatcher;
    const createDispatcher = vi.fn(() => dispatcher);
    const primaryFetch =
      primaryResult instanceof Error
        ? vi.fn<typeof fetch>().mockRejectedValue(primaryResult)
        : vi
            .fn<typeof fetch>()
            .mockResolvedValue(
              primaryResult ?? new Response("primary", { status: 200 }),
            );
    const fetchWithDispatcher = vi.fn(
      async (
        _input: Parameters<typeof fetch>[0],
        _init: Parameters<typeof fetch>[1],
        _dispatcher: Dispatcher,
      ) => new Response("ok", { status: 200 }),
    );
    const dependencies: QwenDnsTransportDependencies = {
      ...lookupDependencies(),
      createDispatcher,
      primaryFetch,
      fetchWithDispatcher,
    };
    return {
      close,
      createDispatcher,
      dependencies,
      dispatcher,
      fetchWithDispatcher,
      primaryFetch,
    };
  }

  test("falls back after a nested connect timeout, keeps SNI host, and closes its Agent", async () => {
    const connectTimeout = Object.assign(new Error("connect timed out"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const harness = transportDependencies(
      new TypeError("fetch failed", { cause: connectTimeout }),
    );
    const transport = createQwenOfficialDnsTransport(
      `https://${OFFICIAL_HOST}/compatible-mode/v1`,
      OFFICIAL_HOST,
      harness.dependencies,
    );
    expect(transport).toBeDefined();
    expect(harness.createDispatcher).not.toHaveBeenCalled();

    const url = `https://${OFFICIAL_HOST}/compatible-mode/v1/chat/completions`;
    await transport?.fetchImpl(url, { method: "POST", body: "{}" });
    await transport?.fetchImpl(url, { method: "POST", body: "{}" });

    expect(harness.createDispatcher).toHaveBeenCalledOnce();
    expect(harness.fetchWithDispatcher).toHaveBeenCalledTimes(2);
    expect(harness.fetchWithDispatcher.mock.calls[0]?.[0]).toBe(url);
    expect(harness.fetchWithDispatcher.mock.calls[0]?.[2]).toBe(
      harness.dispatcher,
    );
    // Once the session proves it needs the fallback, later calls should not
    // incur another system getaddrinfo/connect timeout.
    expect(harness.primaryFetch).toHaveBeenCalledOnce();

    await transport?.dispose();
    await transport?.dispose();
    expect(harness.close).toHaveBeenCalledOnce();
    await expect(transport?.fetchImpl(url)).rejects.toThrow(/disposed/i);
  });

  test("uses the primary fetch without allocating an Agent when it succeeds", async () => {
    const harness = transportDependencies();
    const transport = createQwenOfficialDnsTransport(
      `https://${OFFICIAL_HOST}/compatible-mode/v1`,
      OFFICIAL_HOST,
      harness.dependencies,
    );

    const response = await transport?.fetchImpl(`https://${OFFICIAL_HOST}/v1`);
    expect(await response?.text()).toBe("primary");
    expect(harness.primaryFetch).toHaveBeenCalledOnce();
    expect(harness.createDispatcher).not.toHaveBeenCalled();

    await transport?.dispose();
    expect(harness.close).not.toHaveBeenCalled();
  });

  test.each([
    Object.assign(new Error("certificate rejected"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    }),
    Object.assign(new Error("socket timed out"), { code: "ETIMEDOUT" }),
    new DOMException("cancelled", "AbortError"),
  ])("does not hide a non-DNS transport failure", async (primaryError) => {
    const harness = transportDependencies(primaryError);
    const transport = createQwenOfficialDnsTransport(
      `https://${OFFICIAL_HOST}/compatible-mode/v1`,
      OFFICIAL_HOST,
      harness.dependencies,
    );

    await expect(
      transport?.fetchImpl(`https://${OFFICIAL_HOST}/v1`),
    ).rejects.toBe(primaryError);
    expect(harness.createDispatcher).not.toHaveBeenCalled();
    expect(harness.fetchWithDispatcher).not.toHaveBeenCalled();
  });

  test.each([
    "https://custom.example/compatible-mode/v1",
    `http://${OFFICIAL_HOST}/compatible-mode/v1`,
    `https://${OFFICIAL_HOST}.example/compatible-mode/v1`,
  ])("does not install the fallback for non-official URL %s", (baseURL) => {
    const harness = transportDependencies();
    expect(
      createQwenOfficialDnsTransport(
        baseURL,
        OFFICIAL_HOST,
        harness.dependencies,
      ),
    ).toBeUndefined();
    expect(harness.createDispatcher).not.toHaveBeenCalled();
  });

  test("disposing before first use never creates a dispatcher", async () => {
    const harness = transportDependencies();
    const transport = createQwenOfficialDnsTransport(
      `https://${OFFICIAL_HOST}/compatible-mode/v1`,
      OFFICIAL_HOST,
      harness.dependencies,
    );

    await transport?.dispose();

    expect(harness.createDispatcher).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();
  });

  test("does not allocate a fallback Agent after disposal races a primary failure", async () => {
    let rejectPrimary: ((error: Error) => void) | undefined;
    const harness = transportDependencies();
    const dependencies: QwenDnsTransportDependencies = {
      ...harness.dependencies,
      primaryFetch: vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectPrimary = reject;
          }),
      ),
    };
    const transport = createQwenOfficialDnsTransport(
      `https://${OFFICIAL_HOST}/compatible-mode/v1`,
      OFFICIAL_HOST,
      dependencies,
    );
    const pending = transport?.fetchImpl(`https://${OFFICIAL_HOST}/v1`);

    await transport?.dispose();
    const primaryError = errno("ENOTFOUND");
    rejectPrimary?.(primaryError);

    await expect(pending).rejects.toBe(primaryError);
    expect(harness.createDispatcher).not.toHaveBeenCalled();
    expect(harness.fetchWithDispatcher).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();
  });
});

describe("QwenCloud DNS fallback error classification", () => {
  test.each(["UND_ERR_CONNECT_TIMEOUT", "ENOTFOUND", "EAI_AGAIN", "EAI_SYSTEM"])(
    "accepts %s",
    (code) => {
      expect(
        isQwenDnsFallbackError(Object.assign(new Error(code), { code })),
      ).toBe(true);
    },
  );

  test("accepts a getaddrinfo timeout without a structured code", () => {
    expect(
      isQwenDnsFallbackError(new Error(`getaddrinfo timeout ${OFFICIAL_HOST}`)),
    ).toBe(true);
  });

  test("an abort wins even when its cause looks DNS-related", () => {
    const error = new DOMException("cancelled", "AbortError");
    Object.defineProperty(error, "cause", {
      value: Object.assign(new Error("connect timed out"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    expect(isQwenDnsFallbackError(error)).toBe(false);
  });
});
