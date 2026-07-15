import assert from "node:assert/strict";
import test from "node:test";

import { assertReleaseVersionAvailable } from "../../../scripts/check-release-version-available.mjs";

function response(status, url) {
  return {
    status,
    url: String(url),
    body: { cancel: async () => {} },
  };
}

test("release preflight accepts only explicit absence from every canonical public namespace", async () => {
  const calls = [];
  const result = await assertReleaseVersionAvailable({
    version: "1.2.3",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return response(calls.length <= 2 ? 200 : 404, url);
    },
  });
  assert.deepEqual(result, {
    version: "1.2.3",
    tag: "agenc-v1.2.3",
    publicRepositories: 2,
    absentNamespaces: 4,
  });
  assert.deepEqual(calls.map(({ url }) => url), [
    "https://api.github.com/repos/tetsuo-ai/agenc-core",
    "https://api.github.com/repos/tetsuo-ai/agenc-releases",
    "https://registry.npmjs.org/%40tetsuo-ai%2Fagenc/1.2.3",
    "https://api.github.com/repos/tetsuo-ai/agenc-core/git/ref/tags/agenc-v1.2.3",
    "https://api.github.com/repos/tetsuo-ai/agenc-releases/git/ref/tags/agenc-v1.2.3",
    "https://api.github.com/repos/tetsuo-ai/agenc-releases/releases/tags/agenc-v1.2.3",
  ]);
  for (const { options } of calls) assert.equal(options.redirect, "error");
});

test("release preflight rejects existing versions and every inconclusive response", async () => {
  for (const status of [200, 401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(
      assertReleaseVersionAvailable({
        version: "1.2.3",
        fetchImpl: async (url) => response(++calls <= 2 ? 200 : status, url),
      }),
      status === 200 ? /already exists/ : new RegExp(`inconclusive: HTTP ${status}`),
    );
  }
  await assert.rejects(
    assertReleaseVersionAvailable({
      version: "1.2.3",
      fetchImpl: async () => { throw new Error("dns failed"); },
    }),
    /public-visibility check is inconclusive/,
  );
  await assert.rejects(
    assertReleaseVersionAvailable({
      version: "1.2.3",
      fetchImpl: async (url) => response(404, url),
    }),
    /must be publicly visible before release preflight: HTTP 404/,
  );
  await assert.rejects(
    assertReleaseVersionAvailable({ version: "01.2.3", fetchImpl: async () => response(404, "") }),
    /not stable canonical semver/,
  );
});
