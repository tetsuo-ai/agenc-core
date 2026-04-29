import { File as NodeFile } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { installNodeRuntimeCompat } from "./node-compat.js";

const originalFileDescriptor = Object.getOwnPropertyDescriptor(globalThis, "File");

function restoreGlobalFile(): void {
  if (originalFileDescriptor) {
    Object.defineProperty(globalThis, "File", originalFileDescriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, "File");
}

describe("node runtime compatibility", () => {
  afterEach(() => {
    restoreGlobalFile();
  });

  it("installs node:buffer File when the Node global is missing", () => {
    Reflect.deleteProperty(globalThis, "File");
    expect(typeof globalThis.File).toBe("undefined");

    installNodeRuntimeCompat();

    expect(globalThis.File).toBe(NodeFile);
  });

  it("preserves an existing File global", () => {
    const sentinel = class SentinelFile {} as unknown as typeof globalThis.File;
    Object.defineProperty(globalThis, "File", {
      value: sentinel,
      configurable: true,
      writable: true,
    });

    installNodeRuntimeCompat();

    expect(globalThis.File).toBe(sentinel);
  });
});
