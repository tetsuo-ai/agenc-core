import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createQueuedWatchAttachment,
  formatQueuedWatchAttachments,
  resolveQueuedWatchAttachmentPayloads,
} from "../../src/watch/agenc-watch-attachments.mjs";

test("createQueuedWatchAttachment resolves project-relative files with mime metadata", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-watch-attach-"));
  const filePath = path.join(workspaceRoot, "notes.md");
  fs.writeFileSync(filePath, "# hello\n");

  try {
    const attachment = createQueuedWatchAttachment({
      fs,
      inputPath: "./notes.md",
      projectRoot: workspaceRoot,
      id: "att-1",
    });

    assert.equal(attachment.id, "att-1");
    assert.equal(attachment.filename, "notes.md");
    assert.equal(attachment.mimeType, "text/markdown");
    assert.equal(attachment.type, "file");
    assert.equal(attachment.displayPath, "notes.md");
    assert.equal(attachment.sizeBytes > 0, true);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("resolveQueuedWatchAttachmentPayloads encodes base64 payloads", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-watch-attach-"));
  const filePath = path.join(workspaceRoot, "diagram.png");
  fs.writeFileSync(filePath, Buffer.from([0, 1, 2, 3]));

  try {
    const attachment = createQueuedWatchAttachment({
      fs,
      inputPath: "./diagram.png",
      projectRoot: workspaceRoot,
      id: "att-1",
    });
    const payloads = resolveQueuedWatchAttachmentPayloads([attachment], { fs });

    assert.deepEqual(payloads, [{
      type: "image",
      mimeType: "image/png",
      filename: "diagram.png",
      sizeBytes: 4,
      data: Buffer.from([0, 1, 2, 3]).toString("base64"),
    }]);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("formatQueuedWatchAttachments produces a numbered list", () => {
  const text = formatQueuedWatchAttachments([
    {
      id: "att-1",
      filename: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      displayPath: "assets/diagram.png",
    },
  ]);

  assert.match(text, /^1\. diagram\.png \[att-1\]/);
  assert.match(text, /image\/png/);
  assert.match(text, /assets\/diagram\.png/);
});
