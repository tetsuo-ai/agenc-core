import {
  lookup as systemLookup,
  resolve4 as systemResolve4,
  resolve6 as systemResolve6,
  type LookupAddress,
  type LookupOptions,
} from "node:dns";
import { isIP, type LookupFunction } from "node:net";

import {
  Agent,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from "undici";

type AddressFamily = 4 | 6;
type ResolveFamily = (
  hostname: string,
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: readonly string[],
  ) => void,
) => void;
type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;
type CompatibleLookup = (
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
) => void;

export interface QwenDnsTransportDependencies {
  readonly resolve4: ResolveFamily;
  readonly resolve6: ResolveFamily;
  readonly fallbackLookup: CompatibleLookup;
  readonly createDispatcher: (lookup: LookupFunction) => Dispatcher;
  readonly primaryFetch: typeof fetch;
  readonly fetchWithDispatcher: (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
    dispatcher: Dispatcher,
  ) => Promise<Response>;
}

export interface QwenDnsTransport {
  readonly fetchImpl: typeof fetch;
  dispose(): Promise<void>;
}

function resolve4(
  hostname: string,
  callback: Parameters<ResolveFamily>[1],
): void {
  systemResolve4(hostname, callback);
}

function resolve6(
  hostname: string,
  callback: Parameters<ResolveFamily>[1],
): void {
  systemResolve6(hostname, callback);
}

const fallbackLookup = systemLookup as unknown as CompatibleLookup;

const DEFAULT_DEPENDENCIES: QwenDnsTransportDependencies = {
  resolve4,
  resolve6,
  fallbackLookup,
  createDispatcher: (lookup) =>
    new Agent({
      connect: { lookup },
    }),
  primaryFetch: (input, init) => fetch(input, init),
  fetchWithDispatcher: async (input, init, dispatcher) => {
    // The request URL remains the official hostname. Only socket address
    // resolution changes, so Undici continues to derive TLS SNI and
    // certificate validation from that hostname rather than from an IP.
    const response = await undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      {
        ...(init as UndiciRequestInit | undefined),
        dispatcher,
      },
    );
    return response as unknown as Response;
  },
};

const DNS_FALLBACK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "EAI_SYSTEM",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    if (typeof current !== "object" || !("cause" in current)) break;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return chain;
}

function isAbortError(error: unknown): boolean {
  return errorChain(error).some((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const record = candidate as {
      readonly code?: unknown;
      readonly name?: unknown;
    };
    return record.code === "ABORT_ERR" || record.name === "AbortError";
  });
}

/** @internal Exported for deterministic error-classification tests. */
export function isQwenDnsFallbackError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  return errorChain(error).some((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const record = candidate as {
      readonly code?: unknown;
      readonly message?: unknown;
    };
    if (
      typeof record.code === "string" &&
      DNS_FALLBACK_ERROR_CODES.has(record.code)
    ) {
      return true;
    }
    return (
      typeof record.message === "string" &&
      /getaddrinfo(?:[^\n]*(?:timed?\s*out|timeout))?/i.test(record.message)
    );
  });
}

function dnsError(
  hostname: string,
  code: string,
  message: string,
  causes: readonly unknown[] = [],
): NodeJS.ErrnoException {
  const error =
    causes.length > 0
      ? new AggregateError(causes, message)
      : new Error(message);
  return Object.assign(error, { code, hostname });
}

function normalizeFamily(
  family: LookupOptions["family"],
): AddressFamily | undefined | null {
  if (family === undefined || family === 0) return undefined;
  if (family === 4 || family === "IPv4") return 4;
  if (family === 6 || family === "IPv6") return 6;
  return null;
}

function resolveFamilyAddresses(args: {
  readonly hostname: string;
  readonly family: AddressFamily;
  readonly resolver: ResolveFamily;
}): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      error: NodeJS.ErrnoException | null,
      addresses: readonly string[],
    ): void => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
        return;
      }

      const normalized: LookupAddress[] = [];
      for (const address of addresses) {
        if (typeof address !== "string" || isIP(address) !== args.family) {
          reject(
            dnsError(
              args.hostname,
              "EBADRESP",
              `DNS returned an invalid IPv${args.family} address for ${args.hostname}`,
            ),
          );
          return;
        }
        normalized.push({ address, family: args.family });
      }
      if (normalized.length === 0) {
        reject(
          dnsError(
            args.hostname,
            "ENODATA",
            `DNS returned no IPv${args.family} addresses for ${args.hostname}`,
          ),
        );
        return;
      }
      resolve(normalized);
    };

    try {
      args.resolver(args.hostname, finish);
    } catch (error) {
      settled = true;
      reject(error);
    }
  });
}

function orderAddresses(
  addresses: readonly LookupAddress[],
  options: LookupOptions,
): LookupAddress[] {
  const order =
    options.order ??
    (options.verbatim === false ? "ipv4first" : "verbatim");
  if (order === "ipv6first") {
    return [...addresses].sort((left, right) => right.family - left.family);
  }
  if (order === "ipv4first") {
    return [...addresses].sort((left, right) => left.family - right.family);
  }
  return [...addresses];
}

/**
 * Build a Node-compatible lookup that bypasses getaddrinfo only for one exact
 * official Qwen hostname. Redirects or any other hostname retain the system
 * resolver instead of silently broadening this provider-specific workaround.
 *
 * @internal Exported for deterministic transport tests.
 */
export function createQwenDnsLookup(
  officialHostname: string,
  dependencies: Pick<
    QwenDnsTransportDependencies,
    "resolve4" | "resolve6" | "fallbackLookup"
  > = DEFAULT_DEPENDENCIES,
): LookupFunction {
  const expectedHostname = officialHostname.toLowerCase();

  return ((hostname, options, callback) => {
    if (hostname.toLowerCase() !== expectedHostname) {
      dependencies.fallbackLookup(hostname, options, callback);
      return;
    }

    const family = normalizeFamily(options.family);
    if (family === null) {
      callback(
        dnsError(
          hostname,
          "EINVAL",
          `Unsupported DNS address family ${String(options.family)} for ${hostname}`,
        ),
        "",
      );
      return;
    }

    const families: readonly AddressFamily[] = family ? [family] : [4, 6];
    void Promise.allSettled(
      families.map((candidate) =>
        resolveFamilyAddresses({
          hostname,
          family: candidate,
          resolver:
            candidate === 4 ? dependencies.resolve4 : dependencies.resolve6,
        }),
      ),
    ).then((results) => {
      const addresses = orderAddresses(
        results.flatMap((result) =>
          result.status === "fulfilled" ? result.value : [],
        ),
        options,
      );
      if (addresses.length === 0) {
        const causes = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        const firstCode = causes.find(
          (cause): cause is NodeJS.ErrnoException =>
            cause instanceof Error &&
            typeof (cause as NodeJS.ErrnoException).code === "string",
        )?.code;
        callback(
          dnsError(
            hostname,
            firstCode ?? "ENOTFOUND",
            `DNS resolution failed for ${hostname}`,
            causes,
          ),
          "",
        );
        return;
      }

      if (options.all === true) {
        callback(null, addresses);
        return;
      }
      const first = addresses[0];
      if (!first) {
        callback(
          dnsError(
            hostname,
            "ENOTFOUND",
            `DNS resolution failed for ${hostname}`,
          ),
          "",
        );
        return;
      }
      callback(null, first.address, first.family);
    });
  }) as LookupFunction;
}

/**
 * Create a lazily allocated Undici transport for an exact official HTTPS host.
 * Custom hosts intentionally receive no transport and continue through the
 * ordinary provider fetch path.
 *
 * @internal Exported for deterministic lifecycle tests.
 */
export function createQwenOfficialDnsTransport(
  baseURL: string,
  officialHostname: string,
  dependencies: QwenDnsTransportDependencies = DEFAULT_DEPENDENCIES,
): QwenDnsTransport | undefined {
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== officialHostname.toLowerCase()
  ) {
    return undefined;
  }

  const lookup = createQwenDnsLookup(officialHostname, dependencies);
  let dispatcher: Dispatcher | undefined;
  let disposePromise: Promise<void> | undefined;
  let disposed = false;
  let preferDnsFallback = false;

  const fetchViaDnsFallback: typeof fetch = async (input, init) => {
    dispatcher ??= dependencies.createDispatcher(lookup);
    return await dependencies.fetchWithDispatcher(input, init, dispatcher);
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    if (disposed) {
      throw new Error("Qwen DNS transport has been disposed");
    }
    if (preferDnsFallback) {
      return await fetchViaDnsFallback(input, init);
    }
    try {
      return await dependencies.primaryFetch(input, init);
    } catch (error) {
      if (
        disposed ||
        init?.signal?.aborted ||
        !isQwenDnsFallbackError(error)
      ) {
        throw error;
      }
      // A provider instance is session-scoped. Once getaddrinfo/connect has
      // demonstrated the macOS/VPN failure mode, keep the safe resolver for
      // later calls in that session instead of paying the same timeout again.
      preferDnsFallback = true;
      return await fetchViaDnsFallback(input, init);
    }
  };

  return {
    fetchImpl,
    dispose: () => {
      if (disposePromise) return disposePromise;
      disposed = true;
      const activeDispatcher = dispatcher;
      dispatcher = undefined;
      disposePromise = activeDispatcher
        ? Promise.resolve().then(() => activeDispatcher.close())
        : Promise.resolve();
      return disposePromise;
    },
  };
}
