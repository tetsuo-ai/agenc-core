import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fetchPinnedNpm } from "../../../scripts/fetch-pinned-npm.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agenc-pinned-npm-test-"));
  const bytes = Buffer.from("deterministic pinned npm fixture");
  const file = "npm-11.17.0.tgz";
  const url = `https://registry.npmjs.org/npm/-/${file}`;
  const toolchainPath = join(root, "release-toolchain.json");
  const output = join(root, "npm.tgz");
  writeFileSync(toolchainPath, `${JSON.stringify({
    npmVersion: "11.17.0",
    npmDistribution: { file, url, sha256: sha256(bytes) },
  })}\n`);
  return { root, bytes, file, url, toolchainPath, output };
}

function response(url, chunks, { status = 200, contentLength } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers(contentLength === undefined ? {} : {
      "content-length": String(contentLength),
    }),
    body: stream,
  };
}

test("fetchPinnedNpm writes only exact canonical bytes with an exclusive durable file", async () => {
  const work = fixture();
  try {
    let requested;
    const result = await fetchPinnedNpm({
      output: work.output,
      toolchainPath: work.toolchainPath,
      fetchImpl: async (url, options) => {
        requested = { url: url.href, options };
        return response(url.href, [work.bytes.subarray(0, 7), work.bytes.subarray(7)]);
      },
    });
    assert.deepEqual(requested, { url: work.url, options: { redirect: "error" } });
    assert.deepEqual(readFileSync(work.output), work.bytes);
    assert.equal(result.sha256, sha256(work.bytes));
    assert.equal(result.version, "11.17.0");
    if (process.platform !== "win32") {
      assert.equal(statSync(work.output).mode & 0o777, 0o600);
    }
    await assert.rejects(
      fetchPinnedNpm({
        output: work.output,
        toolchainPath: work.toolchainPath,
        fetchImpl: async () => response(work.url, [work.bytes]),
      }),
      /EEXIST|file already exists/,
    );
    assert.deepEqual(readFileSync(work.output), work.bytes);
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
});

test("fetchPinnedNpm rejects redirects, digest drift, and body length drift without output", async () => {
  const work = fixture();
  try {
    for (const [label, fetchImpl, pattern] of [
      [
        "redirect",
        async () => response("https://objects.example/npm.tgz", [work.bytes]),
        /without redirects/,
      ],
      [
        "digest",
        async () => response(work.url, [Buffer.from("tampered")]),
        /sha256 mismatch/,
      ],
      [
        "length",
        async () => response(work.url, [work.bytes], { contentLength: work.bytes.length + 1 }),
        /byte count is invalid/,
      ],
    ]) {
      await assert.rejects(
        fetchPinnedNpm({ output: work.output, toolchainPath: work.toolchainPath, fetchImpl }),
        pattern,
        label,
      );
      assert.equal(existsSync(work.output), false, label);
    }
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
});

test("fetchPinnedNpm rejects a non-canonical registry contract before network access", async () => {
  const work = fixture();
  try {
    const contract = JSON.parse(readFileSync(work.toolchainPath, "utf8"));
    contract.npmDistribution.url = "https://registry.example/npm.tgz";
    writeFileSync(work.toolchainPath, `${JSON.stringify(contract)}\n`);
    let called = false;
    await assert.rejects(
      fetchPinnedNpm({
        output: work.output,
        toolchainPath: work.toolchainPath,
        fetchImpl: async () => {
          called = true;
          return response(work.url, [work.bytes]);
        },
      }),
      /canonical HTTPS npm registry tarball/,
    );
    assert.equal(called, false);
    assert.equal(existsSync(work.output), false);
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
});
