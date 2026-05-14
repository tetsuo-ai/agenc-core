import { PassThrough } from "node:stream";

import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink.js";
import { AppStateProvider } from "../state/AppState.js";
import { ConsoleOAuthFlow } from "./ConsoleOAuthFlow.js";

const mocks = vi.hoisted(() => ({
  oauthService: {
    cleanup: vi.fn(),
    handleManualAuthCodeInput: vi.fn(),
    startOAuthFlow: vi.fn(),
  },
  setClipboard: vi.fn(),
}));

vi.mock("../../cli/handlers/auth", () => ({
  installOAuthTokens: vi.fn(),
}));

vi.mock("../../services/analytics/index.js", () => ({
  logEvent: vi.fn(),
}));

vi.mock("../../services/api/errorUtils", () => ({
  getSSLErrorHint: vi.fn(() => null),
}));

vi.mock("../../services/notifier", () => ({
  sendNotification: vi.fn(),
}));

vi.mock("../../services/oauth/index", () => ({
  OAuthService: vi.fn(function OAuthService() {
    return mocks.oauthService;
  }),
}));

vi.mock("../../utils/auth", () => ({
  getOauthAccountInfo: vi.fn(() => null),
  validateForceLoginOrg: vi.fn(async () => ({ valid: true })),
}));

vi.mock("../../utils/log", () => ({
  logError: vi.fn(),
}));

vi.mock("../../utils/settings/settings", async importOriginal => ({
  ...(await importOriginal<typeof import("../../utils/settings/settings.js")>()),
  getInitialSettings: vi.fn(() => ({})),
  getSettings_DEPRECATED: vi.fn(() => ({})),
}));

vi.mock("../hooks/useTerminalSize", () => ({
  useTerminalSize: () => ({ columns: 120, rows: 40 }),
}));

vi.mock("../ink/termio/osc.js", () => ({
  setClipboard: mocks.setClipboard,
}));

vi.mock("../ink/useTerminalNotification.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../ink/useTerminalNotification.js")>()),
  useTerminalNotification: () => undefined,
}));

vi.mock("../keybindings/useKeybinding.js", () => ({
  useKeybinding: vi.fn(),
}));

vi.mock("./CustomSelect/select", () => ({
  Select: () => null,
}));

vi.mock("./ProviderManager", () => ({
  ProviderManager: () => null,
}));

vi.mock("./TextInput.js", async () => {
  const React = await import("react");
  return {
    default: (props: { onChange: (value: string) => void }) => {
      React.useEffect(() => {
        props.onChange("c");
      }, [props]);
      return null;
    },
  };
});

function createTestStreams() {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };

  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number }).columns = 120;

  return { stdout, stdin };
}

async function mountOAuthFlow() {
  const { stdout, stdin } = createTestStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  root.render(
    <AppStateProvider>
      <ConsoleOAuthFlow
        initialStatus={{ state: "ready_to_start" }}
        onDone={() => {}}
      />
    </AppStateProvider>,
  );

  return {
    root,
    stdin,
    stdout,
    unmount: () => {
      root.unmount();
      stdin.end();
      stdout.end();
    },
  };
}

function waitForEffects() {
  return new Promise(resolve => setTimeout(resolve, 25));
}

describe("ConsoleOAuthFlow timer cleanup", () => {
  beforeEach(() => {
    mocks.oauthService.cleanup.mockClear();
    mocks.oauthService.handleManualAuthCodeInput.mockClear();
    mocks.oauthService.startOAuthFlow.mockReset();
    mocks.oauthService.startOAuthFlow.mockImplementation(async onOpen => {
      onOpen("https://console.example.test/oauth");
      return new Promise(() => {});
    });
    mocks.setClipboard.mockReset();
    mocks.setClipboard.mockResolvedValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("clears the delayed browser fallback timer on unmount", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const mounted = await mountOAuthFlow();

    await waitForEffects();
    const promptTimerIndex = setTimeoutSpy.mock.calls.findIndex(
      call => call[1] === 3000,
    );
    expect(promptTimerIndex).toBeGreaterThanOrEqual(0);
    const promptTimer = setTimeoutSpy.mock.results[promptTimerIndex]?.value;

    mounted.unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(promptTimer);
    expect(mocks.oauthService.cleanup).toHaveBeenCalledTimes(1);
  });

  test("clears the copied-url feedback timer on unmount", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const mounted = await mountOAuthFlow();

    await waitForEffects();
    const promptTimerIndex = setTimeoutSpy.mock.calls.findIndex(
      call => call[1] === 3000,
    );
    expect(promptTimerIndex).toBeGreaterThanOrEqual(0);
    const promptTimerCallback = setTimeoutSpy.mock.calls[promptTimerIndex]?.[0];
    expect(promptTimerCallback).toEqual(expect.any(Function));

    (promptTimerCallback as () => void)();
    await waitForEffects();

    const feedbackTimerIndex = setTimeoutSpy.mock.calls.findIndex(
      call => call[1] === 2000,
    );
    expect(feedbackTimerIndex).toBeGreaterThanOrEqual(0);
    const feedbackTimer = setTimeoutSpy.mock.results[feedbackTimerIndex]?.value;

    mounted.unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(feedbackTimer);
    expect(mocks.oauthService.cleanup).toHaveBeenCalledTimes(1);
  });
});
