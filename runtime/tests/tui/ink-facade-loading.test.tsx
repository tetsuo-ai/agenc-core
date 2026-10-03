import { PassThrough } from "node:stream";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

const loading = vi.hoisted(() => ({ evaluations: 0 }));
vi.mock("../../src/tui/ink/root.js", async original => {
  loading.evaluations++;
  return original();
});

function streams() {
  const stdout = Object.assign(new PassThrough(), {
    columns: 40, rows: 10, isTTY: false,
  });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: false, setRawMode: () => {}, ref: () => {}, unref: () => {},
  });
  const stderr = new PassThrough();
  let output = "";
  stdout.on("data", chunk => { output += chunk.toString(); });
  return {
    options: {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      patchConsole: false,
    },
    output: () => output,
    close: () => { stdout.destroy(); stdin.destroy(); stderr.destroy(); },
  };
}

describe("Ink facade loading", () => {
  it("defers the real renderer and preserves themed render and createRoot output", async () => {
    const ink = await import("../../src/tui/ink.js");
    expect(ink.Text).toBeDefined();
    expect(ink.Box).toBeDefined();
    expect(loading.evaluations).toBe(0);

    function ThemeProbe() {
      return createElement(ink.Text, null, `active theme: ${ink.useTheme()}`);
    }
    const first = streams();
    const second = streams();
    let root: Awaited<ReturnType<typeof ink.createRoot>> | undefined;
    let instance: Awaited<ReturnType<typeof ink.render>> | undefined;
    try {
      [root, instance] = await Promise.all([
        ink.createRoot(first.options),
        ink.render(createElement(ThemeProbe), second.options),
      ]);
      root.render(createElement(ThemeProbe));
      await vi.waitFor(() => {
        expect(first.output()).toContain("active theme: dark");
        expect(second.output()).toContain("active theme: dark");
      });
      expect(loading.evaluations).toBe(1);
    } finally {
      const exits = [root?.waitUntilExit(), instance?.waitUntilExit()];
      root?.unmount();
      instance?.unmount();
      await Promise.all(exits);
      instance?.cleanup();
      first.close();
      second.close();
    }
  }, 30_000);
});
