import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalCtx } from "../../src/tools/orchestrator.js";
import { approvalInputText } from "../../src/tui/approval-input-text.js";
import { AgenCPermissionOverlay, type PendingRequest } from "../../src/tui/permission-requests.js";
import { renderToString } from "../../src/utils/staticRender.js";

vi.mock("../../src/tui/ink.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/tui/ink.js")>(),
  useInput: () => {},
}));

// The approval card used to show the URL exactly as the model wrote it, so
// `https://аmazon.com/login` (Cyrillic `а`) read as amazon.com while the fetch
// went to `xn--mazon-3ve.com`, and "approve for session" saved a rule for it.

const FAKE_AMAZON = "https://аmazon.com/login";

function fetchRequest(url: string): PendingRequest {
  const input = { url };
  return {
    id: "fetch-request",
    ctx: {
      callId: "fetch-request",
      toolName: "web_fetch",
      turnId: "turn-1",
      invocation: { payload: { kind: "function", arguments: JSON.stringify(input) } },
    } as unknown as ApprovalCtx,
    input,
    description: "Permission required to use web_fetch",
    resolve() {},
  };
}

async function renderFetch(url: string): Promise<string> {
  return renderToString(
    <AgenCPermissionOverlay request={fetchRequest(url)} tools={[{ name: "web_fetch" }]} />,
    { columns: 120, rows: 45 },
  );
}

describe("approval card for lookalike hosts", () => {
  it("approval input text shows the real host", () => {
    expect(approvalInputText({ url: FAKE_AMAZON }, { prettyJson: true })).toContain(
      "https://xn--mazon-3ve.com/login",
    );
    expect(approvalInputText({ command: `curl ${FAKE_AMAZON}` })).toBe(
      "curl https://xn--mazon-3ve.com/login",
    );
  });

  it("shows the real site and warns about a lookalike", async () => {
    const rendered = await renderFetch(FAKE_AMAZON);
    expect(rendered).toContain("https://xn--mazon-3ve.com/login");
    expect(rendered).not.toContain("аmazon");
    expect(rendered).toContain("SITE");
    expect(rendered).toContain("may imitate another site");
  });

  it("shows the site without a warning for an ordinary host", async () => {
    const rendered = await renderFetch("https://docs.python.org/3/");
    expect(rendered).toContain("SITE");
    expect(rendered).toContain("docs.python.org");
    expect(rendered).not.toContain("may imitate another site");
  });
});
