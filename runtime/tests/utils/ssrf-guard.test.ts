import { describe, expect, it } from "vitest";
import {
  expandIPv6Groups,
  isBlockedAddress,
} from "../../src/utils/hooks/ssrfGuard.js";

describe("expandIPv6Groups", () => {
  it("expands compressed IPv6 addresses with dotted-decimal tails", () => {
    expect(expandIPv6Groups("::192.0.2.1")).toEqual([
      0, 0, 0, 0, 0, 0, 0xc000, 0x0201,
    ]);
    expect(expandIPv6Groups("fc00::192.0.2.1")).toEqual([
      0xfc00, 0, 0, 0, 0, 0, 0xc000, 0x0201,
    ]);
    expect(expandIPv6Groups("64:ff9b::192.0.2.1")).toEqual([
      0x0064, 0xff9b, 0, 0, 0, 0, 0xc000, 0x0201,
    ]);
  });

  it("classifies scoped IPv6 literals by their address bits", () => {
    expect(expandIPv6Groups("fe80::1%eth0")).toEqual([
      0xfe80, 0, 0, 0, 0, 0, 0, 1,
    ]);
    expect(expandIPv6Groups("fd00:ec2::254%en0")).toEqual([
      0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254,
    ]);
  });

  it("rejects malformed addresses when called directly", () => {
    expect(expandIPv6Groups("2001:db8:1")).toBeNull();
    expect(expandIPv6Groups("2001::db8::1")).toBeNull();
    expect(expandIPv6Groups("::ffff:01.2.3.4")).toBeNull();
    expect(expandIPv6Groups("::ffff:999.2.3.4")).toBeNull();
  });
});

describe("isBlockedAddress", () => {
  it("blocks special IPv6 ranges with dotted-decimal tails", () => {
    for (const address of [
      "::10.0.0.1",
      "fc00::192.0.2.1",
      "fe80::192.0.2.1",
      "64:ff9b::192.0.2.1",
      "64:ff9b:1:1::10.0.0.1",
      "64:ff9b:1:ffff:ffff:ffff:10.0.0.1",
      "fc00::1%eth0",
      "fe80::1%eth0",
      "fd00:ec2::254%eth0",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("keeps public mapped addresses and scoped loopback allowed", () => {
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedAddress("::1%lo0")).toBe(false);
  });
});
