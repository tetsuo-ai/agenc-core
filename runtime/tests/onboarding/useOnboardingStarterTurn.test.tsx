import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { createRoot } from "../tui/ink.js";
import { useOnboardingStarterTurn } from "./useOnboardingStarterTurn.js";

function Probe(props: Parameters<typeof useOnboardingStarterTurn>[0]) {
  useOnboardingStarterTurn(props);
  return null;
}

describe("onboarding starter turn", () => {
  test.each([
    { name: "verified setup", initiallyActive: true, ready: true, hasPrompt: false, calls: 1 },
    { name: "configure later", initiallyActive: true, ready: false, hasPrompt: false, calls: 0 },
    { name: "user supplied a prompt", initiallyActive: true, ready: true, hasPrompt: true, calls: 0 },
    { name: "returning user", initiallyActive: false, ready: true, hasPrompt: false, calls: 0 },
  ])("handles $name without an unwanted submission", async (scenario) => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true, ref() {}, unref() {}, setRawMode() {},
    });
    const stdout = Object.assign(new PassThrough(), {
      isTTY: true, columns: 100, rows: 30,
    });
    const root = await createRoot({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    });
    const submit = vi.fn(async () => {});
    const onError = vi.fn();
    const render = async (active: boolean, ready: boolean) => {
      root.render(<Probe active={active} connectionReady={ready}
        hasInitialPrompt={scenario.hasPrompt} submit={submit} onError={onError} />);
      await new Promise((resolve) => setTimeout(resolve, 25));
    };
    try {
      await render(scenario.initiallyActive, scenario.ready);
      expect(submit).not.toHaveBeenCalled();
      await render(false, scenario.ready);
      expect(submit).toHaveBeenCalledTimes(scenario.calls);
      // Authentication/config updates after leaving the wizard do not start
      // a deferred intro or duplicate the turn that already ran.
      await render(false, true);
      await render(false, true);
      expect(submit).toHaveBeenCalledTimes(scenario.calls);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
