import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { expect, it } from "vitest";
import instances from "../../src/tui/ink/instances.js";
import { ConfigStore } from "../../src/config/store.js";
import { createRoot } from "../../src/tui/ink.js";
import { KeybindingSetup } from "../../src/tui/keybindings/KeybindingProviderSetup.js";
import { AgenCPermissionOverlay, type PendingRequest } from "../../src/tui/permission-requests.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";

it.each(["Edit", "Write"])("pages the complete %s approval diff without approving from the pager", async toolName => {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 180, rows: 50, isTTY: true });
  let output = "";
  stdout.on("data", chunk => { output += stripAnsi(String(chunk)); });
  const decisions: unknown[] = [];
  const content = Array.from({ length: 80 }, (_, index) => `diff-row-${index}`).join("\n");
  const request: PendingRequest = {
    id: "full-diff", input: { file_path: "fixture.txt", ...(toolName === "Edit" ? { old_string: "before", new_string: content } : { content }) },
    description: "fixture change", ctx: { callId: "full-diff", toolName, turnId: "turn", fileWritePreview: { kind: "missing" } } as PendingRequest["ctx"],
    resolve: decision => { decisions.push(decision); },
  };
  const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false });
  const tick = () => new Promise(resolve => setTimeout(resolve, 50));
  try {
    root.render(<AppStateProvider initialState={getDefaultAppState()}><KeybindingSetup configStore={new ConfigStore({ env: {} })}><AgenCPermissionOverlay request={request} tools={[{ name: toolName }]} /></KeybindingSetup></AppStateProvider>);
    await tick();
    stdin.write("\x17d"); await tick();
    instances.get(stdout as unknown as NodeJS.WriteStream)?.forceRedraw(); await tick();
    expect(output.replace(/\s/g, "")).toContain("FULLAPPROVALDIFF");
    stdin.write("G"); await tick();
    instances.get(stdout as unknown as NodeJS.WriteStream)?.forceRedraw(); await tick();
    expect(output).toContain("diff-row-79");
    stdin.write("\r"); await tick();
    expect(decisions).toEqual([]);
    stdin.write("\r"); await tick();
    expect(decisions).toEqual([{ kind: "approved" }]);
  } finally { root.unmount(); stdin.end(); stdout.end(); }
});
