import { describe, expect, it } from "vitest";

import { parseAddress } from "../../src/utils/peerAddress.js";

describe("parseAddress", () => {
  it("reads uds: and bridge: schemes and keeps the remainder as the target", () => {
    expect(parseAddress("uds:/tmp/agenc.sock")).toEqual({
      scheme: "uds",
      target: "/tmp/agenc.sock",
    });
    expect(parseAddress("bridge:session_abc")).toEqual({
      scheme: "bridge",
      target: "session_abc",
    });
  });

  it("routes a bare socket path through UDS so replies are not dropped", () => {
    expect(parseAddress("/tmp/agenc.sock")).toEqual({
      scheme: "uds",
      target: "/tmp/agenc.sock",
    });
  });

  it("leaves teammate names and other targets as other", () => {
    expect(parseAddress("session_manager")).toEqual({
      scheme: "other",
      target: "session_manager",
    });
    expect(parseAddress("peer-1")).toEqual({
      scheme: "other",
      target: "peer-1",
    });
    expect(parseAddress("")).toEqual({ scheme: "other", target: "" });
  });

  it("does not treat a missing scheme body as a teammate name", () => {
    expect(parseAddress("uds:")).toEqual({ scheme: "uds", target: "" });
    expect(parseAddress("bridge:")).toEqual({ scheme: "bridge", target: "" });
  });
});
