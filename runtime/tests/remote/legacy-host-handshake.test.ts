import { describe, expect, it } from "vitest";

import { LEGACY_HOST_PROTOCOL, legacyHostHandshake } from "../../src/bin/remote-cli.js";

describe("legacyHostHandshake", () => {
  const ticket = "s1:acct-1:host:1790000000000:host-1:0123abcd";

  it("carries the ticket as a base64url subprotocol and keeps the URL clean", () => {
    const handshake = legacyHostHandshake("wss://relay.example", ticket, false);
    expect(handshake.url).toBe("wss://relay.example/v1/host");
    expect(handshake.protocols[0]).toBe(LEGACY_HOST_PROTOCOL);
    expect(handshake.protocols[1]).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(Buffer.from(handshake.protocols[1] ?? "", "base64url").toString("utf8")).toBe(ticket);
    expect(handshake.url).not.toContain(ticket);
  });

  it("falls back to the query form for relays without the subprotocol", () => {
    const handshake = legacyHostHandshake("wss://relay.example", ticket, true);
    expect(handshake.protocols).toEqual([]);
    expect(handshake.url).toBe(`wss://relay.example/v1/host?ticket=${encodeURIComponent(ticket)}`);
  });
});
