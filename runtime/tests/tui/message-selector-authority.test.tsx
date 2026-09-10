import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { MessageSelector, buildMessageSelectorFileHistoryMetadata } from "../../src/tui/components/MessageSelector.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import { createRoot } from "../../src/tui/ink.js";
import { enterCanonicalSettingsAuthority, getCanonicalSettingsAuthority, resetCanonicalSettingsAuthorityForTesting } from "../../src/utils/settings/canonicalAuthority.js";
import type { UserMessage } from "../../src/types/message.js";

const message = { type: "user", uuid: "message-one", timestamp: "2026-09-10T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "Make a file" }] } } as UserMessage;

describe("message selector daemon authority", () => {
  it("loads only visible daemon rows and discards results from a replaced preview", async () => {
    const initialState = getDefaultAppState();
    const messages = Array.from({ length: 20 }, (_, index) => ({ ...message, uuid: `message-${index}` })) as UserMessage[];
    const pending: Array<(value: { filesChanged: string[]; insertions: number; deletions: number }) => void> = [];
    const oldPreview = vi.fn(() => new Promise<{ filesChanged: string[]; insertions: number; deletions: number }>(resolve => { pending.push(resolve); }));
    const newPreview = vi.fn(async () => ({ filesChanged: ["/tmp/current-preview.ts"], insertions: 4, deletions: 0 }));
    const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40 });
    let output = "";
    stdout.on("data", chunk => { output += chunk.toString(); });
    const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false });
    const renderPreview = (preview: typeof oldPreview | typeof newPreview) => root.render(
      <AppStateProvider initialState={initialState}>
        <MessageSelector messages={messages} onPreviewRewind={preview} onPreRestore={() => {}}
          onRestoreMessage={async () => {}} onRestoreCode={async () => {}}
          onSummarize={async () => {}} onClose={() => {}} />
      </AppStateProvider>,
    );
    try {
      renderPreview(oldPreview);
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(oldPreview.mock.calls.length).toBeGreaterThan(0);
      expect(oldPreview.mock.calls.length).toBeLessThanOrEqual(7);
      renderPreview(newPreview);
      await new Promise(resolve => setTimeout(resolve, 40));
      for (const resolve of pending) resolve({ filesChanged: ["/tmp/stale-preview.ts"], insertions: 1, deletions: 0 });
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(output).toContain("current-preview.ts");
      expect(output).not.toContain("stale-preview.ts");
      expect(output).not.toContain("ERROR");
    } finally {
      root.unmount(); stdin.end(); stdout.end();
    }
  });

  it("derives local snapshot metadata without ambient execution settings", () => {
    const previous = getCanonicalSettingsAuthority();
    resetCanonicalSettingsAuthorityForTesting();
    try {
      const metadata = buildMessageSelectorFileHistoryMetadata({
        messageOptions: [message], messages: [message], currentUUID: "current" as never,
        fileHistory: { snapshots: [{ messageId: message.uuid }] } as never,
        isFileHistoryEnabled: true,
      });
      expect(metadata[message.uuid]).toEqual({ filesChanged: [], insertions: 0, deletions: 0 });
    } finally {
      if (previous !== null) enterCanonicalSettingsAuthority(previous);
    }
  });

  it("treats an undefined daemon preview as authoritative without local fallback", async () => {
    const initialState = getDefaultAppState();
    const previous = getCanonicalSettingsAuthority();
    const preview = vi.fn(async () => undefined);
    const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 35 });
    let output = "";
    stdout.on("data", chunk => { output += chunk.toString(); });
    resetCanonicalSettingsAuthorityForTesting();
    const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false });
    try {
      root.render(<AppStateProvider initialState={initialState}>
        <MessageSelector messages={[message]} preselectedMessage={message} onPreviewRewind={preview}
          onPreRestore={() => {}} onRestoreMessage={async () => {}} onRestoreCode={async () => {}}
          onSummarize={async () => {}} onClose={() => {}} />
      </AppStateProvider>);
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(preview).toHaveBeenCalledWith(message);
      expect(output).not.toContain("Canonical settings authority");
      expect(output).toContain("Restore conversation");
      expect(output).not.toContain("Restore code and conversation");
    } finally {
      root.unmount(); stdin.end(); stdout.end();
      if (previous !== null) enterCanonicalSettingsAuthority(previous);
    }
  });
});
