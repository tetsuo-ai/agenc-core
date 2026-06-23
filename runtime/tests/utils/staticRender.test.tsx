import * as React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

// Absolute path to the module staticRender.tsx imports as `../tui/ink.js`,
// plus the render mock — both computed inside vi.hoisted so they exist when
// the hoisted vi.mock factory runs. Mocking by absolute path sidesteps the
// repo's custom vitest source-resolver aliasing so the mock reliably replaces
// the same module instance that staticRender resolves.
const { INK_MODULE_PATH, renderMock } = vi.hoisted(() => {
  const { resolve } = require("node:path") as typeof import("node:path");
  const { fileURLToPath } = require("node:url") as typeof import("node:url");
  const here = fileURLToPath(import.meta.url);
  const inkPath = resolve(here, "../../../src/tui/ink.ts");
  return { INK_MODULE_PATH: inkPath, renderMock: vi.fn() };
});

vi.mock(INK_MODULE_PATH, () => ({
  // `useApp` is referenced by RenderOnceAndExit; provide a no-op so the
  // component module loads even though the mocked render never mounts it.
  useApp: () => ({ exit: () => {} }),
  render: renderMock,
}));

import { renderToAnsiString, renderToString } from "../../src/utils/staticRender.js";

afterEach(() => {
  renderMock.mockReset();
});

describe("staticRender infrastructure-rejection handling", () => {
  // Regression guard for the latent hang: the previous implementation used a
  // `new Promise(async resolve => …)` executor with no `catch`, so an
  // infrastructure-level render() rejection escaped to the global
  // unhandledRejection handler and left the returned promise UNSETTLED — the
  // caller's await hung forever. The bounded vitest timeout below turns any
  // regression (a hang) into a clear, deterministic failure instead.

  test(
    "renderToAnsiString settles (rejects) when ink render() rejects",
    async () => {
      const renderError = new Error("ink render() failed");
      renderMock.mockRejectedValue(renderError);

      await expect(
        renderToAnsiString(<React.Fragment>hi</React.Fragment>),
      ).rejects.toThrow("ink render() failed");
    },
    1000,
  );

  test(
    "renderToString settles (rejects) when ink render() rejects",
    async () => {
      const renderError = new Error("ink render() failed for renderToString");
      renderMock.mockRejectedValue(renderError);

      await expect(
        renderToString(<React.Fragment>hi</React.Fragment>),
      ).rejects.toThrow("ink render() failed for renderToString");
    },
    1000,
  );

  test(
    "renderToAnsiString settles (rejects) when waitUntilExit() rejects",
    async () => {
      const waitError = new Error("waitUntilExit() failed");
      renderMock.mockResolvedValue({
        waitUntilExit: () => Promise.reject(waitError),
      });

      await expect(
        renderToAnsiString(<React.Fragment>hi</React.Fragment>),
      ).rejects.toThrow("waitUntilExit() failed");
    },
    1000,
  );

  test(
    "renderToAnsiString resolves the captured frame on the happy path",
    async () => {
      renderMock.mockImplementation(
        (
          _node: React.ReactNode,
          options: { stdout: NodeJS.WriteStream },
        ) => {
          const stream = options.stdout as unknown as {
            write(chunk: string): void;
          };
          // Emit a single DEC-synchronized frame the way Ink does in non-TTY
          // mode, then resolve an instance that exits immediately.
          stream.write("\x1B[?2026hHELLO-FRAME\x1B[?2026l");
          return Promise.resolve({
            waitUntilExit: () => Promise.resolve(),
          });
        },
      );

      await expect(
        renderToAnsiString(<React.Fragment>hi</React.Fragment>),
      ).resolves.toContain("HELLO-FRAME");
    },
    2000,
  );
});
