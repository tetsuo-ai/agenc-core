import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { PLUGIN_ARCHIVE_FETCH_POLICY, resolvePluginSource } from "../../src/plugins/resolution.js";

const roots: string[] = [];
const archiveUrl = "https://plugins.example.test/archive.tgz";

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function resolverOptions() {
  const root = await mkdtemp(join(tmpdir(), "agenc-archive-policy-"));
  roots.push(root);
  const pluginStorageRoot = join(root, "home", "plugins");
  const sessionTempRoot = join(root, "session-tmp");
  await Promise.all([mkdir(pluginStorageRoot, { recursive: true }), mkdir(sessionTempRoot, { recursive: true })]);
  return { agencHome: join(root, "home"), pluginStorageRoot, sessionTempRoot, workspaceRoot: root, requireSignature: false, cache: false };
}

describe("canonical plugin archive fetch policy", () => {
  test("freezes every policy value and nested list", () => {
    expect(Object.isFrozen(PLUGIN_ARCHIVE_FETCH_POLICY)).toBe(true);
    expect(Object.isFrozen(PLUGIN_ARCHIVE_FETCH_POLICY.redirectStatuses)).toBe(true);
    expect(Object.isFrozen(PLUGIN_ARCHIVE_FETCH_POLICY.allowedRedirectProtocols)).toBe(true);
  });

  test.each(PLUGIN_ARCHIVE_FETCH_POLICY.redirectStatuses)("follows a same-origin %s redirect manually", async (status) => {
    const options = await resolverOptions();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status, headers: { location: "/next.tgz" } }))
      .mockResolvedValueOnce(new Response(null, { status: 418 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolvePluginSource(archiveUrl, options)).rejects.toThrow(/failed to fetch plugin archive: 418/u);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith("https://plugins.example.test/next.tgz", expect.objectContaining({ redirect: "manual" }));
  });

  test("allows exactly the canonical number of redirect hops", async () => {
    const options = await resolverOptions();
    let requests = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      requests += 1;
      return requests <= PLUGIN_ARCHIVE_FETCH_POLICY.maxRedirectHops
        ? new Response(null, { status: 301, headers: { location: "/next.tgz" } })
        : new Response(null, { status: 418 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolvePluginSource(archiveUrl, options)).rejects.toThrow(/failed to fetch plugin archive: 418/u);
    expect(fetchMock).toHaveBeenCalledTimes(PLUGIN_ARCHIVE_FETCH_POLICY.maxRedirectHops + 1);
  });

  test("refuses to fetch a hop beyond the canonical redirect limit", async () => {
    const options = await resolverOptions();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 301, headers: { location: "/loop.tgz" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolvePluginSource(archiveUrl, options)).rejects.toThrow(`plugin archive redirect limit exceeded: ${PLUGIN_ARCHIVE_FETCH_POLICY.maxRedirectHops}`);
    expect(fetchMock).toHaveBeenCalledTimes(PLUGIN_ARCHIVE_FETCH_POLICY.maxRedirectHops + 1);
  });

  test.each([
    ["cross-origin", "https://other.example.test/private.tgz", /redirects must stay on/u],
    ["credentials", "https://opaque:secret@plugins.example.test/private.tgz", /URL credentials are not allowed/u],
    ["unsupported protocol", "ftp://plugins.example.test/private.tgz", /unsupported protocol/u],
  ] as const)("rejects %s without fetching the destination", async (_label, location, expectedError) => {
    const options = await resolverOptions();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolvePluginSource(archiveUrl, options)).rejects.toThrow(expectedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, 7])("enforces the default timeout or %s ms override", async (downloadTimeoutMs) => {
    const options = await resolverOptions();
    let notifyFetch!: () => void;
    const fetched = new Promise<void>((resolve) => { notifyFetch = resolve; });
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((_input, init) => {
      signal = init?.signal;
      const response = new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("archive request aborted")), { once: true });
      });
      notifyFetch();
      return response;
    }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const assertion = expect(resolvePluginSource(archiveUrl, { ...options, downloadTimeoutMs })).rejects.toThrow(/archive request aborted/u);
    await fetched;
    await vi.advanceTimersByTimeAsync((downloadTimeoutMs ?? PLUGIN_ARCHIVE_FETCH_POLICY.downloadTimeoutMs) - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await assertion;
  });

  test.each([undefined, 3])("enforces the default content-length ceiling or %s byte override", async (maxDownloadBytes) => {
    const options = await resolverOptions();
    const maximum = maxDownloadBytes ?? PLUGIN_ARCHIVE_FETCH_POLICY.maxDownloadBytes;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(null, { headers: { "content-length": String(maximum + 1) } })));
    await expect(resolvePluginSource(archiveUrl, { ...options, maxDownloadBytes })).rejects.toThrow(/exceeds maximum download size/u);
  });

  test("cancels streamed overflow before accepting an archive", async () => {
    const options = await resolverOptions();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(body)));
    await expect(resolvePluginSource(archiveUrl, { ...options, maxDownloadBytes: 3 })).rejects.toThrow(/exceeds maximum download size/u);
    expect(cancel).toHaveBeenCalledWith("plugin archive exceeded maximum download size");
  });

  test("keeps the size ceiling on custom byte fetchers", async () => {
    const options = await resolverOptions();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolvePluginSource(archiveUrl, {
      ...options,
      maxDownloadBytes: 3,
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
    })).rejects.toThrow(/exceeds maximum download size/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
