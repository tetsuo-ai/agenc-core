import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { PassThrough } from "node:stream";
import stripAnsi from "strip-ansi";
import { createRoot } from "../../src/tui/ink.js";
import { getInkInstance } from "../../src/tui/ink/instances.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
async function renderToString(node: React.ReactNode, _columns = 180, input?: string): Promise<string> {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 180, rows: 50 });
  let output = ""; stdout.on("data", chunk => { output += chunk.toString(); });
  const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false });
  try {
    root.render(<AppStateProvider initialState={getDefaultAppState()}>{node}</AppStateProvider>);
    await new Promise(resolve => setTimeout(resolve, 80));
    if (input) {
      stdin.write(input);
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    output = "";
    getInkInstance(stdout as unknown as NodeJS.WriteStream)!.forceRedraw();
    await new Promise(resolve => setTimeout(resolve, 40));
    return stripAnsi(output).replace(/\s+/gu, "").toLowerCase();
  } finally { root.unmount(); }
}

vi.mock("../../src/utils/doctorDiagnostic.js", () => ({ findActiveGeneratedWrapper: vi.fn(async () => null) }));
vi.mock("../../src/utils/nativeInstaller/homebrew.js", () => ({ detectHomebrew: vi.fn(() => false), HOMEBREW_UPDATE_COMMAND: "brew upgrade tetsuo-ai/agenc/agenc" }));
vi.mock("../../src/utils/config.js", () => ({ getRuntimeState: () => ({ skippedUpdateVersion: "0.19.1-test" }), updateRuntimeState: vi.fn() }));
vi.mock("../../src/bin/update-cli.js", () => ({
  checkAgenCUpdate: vi.fn(async () => ({ currentVersion: "0.19.0", latestVersion: "0.19.0", updateAvailable: false })),
  runAgenCUpdateCli: vi.fn(), sanitizeTerminalText: (value: unknown) => String(value),
}));
import { UpdateMenu, hasSkippedUpdate, NPM_UPDATE_COMMAND, resumableConversationId } from "../../src/commands/update-menu.js";
import { getPendingUpdateFollow, resetUpdateRelaunchStateForTestingOnly } from "../../src/tui/update-relaunch-state.js";
import { VERSION } from "../../src/version.js";
import { detectHomebrew } from "../../src/utils/nativeInstaller/homebrew.js";
import { findActiveGeneratedWrapper } from "../../src/utils/doctorDiagnostic.js";
import { runAgenCUpdateCli } from "../../src/bin/update-cli.js";

describe("update menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(detectHomebrew).mockReturnValue(false);
    vi.mocked(findActiveGeneratedWrapper).mockResolvedValue(null);
  });
  const available = { currentVersion: "0.19.0", latestVersion: "0.19.1-test", updateAvailable: true } as any;
  test.each([false, true])("Homebrew shows the tap command immediately (startup=%s) and never runs the installer", async startup => {
    vi.mocked(detectHomebrew).mockReturnValue(true);
    vi.mocked(findActiveGeneratedWrapper).mockResolvedValue({ kind: "posix", path: "/bin/agenc" } as any);
    const node = <UpdateMenu checked={available} startup={startup} close={() => {}} />;
    const text = await renderToString(node);
    expect(text).toContain("installtype:homebrew");
    expect(text).toContain("brewupgradetetsuo-ai/agenc/agenc");
    expect(text).not.toContain("1updatenow");
    const chosen = await renderToString(node, 180, "1");
    expect(chosen).toContain("brewupgradetetsuo-ai/agenc/agenc");
    expect(chosen).not.toContain("npminstall");
    expect(runAgenCUpdateCli).not.toHaveBeenCalled();
    expect(findActiveGeneratedWrapper).not.toHaveBeenCalled();
  });
  test("npm retains terminal npm instructions", async () => {
    const text = await renderToString(<UpdateMenu checked={available} close={() => {}} />, 180, "1");
    expect(text).toContain("runinyourterminal:npminstall-g@tetsuo-ai/agenc@latest");
    expect(runAgenCUpdateCli).not.toHaveBeenCalled();
  });
  test("curl installer still updates through its active generated wrapper", async () => {
    vi.mocked(findActiveGeneratedWrapper).mockResolvedValue({ kind: "posix", path: "/home/user/.local/bin/agenc" } as any);
    vi.mocked(runAgenCUpdateCli).mockResolvedValue(0);
    const text = await renderToString(<UpdateMenu checked={available} close={() => {}} />, 180, "1");
    expect(text).toContain("installtype:install.sh");
    expect(runAgenCUpdateCli).toHaveBeenCalledWith(expect.objectContaining({ wrapper: "/home/user/.local/bin/agenc" }), expect.anything());
  });
  test("shows numbered choices and both versions without animations", async () => {
    const text = await renderToString(<UpdateMenu checked={{ currentVersion: "0.19.0", latestVersion: "0.19.1-test", updateAvailable: true } as any} close={() => {}} />, 80);
    expect(text).toContain("agenc0.19.1-testisavailable.youhave0.19.0.");
    for (const choice of ["1updatenow", "2skipthisversion", "3notnow"]) expect(text).toContain(choice);
    expect(text).not.toContain("—");
  });
  test("manual check reports current/latest/install type when up to date", async () => {
    const text = await renderToString(<UpdateMenu checked={{ currentVersion: "0.19.0", latestVersion: "0.19.0", updateAvailable: false } as any} close={() => {}} />, 80);
    expect(text).toContain("uptodate");
    expect(text).toContain("latest:0.19.0");
    expect(text).toContain("installtype:");
  });
  test("skip acknowledges only one release", () => {
    expect(hasSkippedUpdate("0.19.1-test")).toBe(true);
    expect(hasSkippedUpdate("0.19.2-test")).toBe(false);
    expect(NPM_UPDATE_COMMAND).toBe("npm install -g @tetsuo-ai/agenc@latest");
  });
});

describe("update menu in place", () => {
  const available = { currentVersion: "0.19.0", latestVersion: "0.19.1-test", updateAvailable: true } as any;
  const relaunch = vi.fn();
  const inPlace = (overrides: Record<string, unknown> = {}) => ({
    relaunch, cwd: "/work", conversationId: "conv-abc123", platform: "darwin" as NodeJS.Platform, ...overrides,
  });
  const installed = async (_command: unknown, deps: any) => {
    deps.stdout(JSON.stringify({ activated: true, latestVersion: "0.19.1-test" }));
    return 0;
  };
  beforeEach(() => {
    vi.clearAllMocks();
    relaunch.mockReset();
    resetUpdateRelaunchStateForTestingOnly();
    vi.mocked(detectHomebrew).mockReturnValue(false);
    vi.mocked(findActiveGeneratedWrapper).mockResolvedValue(null);
  });

  test("install.sh installs without the daemon step, then comes back in the same conversation", async () => {
    vi.mocked(findActiveGeneratedWrapper).mockResolvedValue({ kind: "posix", path: "/home/u/.local/bin/agenc" } as any);
    vi.mocked(runAgenCUpdateCli).mockImplementation(installed as any);
    const before = await renderToString(<UpdateMenu checked={available} close={() => {}} inPlace={inPlace()} />);
    expect(before).toContain("1updatenow");
    expect(before).toContain("installs,thenrestartsagenconthenewversioninthisconversation.");
    await renderToString(<UpdateMenu checked={available} close={() => {}} inPlace={inPlace()} />, 180, "1");
    expect(runAgenCUpdateCli).toHaveBeenCalledWith(
      expect.objectContaining({ wrapper: "/home/u/.local/bin/agenc", noRestart: true }), expect.anything());
    expect(relaunch).toHaveBeenCalledWith({
      fromVersion: VERSION, targetVersion: "0.19.1-test", command: "/home/u/.local/bin/agenc",
      installType: "install.sh", conversationId: "conv-abc123", cwd: "/work",
    });
  });

  test("while a turn runs it offers Update after this turn and follows once idle", async () => {
    vi.mocked(findActiveGeneratedWrapper).mockResolvedValue({ kind: "posix", path: "/home/u/.local/bin/agenc" } as any);
    vi.mocked(runAgenCUpdateCli).mockImplementation(installed as any);
    const node = <UpdateMenu checked={available} close={() => {}} inPlace={inPlace({ isBusy: () => true })} />;
    expect(await renderToString(node)).toContain("1updateafterthisturn");
    const text = await renderToString(node, 180, "1");
    expect(text).toContain("oncethecurrentworkisdone");
    expect(relaunch).not.toHaveBeenCalled();
    expect(getPendingUpdateFollow()).toMatchObject({ when: "idle", request: { targetVersion: "0.19.1-test" } });
  });

  test("Homebrew runs brew from the menu, confirms the version and relaunches on the opt bin", async () => {
    vi.mocked(detectHomebrew).mockReturnValue(true);
    const lines: string[] = [];
    const deps = {
      runPackageManager: async (kind: string, onLine: (line: string) => void) => {
        lines.push(kind); onLine("==> Upgrading tetsuo-ai/agenc/agenc");
        return { ok: true, code: 0, tail: [] };
      },
      execTarget: async () => "/opt/homebrew/opt/agenc/bin/agenc",
      installedVersion: async () => "0.19.1-test",
    };
    const node = <UpdateMenu checked={available} close={() => {}} inPlace={inPlace()} deps={deps} />;
    expect(await renderToString(node)).toContain("1updatenow");
    await renderToString(node, 180, "1");
    expect(lines).toEqual(["Homebrew"]);
    expect(runAgenCUpdateCli).not.toHaveBeenCalled();
    expect(relaunch).toHaveBeenCalledWith(expect.objectContaining({
      targetVersion: "0.19.1-test", command: "/opt/homebrew/opt/agenc/bin/agenc", installType: "Homebrew",
    }));
  });

  test("a failed npm install keeps this version and shows npm's message", async () => {
    const deps = {
      startedByNpm: async () => true,
      runPackageManager: async () => ({ ok: false, code: 243, tail: ["npm error code EACCES", "npm error permission denied"] }),
    };
    const text = await renderToString(<UpdateMenu checked={available} close={() => {}} inPlace={inPlace()} deps={deps} />, 180, "1");
    expect(text).toContain("installtype:npm");
    expect(text).toContain("npminstall-g@tetsuo-ai/agenc@latestdidnotfinish(exit243).agenckeepsrunning");
    expect(text).toContain("npmerrorcodeeacces");
    expect(relaunch).not.toHaveBeenCalled();
  });

  test("Windows keeps the restart message", async () => {
    vi.mocked(findActiveGeneratedWrapper).mockResolvedValue({ kind: "cmd", path: "C:\\agenc\\agenc.cmd" } as any);
    vi.mocked(runAgenCUpdateCli).mockImplementation(installed as any);
    const text = await renderToString(<UpdateMenu checked={available} close={() => {}} inPlace={inPlace({ platform: "win32" })} />, 180, "1");
    expect(runAgenCUpdateCli).toHaveBeenCalledWith(expect.not.objectContaining({ noRestart: true }), expect.anything());
    expect(text).toContain("exitagencandlaunchitagain");
    expect(relaunch).not.toHaveBeenCalled();
  });

  test("before the first prompt it relaunches without a conversation", async () => {
    vi.mocked(findActiveGeneratedWrapper).mockResolvedValue({ kind: "posix", path: "/home/u/.local/bin/agenc" } as any);
    vi.mocked(runAgenCUpdateCli).mockImplementation(installed as any);
    await renderToString(<UpdateMenu checked={available} close={() => {}} inPlace={inPlace({ conversationId: "agenc-tui-idle-77" })} />, 180, "1");
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(relaunch.mock.calls[0]![0]).not.toHaveProperty("conversationId");
    expect(resumableConversationId("agenc-tui-idle-77")).toBeUndefined();
    expect(resumableConversationId("conv-abc123")).toBe("conv-abc123");
  });
});
