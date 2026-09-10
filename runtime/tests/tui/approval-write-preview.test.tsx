import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalCtx } from "../../src/tools/orchestrator.js";
import { AgenCPermissionOverlay, type PendingRequest } from "../../src/tui/permission-requests.js";
import { renderToString } from "../../src/utils/staticRender.js";

vi.mock("../../src/tui/ink.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/tui/ink.js")>(),
  useInput: () => {},
}));

function writeRequest(fileWritePreview?: ApprovalCtx["fileWritePreview"]): PendingRequest {
  const input = { file_path: "bookmarks.mjs", content: "replacement\n" };
  return {
    id: "overwrite-request",
    ctx: {
      callId: "overwrite-request",
      toolName: "Write",
      turnId: "turn-1",
      fileWritePreview,
      invocation: { payload: { kind: "function", arguments: JSON.stringify(input) } },
    } as unknown as ApprovalCtx,
    input,
    description: "Permission required to write bookmarks.mjs",
    resolve() {},
  };
}

async function renderWrite(request: PendingRequest): Promise<string> {
  return renderToString(<AgenCPermissionOverlay request={request} tools={[{ name: "Write" }]} />, {
    columns: 120,
    rows: 45,
  });
}

describe("authoritative Write approval preview", () => {
  it("shows removed content and labels an overwrite EDIT", async () => {
    const rendered = await renderWrite(writeRequest({ kind: "existing", content: "original first\noriginal second\n" }));
    expect(rendered).toContain("EDIT");
    expect(rendered).not.toContain("CREATE");
    expect(rendered).toContain("+1 -2");
    expect(rendered).toContain("original first");
    expect(rendered).toContain("original second");
    expect(rendered).toContain("replacement");
  });

  it("labels an empty existing file EDIT rather than CREATE", async () => {
    const rendered = await renderWrite(writeRequest({ kind: "existing", content: "" }));
    expect(rendered).toContain("EDIT");
    expect(rendered).not.toContain("CREATE");
  });

  it("labels a daemon-confirmed missing file CREATE", async () => {
    const rendered = await renderWrite(writeRequest({ kind: "missing" }));
    expect(rendered).toContain("CREATE");
    expect(rendered).toContain("+1 -0");
  });

  it.each([undefined, { kind: "unavailable" as const, reason: "Read access requires approval." }])("never fabricates a new-file diff when old content is unavailable", async (preview) => {
    const rendered = await renderWrite(writeRequest(preview));
    expect(rendered).toContain("Existing content unavailable");
    expect(rendered).not.toContain("CREATE");
    expect(rendered).not.toContain("+1 -0");
    expect(rendered).toContain("approve once");
  });
});
