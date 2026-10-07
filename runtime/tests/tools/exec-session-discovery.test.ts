import { describe, expect, it, vi } from "vitest";
import {
  bindExecSessionDiscovery,
  notifyExecSessionDiscovery,
} from "../../src/tools/exec-session-discovery.js";

describe("exec session discovery binding", () => {
  it("notifies only the registry-scoped args object", () => {
    const bound = { command: "cat README.md" };
    const forged = { command: "cat README.md" };
    const observer = vi.fn();
    const fallback = vi.fn();
    bindExecSessionDiscovery(bound, observer);
    notifyExecSessionDiscovery(bound);
    notifyExecSessionDiscovery(forged, fallback);
    notifyExecSessionDiscovery({ command: "other" });
    expect(observer).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("prefers the bound observer over a fallback", () => {
    const args = { command: "rg -n foo" };
    const observer = vi.fn();
    const fallback = vi.fn();
    bindExecSessionDiscovery(args, observer);
    notifyExecSessionDiscovery(args, fallback);
    expect(observer).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });
});
