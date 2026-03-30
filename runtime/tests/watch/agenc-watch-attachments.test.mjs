import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createQueuedWatchAttachment,
  formatQueuedWatchAttachments,
  normalizeWatchAttachmentInputPath,
  resolveWatchAttachmentInputPath,
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

test("createQueuedWatchAttachment accepts shell-escaped macOS drag paths with spaces", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-watch-attach-"));
  const filePath = path.join(workspaceRoot, "Screen Shot.png");
  fs.writeFileSync(filePath, Buffer.from([0, 1, 2, 3]));

  try {
    const attachment = createQueuedWatchAttachment({
      fs,
      inputPath: path.join(workspaceRoot, "Screen\\ Shot.png"),
      projectRoot: workspaceRoot,
      id: "att-1",
    });

    assert.equal(attachment.filename, "Screen Shot.png");
    assert.equal(attachment.mimeType, "image/png");
    assert.equal(attachment.type, "image");
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("resolveWatchAttachmentInputPath normalizes quoted file URLs", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-watch-attach-"));
  const filePath = path.join(workspaceRoot, "Screen Shot.png");
  fs.writeFileSync(filePath, Buffer.from([0, 1, 2, 3]));

  try {
    const fileUrl = `"file://${filePath.replace(/ /g, "%20")}"`;
    assert.equal(
      normalizeWatchAttachmentInputPath(fileUrl),
      filePath,
    );
    assert.equal(
      resolveWatchAttachmentInputPath({
        fs,
        inputPath: fileUrl,
        projectRoot: workspaceRoot,
      }),
      filePath,
    );
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("normalizeWatchAttachmentInputPath strips trailing drag status text from local file paths", () => {
  const screenshotPath = "/var/folders/xx/yy/T/NSIRD_screencaptureui_ABC123/Screenshot 2026-03-30 at 18.42.57.png";

  assert.equal(
    normalizeWatchAttachmentInputPath(`${screenshotPath} read`),
    screenshotPath,
  );
});

test("resolveWatchAttachmentInputPath accepts likely local screenshot temp paths before the file exists", () => {
  const screenshotPath = "/var/folders/xx/yy/T/NSIRD_screencaptureui_ABC123/Screenshot";

  assert.equal(
    resolveWatchAttachmentInputPath({
      fs,
      inputPath: screenshotPath,
      projectRoot: "/Users/pchmirenko/agenc-core-pr72-tui-grok",
    }),
    screenshotPath,
  );
  assert.equal(
    resolveWatchAttachmentInputPath({
      fs,
      inputPath: "/permissions",
      projectRoot: "/Users/pchmirenko/agenc-core-pr72-tui-grok",
    }),
    null,
  );
});

test("createQueuedWatchAttachment can queue a missing local path when allowMissing is enabled", () => {
  const attachment = createQueuedWatchAttachment({
    fs,
    inputPath: "/var/folders/xx/yy/T/NSIRD_screencaptureui_ABC123/Screenshot",
    projectRoot: "/Users/pchmirenko/agenc-core-pr72-tui-grok",
    id: "att-1",
    allowMissing: true,
  });

  assert.equal(attachment.id, "att-1");
  assert.equal(attachment.filename, "Screenshot");
  assert.equal(attachment.displayPath, "/var/folders/xx/yy/T/NSIRD_screencaptureui_ABC123/Screenshot");
  assert.equal(attachment.missing, true);
  assert.equal(attachment.sizeBytes, null);
});

test("createQueuedWatchAttachment drops trailing drag status text before queueing a missing path", () => {
  const screenshotPath = "/var/folders/xx/yy/T/NSIRD_screencaptureui_ABC123/Screenshot 2026-03-30 at 18.42.57.png";
  const attachment = createQueuedWatchAttachment({
    fs,
    inputPath: `${screenshotPath} read`,
    projectRoot: "/Users/pchmirenko/agenc-core-pr72-tui-grok",
    id: "att-1",
    allowMissing: true,
  });

  assert.equal(attachment.filename, "Screenshot 2026-03-30 at 18.42.57.png");
  assert.equal(attachment.displayPath, screenshotPath);
  assert.equal(attachment.path, screenshotPath);
  assert.equal(attachment.missing, true);
});

test("normalizeWatchAttachmentInputPath preserves trailing read in names without a file extension", () => {
  const notePath = "/tmp/meeting read";

  assert.equal(
    normalizeWatchAttachmentInputPath(notePath),
    notePath,
  );
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
