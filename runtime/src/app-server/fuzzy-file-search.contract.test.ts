import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import {
  AgenCFuzzyFileSearchService,
  runFuzzyFileSearch,
} from "./fuzzy-file-search.js";
import { JSON_RPC_VERSION } from "./protocol/index.js";

async function withTempTree<T>(
  setup: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "agenc-fuzzy-search-"));
  try {
    return await setup(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createDeferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("AgenC daemon fuzzy file search", () => {
  it("returns sorted file and directory matches with highlight indices", async () => {
    await withTempTree(async (root) => {
      await writeFile(join(root, "abc"), "x");
      await writeFile(join(root, "abcde"), "x");
      await writeFile(join(root, "abexy"), "x");
      await writeFile(join(root, "zzz.txt"), "x");
      await mkdir(join(root, "sub"), { recursive: true });
      await writeFile(join(root, "sub", "abce"), "x");

      const files = await runFuzzyFileSearch({
        query: "abe",
        roots: [root],
      });

      expect(files.map((file) => file.path)).toEqual([
        "abexy",
        "sub/abce",
        "abcde",
      ]);
      expect(
        files.map((file) => ({
          path: file.path,
          score: file.score,
          indices: file.indices,
        })),
      ).toEqual([
        { path: "abexy", score: 84, indices: [0, 1, 2] },
        { path: "sub/abce", score: 72, indices: [4, 5, 7] },
        { path: "abcde", score: 71, indices: [0, 1, 4] },
      ]);
      expect(files[0]).toMatchObject({
        root,
        path: "abexy",
        match_type: "file",
        file_name: "abexy",
        indices: [0, 1, 2],
      });

      const directoryMatches = await runFuzzyFileSearch({
        query: "sub",
        roots: [root],
      });
      expect(directoryMatches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "sub",
            match_type: "directory",
            file_name: "sub",
            indices: [0, 1, 2],
          }),
        ]),
      );
    });
  });

  it("returns no files for empty query or empty roots", async () => {
    const service = new AgenCFuzzyFileSearchService();

    await expect(service.search({ query: "", roots: ["/tmp"] })).resolves.toEqual({
      files: [],
    });
    await expect(service.search({ query: "src", roots: [] })).resolves.toEqual({
      files: [],
    });
  });

  it("respects repository .gitignore rules while preserving whitelisted files", async () => {
    await withTempTree(async (root) => {
      await mkdir(join(root, ".git"), { recursive: true });
      await mkdir(join(root, ".vscode"), { recursive: true });
      await writeFile(
        join(root, ".gitignore"),
        ".vscode/*\n!.vscode/\n!.vscode/settings.json\n",
      );
      await writeFile(join(root, ".vscode", "settings.json"), "{}");
      await writeFile(join(root, ".vscode", "extensions.json"), "{}");

      const settingsFiles = await runFuzzyFileSearch({
        query: "settings",
        roots: [root],
      });
      expect(settingsFiles.map((file) => file.path)).toContain(
        ".vscode/settings.json",
      );

      const extensionFiles = await runFuzzyFileSearch({
        query: "extensions",
        roots: [root],
      });
      expect(extensionFiles.map((file) => file.path)).not.toContain(
        ".vscode/extensions.json",
      );
    });
  });

  it("respects nested .gitignore files and local .ignore files", async () => {
    await withTempTree(async (root) => {
      await mkdir(join(root, ".git"), { recursive: true });
      await mkdir(join(root, "sub"), { recursive: true });
      await writeFile(join(root, ".ignore"), "secret-file.txt\n");
      await writeFile(join(root, "secret-file.txt"), "x");
      await writeFile(join(root, "sub", ".gitignore"), "ignored.txt\n");
      await writeFile(join(root, "sub", "ignored.txt"), "x");
      await writeFile(join(root, "sub", "visible.txt"), "x");

      const secretFiles = await runFuzzyFileSearch({
        query: "secret",
        roots: [root],
      });
      expect(secretFiles.map((file) => file.path)).not.toContain(
        "secret-file.txt",
      );

      const ignoredFiles = await runFuzzyFileSearch({
        query: "ignored",
        roots: [root],
      });
      expect(ignoredFiles.map((file) => file.path)).not.toContain(
        "sub/ignored.txt",
      );

      const visibleFiles = await runFuzzyFileSearch({
        query: "visible",
        roots: [root],
      });
      expect(visibleFiles.map((file) => file.path)).toContain("sub/visible.txt");
    });
  });

  it("does not apply parent .gitignore files outside a repository", async () => {
    await withTempTree(async (root) => {
      const parent = join(root, "home");
      const child = join(parent, "repo");
      await mkdir(child, { recursive: true });
      await writeFile(join(parent, ".gitignore"), "*\n");
      await writeFile(join(child, "package.json"), "{}");

      const files = await runFuzzyFileSearch({
        query: "package",
        roots: [child],
      });

      expect(files.map((file) => file.path)).toContain("package.json");
    });
  });

  it("respects git global excludes configured by HOME .gitconfig", async () => {
    await withTempTree(async (root) => {
      const originalHome = process.env.HOME;
      const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
      try {
        const home = join(root, "home");
        const repo = join(root, "repo");
        const globalIgnore = join(home, "global-ignore");
        await mkdir(join(repo, ".git"), { recursive: true });
        await mkdir(home, { recursive: true });
        await writeFile(
          join(home, ".gitconfig"),
          `[core]\n\texcludesFile = ${globalIgnore}\n`,
        );
        await writeFile(globalIgnore, "global-secret.txt\n");
        await writeFile(join(repo, "global-secret.txt"), "x");
        await writeFile(join(repo, "visible-global.txt"), "x");
        process.env.HOME = home;
        delete process.env.XDG_CONFIG_HOME;

        const secretFiles = await runFuzzyFileSearch({
          query: "secret",
          roots: [repo],
        });
        expect(secretFiles.map((file) => file.path)).not.toContain(
          "global-secret.txt",
        );

        const visibleFiles = await runFuzzyFileSearch({
          query: "visible",
          roots: [repo],
        });
        expect(visibleFiles.map((file) => file.path)).toContain(
          "visible-global.txt",
        );
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalXdgConfigHome === undefined) {
          delete process.env.XDG_CONFIG_HOME;
        } else {
          process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
        }
      }
    });
  });

  it("respects info/exclude when .git points at an external gitdir", async () => {
    await withTempTree(async (root) => {
      const repo = join(root, "repo");
      const gitDir = join(root, "gitdir");
      await mkdir(join(gitDir, "info"), { recursive: true });
      await mkdir(repo, { recursive: true });
      await writeFile(join(repo, ".git"), `gitdir: ${gitDir}\n`);
      await writeFile(join(gitDir, "info", "exclude"), "excluded-worktree.txt\n");
      await writeFile(join(repo, "excluded-worktree.txt"), "x");
      await writeFile(join(repo, "visible-worktree.txt"), "x");

      const excludedFiles = await runFuzzyFileSearch({
        query: "excluded",
        roots: [repo],
      });
      expect(excludedFiles.map((file) => file.path)).not.toContain(
        "excluded-worktree.txt",
      );

      const visibleFiles = await runFuzzyFileSearch({
        query: "visible",
        roots: [repo],
      });
      expect(visibleFiles.map((file) => file.path)).toContain(
        "visible-worktree.txt",
      );
    });
  });

  it("uses the deepest root once when search roots overlap", async () => {
    await withTempTree(async (root) => {
      const nestedRoot = join(root, "sub");
      await mkdir(nestedRoot, { recursive: true });
      await writeFile(join(nestedRoot, "alpha.txt"), "x");

      const files = await runFuzzyFileSearch({
        query: "alpha",
        roots: [root, nestedRoot],
      });

      expect(files.filter((file) => file.path.endsWith("alpha.txt"))).toEqual([
        expect.objectContaining({
          root: nestedRoot,
          path: "alpha.txt",
          match_type: "file",
        }),
      ]);
    });
  });

  it("refreshes filesystem state for repeated service searches", async () => {
    await withTempTree(async (root) => {
      await writeFile(join(root, "alpha.txt"), "x");
      const service = new AgenCFuzzyFileSearchService();

      await expect(
        service.search({ query: "alpha", roots: [root] }),
      ).resolves.toMatchObject({
        files: [expect.objectContaining({ path: "alpha.txt" })],
      });

      await writeFile(join(root, "beta.txt"), "x");

      await expect(
        service.search({ query: "beta", roots: [root] }),
      ).resolves.toMatchObject({
        files: [expect.objectContaining({ path: "beta.txt" })],
      });
    });
  });

  it("walks deep directory trees without recursive stack growth", async () => {
    await withTempTree(async (root) => {
      let current = root;
      for (let depth = 0; depth < 300; depth += 1) {
        current = join(current, "d");
      }
      await mkdir(current, { recursive: true });
      await writeFile(join(current, "needle.txt"), "x");

      const files = await runFuzzyFileSearch({
        query: "needle",
        roots: [root],
      });

      expect(files.some((file) => file.path.endsWith("needle.txt"))).toBe(true);
    });
  });

  it("returns no partial files when the real search runner is aborted", async () => {
    await withTempTree(async (root) => {
      for (let index = 0; index < 1_000; index += 1) {
        await writeFile(
          join(root, `file-${index.toString().padStart(3, "0")}.txt`),
          "x",
        );
      }
      const controller = new AbortController();
      const search = runFuzzyFileSearch(
        { query: "file", roots: [root] },
        controller.signal,
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      controller.abort();

      await expect(search).resolves.toEqual([]);
    });
  });

  it("cancels an older in-flight request that reuses the same token", async () => {
    const firstStarted = createDeferred();
    const service = new AgenCFuzzyFileSearchService({
      runSearch: async (params, signal) => {
        if (params.query === "file") {
          firstStarted.resolve(undefined);
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return signal.aborted
            ? []
            : [
                {
                  root: "/workspace",
                  path: "stale.txt",
                  match_type: "file",
                  file_name: "stale.txt",
                  score: 1,
                  indices: [0],
                },
              ];
        }
        return [
          {
            root: "/workspace",
            path: "file-299.txt",
            match_type: "file",
            file_name: "file-299.txt",
            score: 100,
            indices: [0],
          },
        ];
      },
    });
    const first = service.search({
      query: "file",
      roots: ["/workspace"],
      cancellationToken: "token_1",
    });
    await firstStarted.promise;
    const second = service.search({
      query: "file-299",
      roots: ["/workspace"],
      cancellationToken: "token_1",
    });

    await expect(second).resolves.toMatchObject({
      files: [expect.objectContaining({ path: "file-299.txt" })],
    });
    await expect(first).resolves.toEqual({ files: [] });
  });

  it("does not share cancellation tokens across JSON-RPC connections", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    let firstAborted = false;
    const fuzzyFileSearch = new AgenCFuzzyFileSearchService({
      runSearch: async (params, signal) => {
        if (params.query === "client-a") {
          signal.addEventListener("abort", () => {
            firstAborted = true;
          });
          firstStarted.resolve(undefined);
          await releaseFirst.promise;
          return signal.aborted
            ? []
            : [
                {
                  root: "/workspace",
                  path: "client-a.txt",
                  match_type: "file",
                  file_name: "client-a.txt",
                  score: 100,
                  indices: [0],
                },
              ];
        }
        return [
          {
            root: "/workspace",
            path: "client-b.txt",
            match_type: "file",
            file_name: "client-b.txt",
            score: 100,
            indices: [0],
          },
        ];
      },
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      fuzzyFileSearch,
    });
    const clientA = dispatcher.createConnection();
    const clientB = dispatcher.createConnection();
    await clientA.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init-a",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "client-a" },
    });
    await clientB.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init-b",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "client-b" },
    });

    const first = clientA.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "search-a",
      method: "fs.fuzzy_search",
      params: {
        query: "client-a",
        roots: ["/workspace"],
        cancellationToken: "shared-token",
      },
    });
    await firstStarted.promise;

    await expect(
      clientB.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "search-b",
        method: "fs.fuzzy_search",
        params: {
          query: "client-b",
          roots: ["/workspace"],
          cancellationToken: "shared-token",
        },
      }),
    ).resolves.toMatchObject({
      result: { files: [expect.objectContaining({ path: "client-b.txt" })] },
    });
    expect(firstAborted).toBe(false);

    releaseFirst.resolve(undefined);
    await expect(first).resolves.toMatchObject({
      result: { files: [expect.objectContaining({ path: "client-a.txt" })] },
    });
  });

  it("dispatches fs.fuzzy_search through the initialized JSON-RPC connection", async () => {
    const fuzzyFileSearch = {
      search: vi.fn(async () => ({
        files: [
          {
            root: "/workspace",
            path: "src/index.ts",
            match_type: "file" as const,
            file_name: "index.ts",
            score: 100,
            indices: [0, 4, 8],
          },
        ],
      })),
    };
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      fuzzyFileSearch,
    });
    const connection = dispatcher.createConnection();

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "search-before-init",
        method: "fs.fuzzy_search",
        params: { query: "src", roots: ["/workspace"] },
      }),
    ).resolves.toMatchObject({
      error: {
        code: -32000,
        data: { code: "CONNECTION_NOT_INITIALIZED" },
      },
    });

    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "contract-test" },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "search",
        method: "fs.fuzzy_search",
        params: {
          query: "src",
          roots: ["/workspace"],
          cancellationToken: "search_1",
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "search",
      result: {
        files: [
          {
            root: "/workspace",
            path: "src/index.ts",
            match_type: "file",
            file_name: "index.ts",
            score: 100,
            indices: [0, 4, 8],
          },
        ],
      },
    });
    expect(fuzzyFileSearch.search).toHaveBeenCalledWith(
      {
        query: "src",
        roots: ["/workspace"],
        cancellationToken: "search_1",
      },
      { cancellationScope: expect.stringMatching(/^connection_/) },
    );

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "search-null-token",
        method: "fs.fuzzy_search",
        params: {
          query: "src",
          roots: ["/workspace"],
          cancellationToken: null,
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: "search-null-token",
      result: {
        files: [expect.objectContaining({ path: "src/index.ts" })],
      },
    });
    expect(fuzzyFileSearch.search).toHaveBeenLastCalledWith(
      {
        query: "src",
        roots: ["/workspace"],
        cancellationToken: null,
      },
      { cancellationScope: expect.stringMatching(/^connection_/) },
    );
  });

  it("rejects malformed fs.fuzzy_search params before searching", async () => {
    const fuzzyFileSearch = { search: vi.fn(async () => ({ files: [] })) };
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      fuzzyFileSearch,
    });
    const connection = dispatcher.createConnection();
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocolVersion: "1.0.0", clientName: "contract-test" },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-roots",
        method: "fs.fuzzy_search",
        params: { query: "src", roots: "/workspace" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-roots",
      error: {
        code: -32602,
        message: "fs.fuzzy_search param 'roots' must be an array of strings",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "missing-query",
        method: "fs.fuzzy_search",
        params: { roots: ["/workspace"] },
      }),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "fs.fuzzy_search requires query",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-token",
        method: "fs.fuzzy_search",
        params: {
          query: "src",
          roots: ["/workspace"],
          cancellationToken: 123,
        },
      }),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message:
          "fs.fuzzy_search param 'cancellationToken' must be a string or null",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "unknown-param",
        method: "fs.fuzzy_search",
        params: {
          query: "src",
          roots: ["/workspace"],
          limit: 10,
        },
      }),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "fs.fuzzy_search does not accept param 'limit'",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "empty-root",
        method: "fs.fuzzy_search",
        params: { query: "src", roots: [""] },
      }),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "fs.fuzzy_search param 'roots' must not contain empty paths",
      },
    });
    expect(fuzzyFileSearch.search).not.toHaveBeenCalled();
  });
});
