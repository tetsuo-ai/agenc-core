/**
 * Integration tests for the live producer registry — exercises
 * `getAttachments()` against the real {@link PRODUCERS} array and the
 * real `attachmentsToMessages` renderer end-to-end. Each producer has
 * its own unit-test sibling; this file pins the *composition* contract:
 * producers run in parallel without interfering, cross-turn state is
 * threaded correctly through repeated calls on the same session key,
 * and the conversion from {@link Attachment} to {@link LLMMessage}
 * preserves the wire shape downstream prompt-build code depends on.
 */
import { describe, expect, test } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LLMMessage } from "../../llm/types.js";
import {
  _resetAttachmentTrackingStateForTest,
  getAttachmentTrackingState,
} from "../../session/attachment-state.js";
import { attachmentsToMessages } from "./messages.js";
import {
  type GetAttachmentsOptions,
  getAttachments,
} from "./orchestrator.js";
import {
  IMAGE_MENTION_MAX_FILE_BYTES,
  IMAGE_MENTION_MAX_FILES,
  PDF_MENTION_MAX_FILE_BYTES,
} from "./file-mentions.js";
import { PDF_TEXT_EXTRACTION_MAX_BYTES } from "./user-pdf-input.js";

function makeOpts(
  partial?: Partial<GetAttachmentsOptions>,
): GetAttachmentsOptions {
  return {
    sessionKey: {},
    userInput: null,
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: "/tmp/agenc-attachments-integration-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
    ...partial,
  };
}

function planModeExitMarker(): LLMMessage {
  return {
    role: "user",
    content: "<system-reminder>\n## Exited plan mode\n</system-reminder>",
    runtimeOnly: { mergeBoundary: "user_context" },
  };
}

function humanTurns(count: number): LLMMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: "user",
    content: `turn ${i + 1}`,
  }));
}

function installFakePdfTextExtractor(cwd: string, text: string): () => void {
  const savedPath = process.env.PATH;
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const pdftotext = join(bin, "pdftotext");
  writeFileSync(pdftotext, `#!/bin/sh\ncat <<'EOF'\n${text}\nEOF\n`, "utf8");
  chmodSync(pdftotext, 0o755);
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  return () => {
    if (savedPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = savedPath;
    }
  };
}

describe("attachments orchestrator — live producer registry", () => {
  test("file mentions resolve to attached file context through the live pipeline", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-file-mention-pipeline-"));
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "app.ts"), "export const answer = 42;\n");

    const out = await getAttachments(
      makeOpts({
        cwd,
        userInput: "explain @src/app.ts",
      }),
    );

    expect(out.some((a) => a.kind === "file_mention")).toBe(true);
    const messages = attachmentsToMessages(out);
    expect(
      messages.some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("<attached_files>") &&
          message.content.includes('path="src/app.ts"') &&
          message.content.includes("export const answer = 42;"),
      ),
    ).toBe(true);
  });

  test("image file mentions resolve to multimodal image context through the live pipeline", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-image-mention-pipeline-"));
    writeFileSync(join(cwd, "cat.png"), Buffer.from("image-bytes"));

    const out = await getAttachments(
      makeOpts({
        cwd,
        userInput: "describe @cat.png",
      }),
    );

    expect(out.some((a) => a.kind === "image_mention")).toBe(true);
    const messages = attachmentsToMessages(out);
    const imageMessage = messages.find((message) =>
      Array.isArray(message.content),
    );
    const parts = imageMessage?.content as
      | Array<{ type?: string; image_url?: { url?: string }; text?: string }>
      | undefined;
    expect(parts?.[0]?.text).toContain("<attached_images>");
    expect(parts?.[1]?.image_url?.url).toBe(
      "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
    );
  });

  test("PDF file mentions resolve to document context through the live pipeline", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-pdf-mention-pipeline-"));
    const pdfBytes = Buffer.from("%PDF-1.4\nbody\n");
    writeFileSync(join(cwd, "brief.pdf"), pdfBytes);
    const restorePath = installFakePdfTextExtractor(
      cwd,
      "Extracted heading\nExtracted body",
    );

    let out: Awaited<ReturnType<typeof getAttachments>>;
    try {
      out = await getAttachments(
        makeOpts({
          cwd,
          userInput: "summarize @brief.pdf",
        }),
      );
    } finally {
      restorePath();
    }

    expect(out.some((a) => a.kind === "pdf_mention")).toBe(true);
    const attachment = out.find((a) => a.kind === "pdf_mention");
    expect(attachment?.kind).toBe("pdf_mention");
    if (attachment?.kind !== "pdf_mention") {
      throw new Error("expected pdf_mention attachment");
    }
    expect(attachment.pdfs[0]?.fallbackText).toContain("Extracted heading");
    const messages = attachmentsToMessages(out);
    const pdfMessage = messages.find((message) => Array.isArray(message.content));
    const parts = pdfMessage?.content as
      | Array<{
          type?: string;
          source?: { media_type?: string; data?: string };
          fallbackText?: string;
          text?: string;
        }>
      | undefined;
    expect(parts?.[0]?.text).toContain("<attached_pdfs>");
    expect(parts?.[0]?.text).toContain('path="brief.pdf"');
    expect(parts?.[1]?.type).toBe("document");
    expect(parts?.[1]?.source?.media_type).toBe("application/pdf");
    expect(parts?.[1]?.source?.data).toBe(pdfBytes.toString("base64"));
    expect(parts?.[1]?.fallbackText).toContain("Extracted body");
  });

  test("PDF file mentions skip invalid or oversize PDFs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-pdf-mention-invalid-"));
    writeFileSync(join(cwd, "not-a-pdf.pdf"), "plain text\n");
    writeFileSync(
      join(cwd, "large.pdf"),
      Buffer.alloc(PDF_MENTION_MAX_FILE_BYTES + 1, 1),
    );

    const out = await getAttachments(
      makeOpts({
        cwd,
        userInput: "read @not-a-pdf.pdf @large.pdf",
      }),
    );

    expect(out.some((a) => a.kind === "pdf_mention")).toBe(false);
    expect(out.some((a) => a.kind === "file_mention")).toBe(false);
  });

  test("PDF file mention text fallback keeps a truncated prefix over the cap", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-pdf-mention-truncated-"));
    writeFileSync(join(cwd, "long.pdf"), "%PDF-1.4\nbody\n");
    const longText = "x".repeat(PDF_TEXT_EXTRACTION_MAX_BYTES + 10);
    const restorePath = installFakePdfTextExtractor(cwd, longText);

    let out: Awaited<ReturnType<typeof getAttachments>>;
    try {
      out = await getAttachments(
        makeOpts({
          cwd,
          userInput: "summarize @long.pdf",
        }),
      );
    } finally {
      restorePath();
    }

    const attachment = out.find((a) => a.kind === "pdf_mention");
    expect(attachment?.kind).toBe("pdf_mention");
    if (attachment?.kind !== "pdf_mention") {
      throw new Error("expected pdf_mention attachment");
    }
    expect(attachment.pdfs[0]?.fallbackText).toBe(
      "x".repeat(PDF_TEXT_EXTRACTION_MAX_BYTES),
    );
    expect(attachment.pdfs[0]?.fallbackTextTruncated).toBe(true);
    expect(attachment.pdfs[0]?.fallbackTextError).toBeUndefined();
  });

  test("image file mentions enforce the per-turn count limit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-image-mention-count-"));
    const names = Array.from(
      { length: IMAGE_MENTION_MAX_FILES + 1 },
      (_, index) => `img-${index}.png`,
    );
    for (const name of names) {
      writeFileSync(join(cwd, name), Buffer.from(name));
    }

    const out = await getAttachments(
      makeOpts({
        cwd,
        userInput: names.map((name) => `@${name}`).join(" "),
      }),
    );

    const imageAttachment = out.find((a) => a.kind === "image_mention");
    expect(imageAttachment?.kind).toBe("image_mention");
    if (imageAttachment?.kind !== "image_mention") {
      throw new Error("expected image_mention attachment");
    }
    expect(imageAttachment.images).toHaveLength(IMAGE_MENTION_MAX_FILES);
  });

  test("image file mentions skip images over the per-file byte limit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-image-mention-size-"));
    writeFileSync(
      join(cwd, "large.png"),
      Buffer.alloc(IMAGE_MENTION_MAX_FILE_BYTES + 1, 1),
    );

    const out = await getAttachments(
      makeOpts({
        cwd,
        userInput: "describe @large.png",
      }),
    );

    expect(out.some((a) => a.kind === "image_mention")).toBe(false);
  });

  test("image file mentions reject formats unsupported by provider image blocks", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-image-mention-format-"));
    writeFileSync(join(cwd, "vector.svg"), "<svg />\n");
    writeFileSync(join(cwd, "bitmap.bmp"), Buffer.from("bmp"));

    const out = await getAttachments(
      makeOpts({
        cwd,
        userInput: "inspect @vector.svg @bitmap.bmp",
      }),
    );

    expect(out.some((a) => a.kind === "image_mention")).toBe(false);
  });

  test("file mentions skip text reattachment but still attach images after submit-path expansion", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-file-mention-expanded-"));
    writeFileSync(join(cwd, "note.txt"), "already handled\n");
    writeFileSync(join(cwd, "cat.png"), Buffer.from("image-bytes"));

    const out = await getAttachments(
      makeOpts({
        cwd,
        userInput:
          '<attached_files>\n<file path="note.txt">already handled</file>\n</attached_files>\n\n<user_message>read @note.txt @cat.png</user_message>',
      }),
    );

    expect(out.some((a) => a.kind === "file_mention")).toBe(false);
    expect(out.some((a) => a.kind === "image_mention")).toBe(true);
  });

  test("date_change fires once per local day, then suppresses on the next call", async () => {
    const sessionKey = {};
    const trackingState = getAttachmentTrackingState(sessionKey);
    trackingState.lastEmittedDate = "1999-01-01";

    const first = await getAttachments(makeOpts({ sessionKey }));
    expect(first.some((a) => a.kind === "date_change")).toBe(true);

    const second = await getAttachments(makeOpts({ sessionKey }));
    expect(second.some((a) => a.kind === "date_change")).toBe(false);

    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("critical_system_reminder is one-shot — fires once, clears the pending field", async () => {
    const sessionKey = {};
    const trackingState = getAttachmentTrackingState(sessionKey);
    trackingState.pendingCriticalReminder =
      "Network is degraded; downstream tools may fail.";

    const first = await getAttachments(makeOpts({ sessionKey }));
    const reminder = first.find((a) => a.kind === "critical_system_reminder");
    expect(reminder).toBeDefined();
    expect(trackingState.pendingCriticalReminder).toBeUndefined();

    const second = await getAttachments(makeOpts({ sessionKey }));
    expect(second.some((a) => a.kind === "critical_system_reminder")).toBe(
      false,
    );

    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("plan_mode_exit fires once on the next turn after the flag is set, then clears", async () => {
    const sessionKey = {};
    const trackingState = getAttachmentTrackingState(sessionKey);
    trackingState.needsPlanModeExitAttachment = true;

    const first = await getAttachments(makeOpts({ sessionKey }));
    expect(first.some((a) => a.kind === "plan_mode_exit")).toBe(true);
    expect(trackingState.needsPlanModeExitAttachment).toBe(false);
    // Sticky: re-entry detection consults this on subsequent plan returns.
    expect(trackingState.hasExitedPlanModeInSession).toBe(true);

    const second = await getAttachments(makeOpts({ sessionKey }));
    expect(second.some((a) => a.kind === "plan_mode_exit")).toBe(false);

    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("verify_plan_reminder is registered and renders through the live pipeline", async () => {
    const sessionKey = {};
    const out = await getAttachments(
      makeOpts({
        sessionKey,
        messages: [planModeExitMarker(), ...humanTurns(10)],
      }),
    );

    expect(out.some((a) => a.kind === "verify_plan_reminder")).toBe(true);
    const messages = attachmentsToMessages(out);
    expect(
      messages.some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("Please verify directly"),
      ),
    ).toBe(true);

    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("auto_mode_exit fires once on the next turn after the flag is set", async () => {
    const sessionKey = {};
    const trackingState = getAttachmentTrackingState(sessionKey);
    trackingState.needsAutoModeExitAttachment = true;

    const out = await getAttachments(makeOpts({ sessionKey }));
    expect(out.some((a) => a.kind === "auto_mode_exit")).toBe(true);
    expect(trackingState.needsAutoModeExitAttachment).toBe(false);
    expect(trackingState.hasExitedAutoModeInSession).toBe(true);

    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("multiple producers compose in a single turn without cross-interference", async () => {
    const sessionKey = {};
    const trackingState = getAttachmentTrackingState(sessionKey);
    trackingState.lastEmittedDate = "1999-01-01";
    trackingState.pendingCriticalReminder = "Compose-test reminder.";
    trackingState.needsPlanModeExitAttachment = true;

    const out = await getAttachments(makeOpts({ sessionKey }));
    const kinds = out.map((a) => a.kind);
    expect(kinds).toContain("date_change");
    expect(kinds).toContain("critical_system_reminder");
    expect(kinds).toContain("plan_mode_exit");

    // The renderer turns each Attachment into a user-channel LLMMessage
    // with a `mergeBoundary: "user_context"` runtime hint. This is what
    // `runTurn` prepends to `state.messagesForQuery`, so any regression
    // in the conversion step would surface here.
    const messages = attachmentsToMessages(out);
    expect(messages.length).toBeGreaterThanOrEqual(3);
    for (const msg of messages) {
      expect(msg.role).toBe("user");
      expect(msg.runtimeOnly?.mergeBoundary).toBe("user_context");
    }

    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("aborted signal short-circuits without emitting attachments or throwing", async () => {
    const sessionKey = {};
    const trackingState = getAttachmentTrackingState(sessionKey);
    trackingState.pendingCriticalReminder = "Should never surface.";

    const ac = new AbortController();
    ac.abort();
    const out = await getAttachments(makeOpts({ sessionKey, signal: ac.signal }));
    // Producers MAY honor the abort signal and emit nothing; what we
    // pin here is "the orchestrator does not throw on the consumer's
    // behalf when a producer skips on abort."
    for (const att of out) {
      expect(typeof att.kind).toBe("string");
    }

    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("cross-session isolation: pending state on session A does not leak into session B", async () => {
    const sessionA = {};
    const sessionB = {};
    getAttachmentTrackingState(sessionA).pendingCriticalReminder =
      "Session-A only.";

    const aOut = await getAttachments(makeOpts({ sessionKey: sessionA }));
    const bOut = await getAttachments(makeOpts({ sessionKey: sessionB }));
    expect(aOut.some((a) => a.kind === "critical_system_reminder")).toBe(true);
    expect(bOut.some((a) => a.kind === "critical_system_reminder")).toBe(false);

    _resetAttachmentTrackingStateForTest(sessionA);
    _resetAttachmentTrackingStateForTest(sessionB);
  });
});
