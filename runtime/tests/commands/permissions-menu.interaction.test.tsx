import React from "react";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { permissionsCommand } from "../../src/commands/permissions.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { ConfigStore } from "../../src/config/store.js";
import { createRoot } from "../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import stripAnsi from "strip-ansi";

const delay = () => new Promise(resolve => setTimeout(resolve, 40));
const displayedModes = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"] as const;

describe("permissions picker applies modes with Enter", () => {
  it.each(["bypassPermissions", "dontAsk"] as const)("selects %s and records workspace consent with one Enter", async target => {
    const home = await mkdtemp(join(tmpdir(), "agenc-permission-picker-"));
    const workspace = join(home, "workspace");
    await mkdir(workspace);
    const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
    const configStore = new ConfigStore({ home, env: { AGENC_HOME: home }, cwd: workspace });
    let jsx: React.ReactNode;
    const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 40 });
    let output = "";
    stdout.on("data", chunk => { output += chunk.toString(); });
    const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false });
    try {
      const result = await permissionsCommand.execute({
        argsRaw: "", cwd: workspace, home, configStore,
        session: { services: { permissionModeRegistry: registry }, emit: vi.fn(), nextInternalSubId: () => "mode" },
        appState: { setToolJSX: (value: { jsx: React.ReactNode }) => { jsx = value.jsx; } },
      } as unknown as SlashCommandContext);
      expect(result.kind).toBe("skip");
      root.render(<AppStateProvider initialState={getDefaultAppState()}>{jsx}</AppStateProvider>);
      await delay();
      // TTY output can encode spaces with cursor movement rather than bytes.
      const screen = stripAnsi(output).replace(/\s+/g, "");
      for (const label of ["asks first", "edits freely", "plan only", "never asks", "rules only", "auto approve"]) {
        expect(screen).toContain(label.replace(/\s+/g, ""));
      }
      expect(screen).toContain("howmuchcantheagentdowithoutasking?");
      expect(screen).toContain("nocustomrules");
      expect(screen).toContain("/permissionsadd|remove");
      expect(screen).not.toContain("runtime");
      expect(screen).not.toContain("Selected:");
      for (let index = 0; index < displayedModes.indexOf(target); index++) {
        stdin.write("\x1b[B");
        await delay();
      }
      stdin.write("\r");
      await vi.waitFor(() => expect(registry.current().mode).toBe(target));
      expect(registry.current().bypassPermissionsAcceptedIn).toContain(workspace);
      expect(configStore.stateRepository.getNamespace("permissions")).toMatchObject({ bypassPermissionsAcceptedByCwd: { [workspace]: { canonicalCwd: workspace, version: 1 } } });
      expect(stripAnsi(output)).not.toContain("confirm bypass");
      expect(stripAnsi(output)).not.toContain("type bypass");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await rm(home, { recursive: true, force: true });
    }
  });
});
