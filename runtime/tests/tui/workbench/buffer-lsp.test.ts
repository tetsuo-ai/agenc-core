import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const manager = vi.hoisted(() => ({
  openFile: vi.fn(),
  changeFile: vi.fn(),
  saveFile: vi.fn(),
  closeFile: vi.fn(),
  sendRequest: vi.fn(),
}));

const logMock = vi.hoisted(() => ({
  logError: vi.fn(),
}));

vi.mock("../../../src/services/lsp/manager.js", () => ({
  getLspServerManager: () => manager,
}));

vi.mock("../../../src/utils/log.js", () => ({
  logError: logMock.logError,
}));

import {
  notifyBufferLspChanged,
  notifyBufferLspClosed,
  notifyBufferLspOpened,
  notifyBufferLspSaved,
  parseBufferDefinitionTarget,
  parseBufferHoverText,
  requestBufferDefinition,
  requestBufferHover,
} from "../../../src/tui/workbench/buffer/lsp.js";

beforeEach(() => {
  for (const fn of Object.values(manager)) fn.mockReset();
  logMock.logError.mockReset();
});

describe("buffer LSP helpers", () => {
  it("normalizes hover payloads", () => {
    expect(parseBufferHoverText([
      { value: "first" },
      "second",
    ])).toBe("first\nsecond");
  });

  it("parses location and location-link definition targets", () => {
    const uri = pathToFileURL("/tmp/example.ts").href;

    expect(parseBufferDefinitionTarget({
      uri,
      range: { start: { line: 4, character: 2 } },
    })).toEqual({
      path: "/tmp/example.ts",
      line: 5,
      character: 2,
    });
    expect(parseBufferDefinitionTarget({
      targetUri: uri,
      targetSelectionRange: { start: { line: 8, character: 1 } },
    })).toEqual({
      path: "/tmp/example.ts",
      line: 9,
      character: 1,
    });
  });

  it("sends best-effort lifecycle notifications", async () => {
    notifyBufferLspOpened("/tmp/example.ts", "const value = 1;\n");
    notifyBufferLspChanged("/tmp/example.ts", "const value = 2;\n");
    notifyBufferLspSaved("/tmp/example.ts");
    notifyBufferLspClosed("/tmp/example.ts");
    await Promise.resolve();

    expect(manager.openFile).toHaveBeenCalledWith("/tmp/example.ts", "const value = 1;\n");
    expect(manager.changeFile).toHaveBeenCalledWith("/tmp/example.ts", "const value = 2;\n");
    expect(manager.saveFile).toHaveBeenCalledWith("/tmp/example.ts");
    expect(manager.closeFile).toHaveBeenCalledWith("/tmp/example.ts");
  });

  it("logs best-effort lifecycle notification failures", async () => {
    const error = new Error("lsp open failed");
    manager.openFile.mockRejectedValueOnce(error);

    notifyBufferLspOpened("/tmp/example.ts", "const value = 1;\n");
    await Promise.resolve();
    await Promise.resolve();

    expect(logMock.logError).toHaveBeenCalledWith(error);
  });

  it("requests hover and definition with file URIs", async () => {
    manager.sendRequest
      .mockResolvedValueOnce({ contents: { value: "hover text" } })
      .mockResolvedValueOnce({
        uri: pathToFileURL("/tmp/example.ts").href,
        range: { start: { line: 1, character: 3 } },
      });

    await expect(requestBufferHover("/tmp/example.ts", { line: 0, character: 1 }))
      .resolves.toBe("hover text");
    await expect(requestBufferDefinition("/tmp/example.ts", { line: 0, character: 1 }))
      .resolves.toEqual({
        path: "/tmp/example.ts",
        line: 2,
        character: 3,
      });
    expect(manager.sendRequest).toHaveBeenNthCalledWith(
      1,
      "/tmp/example.ts",
      "textDocument/hover",
      {
        textDocument: { uri: pathToFileURL("/tmp/example.ts").href },
        position: { line: 0, character: 1 },
      },
    );
  });
});
