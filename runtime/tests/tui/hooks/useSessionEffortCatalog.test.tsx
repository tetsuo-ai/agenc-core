import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createRoot } from "../../../src/tui/ink/root.js";
import { useSessionEffortCatalog } from "../../../src/tui/hooks/useSessionEffortCatalog.js";
import type { SlashCommandContext } from "../../../src/commands/types.js";
import { recordPublishedModelCatalog, clearPublishedModelCatalogs } from "../../../src/llm/registry/published-model-catalog.js";
import { parseVeniceModels, veniceCatalogEntry } from "../../../src/llm/registry/venice-models.js";
import { getSessionEffortLabelForContext } from "../../../src/utils/effort.js";
const loader = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../../../src/commands/live-model-catalog.js", () => ({ ensureLiveModelCatalog: loader.load }));
afterEach(() => { clearPublishedModelCatalogs(); vi.clearAllMocks(); });

test("a newly selected Venice model gains its effort label without opening a menu", async () => {
  let publish!: () => void;
  loader.load.mockImplementation(() => new Promise<void>(resolve => { publish = resolve; }));
  const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
  const stdout = new PassThrough(); stdout.resume();
  const root = await createRoot({ patchConsole: false, stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream });
  const ctx = { session: {} } as SlashCommandContext;
  let label: string | null = null;
  function Probe() {
    useSessionEffortCatalog(ctx.session, "venice", "new-venice-effort", () => ctx);
    label = getSessionEffortLabelForContext("new-venice-effort", undefined, { provider: "venice" } as never);
    return null;
  }
  try {
    root.render(<Probe />);
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce());
    expect(label).toBeNull();
    const rows = parseVeniceModels({ data: [{ id: "new-venice-effort", type: "text", model_spec: { capabilities: {
      supportsFunctionCalling: true, supportsReasoning: true, supportsReasoningEffort: true,
      reasoningEffortOptions: ["none", "low", "high"], defaultReasoningEffort: "low",
    } } }] });
    recordPublishedModelCatalog("venice", rows.map(veniceCatalogEntry));
    publish();
    await vi.waitFor(() => expect(label).toBe("low effort"));
    root.render(<Probe />);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(loader.load).toHaveBeenCalledOnce();
  } finally { root.unmount(); stdin.end(); stdout.end(); }
});
