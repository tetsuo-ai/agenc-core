import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, expect, test, vi } from "vitest";

import * as auth from "../../src/utils/auth.js";
import { withOAuth401Retry } from "../../src/utils/http.js";
import { loadMcpbFile } from "../../src/utils/plugins/mcpbHandler.js";
import { resolveSecureStorageHome } from "../../src/utils/secureStorage/home.js";

afterEach(() => vi.restoreAllMocks());

test.each([
  [401, undefined, undefined],
  [403, "OAuth token has been revoked", { also403Revoked: true }],
])("refreshes a classified OAuth %i once after loading axios", async (status, data, options) => {
  const home = resolveSecureStorageHome();
  const environment = Object.freeze({ AGENC_OAUTH_TOKEN: "session-token" });
  const refresh = vi.spyOn(auth, "handleOAuth401Error").mockResolvedValue(true);
  const error = Object.assign(new Error("unauthorized"), { isAxiosError: true, response: { status, data } });
  const request = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("retried");
  await expect(withOAuth401Retry(home, environment, request, options)).resolves.toBe("retried");
  expect(refresh).toHaveBeenCalledExactlyOnceWith(home, "session-token", environment);
  expect(request).toHaveBeenCalledTimes(2);
});

test("preserves the second failure without a second refresh", async () => {
  const home = resolveSecureStorageHome();
  const environment = Object.freeze({ AGENC_OAUTH_TOKEN: "session-token" });
  const refresh = vi.spyOn(auth, "handleOAuth401Error").mockResolvedValue(true);
  const error = Object.assign(new Error("unauthorized"), { isAxiosError: true, response: { status: 401 } });
  const request = vi.fn().mockRejectedValue(error);
  await expect(withOAuth401Retry(home, environment, request)).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test("downloads and validates an MCP bundle through the deferred client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agenc-deferred-mcpb-"));
  const manifest = {
    manifest_version: "0.4", name: "sample-extension", version: "1.0.0",
    description: "Sample extension", author: { name: "Example" },
    server: { type: "node", entry_point: "server.js", mcp_config: { command: "node", args: ["${__dirname}/server.js"] } },
  };
  const source = "console.log('example');\n";
  const archive = zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)), "server.js": strToU8(source) });
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": archive.length });
    response.end(archive);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");
    const progress: string[] = [];
    const result = await loadMcpbFile(`http://127.0.0.1:${address.port}/sample.mcpb`, directory, "sample@example", (message) => progress.push(message));
    expect(result.manifest.name).toBe("sample-extension");
    expect(await readFile(join(result.extractedPath, "server.js"), "utf8")).toBe(source);
    expect(requests).toEqual(["/sample.mcpb"]);
    expect(progress).toContain("Download complete");
    expect(result).toHaveProperty("mcpConfig.command", "node");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
