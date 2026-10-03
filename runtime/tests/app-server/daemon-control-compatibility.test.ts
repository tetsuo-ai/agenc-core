import { describe, expect, it } from "vitest";
import * as control from "../../src/app-server/daemon-control.js";
import * as facade from "../../src/app-server/daemon-cli.js";

// Deliberately separate from the lazy-load test: this file loads the old facade.
describe("daemon control compatibility bindings", () => {
  it("preserves canonical public functions and coordinator identity", () => {
    expect(facade.createNodeDaemonCliHost).toBe(control.createNodeDaemonCliHost);
    expect(facade.runAgenCDaemonCli).toBe(control.runAgenCDaemonCli);
    expect(facade.parseAgenCDaemonCliArgs).toBe(control.parseAgenCDaemonCliArgs);
    expect(facade.AgenCDaemonRpcShutdownCoordinator).toBe(control.AgenCDaemonRpcShutdownCoordinator);
  });
});
