import { describe, expect, it } from "vitest";
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from "./agentSdkTypes.js";

describe("agentSdkTypes SDK session compatibility stubs", () => {
  it("unstable_v2_createSession keeps the explicit not-implemented contract", () => {
    expect(() =>
      unstable_v2_createSession({} as never),
    ).toThrowError("unstable_v2_createSession is not implemented in the SDK");
  });

  it("unstable_v2_resumeSession keeps the explicit not-implemented contract", () => {
    expect(() =>
      unstable_v2_resumeSession("session-1", {} as never),
    ).toThrowError("unstable_v2_resumeSession is not implemented in the SDK");
  });
});
