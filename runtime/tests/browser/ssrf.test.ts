/**
 * Address-policy unit tests for the browser tool's SSRF layer.
 *
 * Revert-sensitivity: the loopback-blocked-by-default and "reject if any
 * resolved address is disallowed" assertions go red if `isDisallowedAddress`
 * stops blocking loopback by default, or `resolveAllowedAddress` stops failing
 * closed on a mixed answer.
 */

import { describe, expect, test } from "vitest";
import {
  isDisallowedAddress,
  isLoopbackAddress,
  resolveAllowedAddress,
  validateNavigableUrl,
  BrowserSsrfError,
} from "../../src/browser/ssrf.js";

const strict = { allowPrivateNetwork: false } as const;
const permissive = { allowPrivateNetwork: true } as const;

describe("isLoopbackAddress", () => {
  test("recognizes IPv4 and IPv6 loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.9.9.9")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("8.8.8.8")).toBe(false);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
  });
});

describe("isDisallowedAddress", () => {
  test("blocks cloud metadata regardless of policy", () => {
    expect(isDisallowedAddress("169.254.169.254", strict)).toBe(true);
    expect(isDisallowedAddress("169.254.169.254", permissive)).toBe(true);
    expect(isDisallowedAddress("100.100.100.200", permissive)).toBe(true);
    expect(isDisallowedAddress("fd00:ec2::254", permissive)).toBe(true);
  });

  test("blocks metadata via IPv4-mapped IPv6 even when private is allowed", () => {
    // Chrome/WHATWG canonicalizes http://[::ffff:169.254.169.254]/ to the hex
    // form ::ffff:a9fe:a9fe, which is NOT the literal metadata string — so a
    // literal-string block set would let it through in permissive mode.
    expect(isDisallowedAddress("::ffff:169.254.169.254", permissive)).toBe(true);
    expect(isDisallowedAddress("::ffff:a9fe:a9fe", permissive)).toBe(true);
    expect(isDisallowedAddress("::ffff:100.100.100.200", permissive)).toBe(true);
    expect(isDisallowedAddress("::ffff:6464:64c8", permissive)).toBe(true);
    // Non-canonical spelling of the AWS IPv6 IMDS address.
    expect(
      isDisallowedAddress("fd00:0ec2:0000:0000:0000:0000:0000:0254", permissive),
    ).toBe(true);
    // A benign public IPv4-mapped address is still permitted.
    expect(isDisallowedAddress("::ffff:8.8.8.8", permissive)).toBe(false);
  });

  test("blocks private ranges by default", () => {
    expect(isDisallowedAddress("10.0.0.1", strict)).toBe(true);
    expect(isDisallowedAddress("192.168.1.1", strict)).toBe(true);
    expect(isDisallowedAddress("172.16.0.1", strict)).toBe(true);
  });

  test("blocks loopback by default (stricter than the shared hook guard)", () => {
    expect(isDisallowedAddress("127.0.0.1", strict)).toBe(true);
    expect(isDisallowedAddress("::1", strict)).toBe(true);
  });

  test("permits private and loopback when explicitly allowed", () => {
    expect(isDisallowedAddress("10.0.0.1", permissive)).toBe(false);
    expect(isDisallowedAddress("127.0.0.1", permissive)).toBe(false);
    expect(isDisallowedAddress("192.168.1.1", permissive)).toBe(false);
  });

  test("allows public addresses", () => {
    expect(isDisallowedAddress("8.8.8.8", strict)).toBe(false);
    expect(isDisallowedAddress("1.1.1.1", strict)).toBe(false);
  });
});

describe("validateNavigableUrl", () => {
  test("rejects non-http(s) schemes", () => {
    expect(() => validateNavigableUrl("file:///etc/passwd")).toThrow(
      BrowserSsrfError,
    );
    expect(() => validateNavigableUrl("ftp://example.com")).toThrow();
    expect(() => validateNavigableUrl("data:text/html,<b>x</b>")).toThrow();
  });

  test("rejects embedded credentials", () => {
    expect(() => validateNavigableUrl("http://user:pass@example.com/")).toThrow(
      BrowserSsrfError,
    );
  });

  test("accepts a plain http(s) URL and returns the parsed URL", () => {
    expect(validateNavigableUrl("https://example.com/x").hostname).toBe(
      "example.com",
    );
  });
});

describe("resolveAllowedAddress", () => {
  test("returns the resolved address for a public host", async () => {
    const address = await resolveAllowedAddress("example.com", strict, async () => [
      "93.184.216.34",
    ]);
    expect(address).toBe("93.184.216.34");
  });

  test("passes an IP literal through the same classification", async () => {
    await expect(
      resolveAllowedAddress("10.0.0.1", strict, async () => {
        throw new Error("should not resolve an IP literal");
      }),
    ).rejects.toBeInstanceOf(BrowserSsrfError);
  });

  test("fails closed when the host does not resolve", async () => {
    await expect(
      resolveAllowedAddress("nope.test", strict, async () => []),
    ).rejects.toBeInstanceOf(BrowserSsrfError);
  });

  test("rejects when ANY resolved address is disallowed", async () => {
    await expect(
      resolveAllowedAddress("mixed.test", strict, async () => [
        "8.8.8.8",
        "10.0.0.1",
      ]),
    ).rejects.toBeInstanceOf(BrowserSsrfError);
  });

  test("permits a loopback answer only when private network is allowed", async () => {
    await expect(
      resolveAllowedAddress("local.test", strict, async () => ["127.0.0.1"]),
    ).rejects.toBeInstanceOf(BrowserSsrfError);
    await expect(
      resolveAllowedAddress("local.test", permissive, async () => ["127.0.0.1"]),
    ).resolves.toBe("127.0.0.1");
  });

  test("rejects a host resolving to IPv4-mapped metadata in permissive mode", async () => {
    await expect(
      resolveAllowedAddress("rebind.test", permissive, async () => [
        "::ffff:a9fe:a9fe",
      ]),
    ).rejects.toBeInstanceOf(BrowserSsrfError);
  });
});
