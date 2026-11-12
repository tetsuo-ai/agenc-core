import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createFilesystemTools } from "../../../src/tools/system/filesystem.js";
import { createKillProcessTool } from "../../../src/tools/system/kill-process.js";
import { createMonitorTool } from "../../../src/tools/system/monitor.js";
import { createSleepTool } from "../../../src/tools/system/sleep.js";
import {
  UnifiedExecError,
  type UnifiedExecProcessManagerLike,
} from "../../../src/unified-exec/types.js";
import { UnifiedExecProcessManager } from "../../../src/unified-exec/process-manager.js";
import type { ToolResult } from "../../../src/tools/types.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { itWhen } from "../../helpers/platform-registration.js";

// #2190: a bare isError from a side-effecting tool is filed as an unknown
// outcome and gates the session behind /resolve. Every refusal below happens
// before the tool touches anything and must say so.

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-pre-effect-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function expectNoEffect(result: ToolResult, contains: string): void {
  expect(result.isError).toBe(true);
  expect(String(result.content)).toContain(contains);
  expect(result.effectDisposition?.disposition).toBe("confirmed_no_effect");
}

function manager(terminate?: UnifiedExecProcessManagerLike["terminateProcess"]) {
  const base: UnifiedExecProcessManagerLike = {
    maxTimeoutMs: 30_000,
    execCommand: vi.fn(async () => undefined as never),
    writeStdin: vi.fn(async () => undefined as never),
    closeAll: vi.fn(async () => {}),
  };
  return terminate === undefined ? base : { ...base, terminateProcess: terminate };
}

describe("kill_process refusals", () => {
  test("a rejected argument", async () => {
    const tool = createKillProcessTool({ unifiedExecManager: manager(() => ({ terminated: true })) });
    expectNoEffect(await tool.execute({}), "session_id must be a number");
  });

  test("a runtime without process termination", async () => {
    const tool = createKillProcessTool({ unifiedExecManager: manager() });
    expectNoEffect(await tool.execute({ session_id: 4 }), "not supported");
  });

  test("a manager that refuses before signalling", async () => {
    const tool = createKillProcessTool({
      unifiedExecManager: manager(() => {
        throw new UnifiedExecError("owner_denied", "process belongs to another turn");
      }),
    });
    expectNoEffect(await tool.execute({ session_id: 4 }), "another turn");
  });
});

describe("sleep refusals", () => {
  test("a rejected argument", async () => {
    expectNoEffect(await createSleepTool().execute({}), "durationMs");
  });

  test("an interrupted wait", async () => {
    const controller = new AbortController();
    const pending = createSleepTool().execute({
      durationMs: 60_000,
      __abortSignal: controller.signal,
    });
    controller.abort();
    expectNoEffect(await pending, "Sleep interrupted");
  });
});

describe("monitor refusals", () => {
  test("a rejected argument", async () => {
    const tool = createMonitorTool({ cwd: root, unifiedExecManager: manager() });
    expectNoEffect(await tool.execute({ description: "list files" }), "command must be");
  });

  test("a manager that refuses before starting the command", async () => {
    const refusing: UnifiedExecProcessManagerLike = {
      ...manager(),
      execCommand: vi.fn(async () => {
        throw new UnifiedExecError("process_limit", "too many live unified exec processes (64/64)");
      }),
    };
    const tool = bindExplicitDangerBoundary(
      createMonitorTool({ cwd: root, unifiedExecManager: refusing }),
    );
    expectNoEffect(
      await tool.execute({ command: "tail -f log", description: "follow the log" }),
      "too many live unified exec processes",
    );
  });

  test.skipIf(process.platform === "win32")(
    "a working directory that no longer exists",
    async () => {
      // The session root was deleted: the process manager refuses to spawn
      // there, and nothing has run.
      const sessionRoot = join(root, "session");
      const processes = new UnifiedExecProcessManager({ cwd: sessionRoot });
      const tool = bindExplicitDangerBoundary(
        createMonitorTool({ cwd: sessionRoot, unifiedExecManager: processes }),
      );
      try {
        expectNoEffect(
          await tool.execute({ command: "tail -f log", description: "follow the log" }),
          `working directory does not exist: ${sessionRoot}`,
        );
      } finally {
        await processes.closeAll("test_cleanup");
      }
    },
  );
});

describe("filesystem refusals before mkdir, rm or rename", () => {
  function toolNamed(name: string) {
    const tool = createFilesystemTools({ allowedPaths: [root], allowDelete: true }).find(
      (candidate) => candidate.name === name,
    );
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool;
  }

  test("a path outside the allowed roots", async () => {
    expectNoEffect(
      await toolNamed("system.mkdir").execute({ path: "/etc/agenc-no" }),
      "Access denied",
    );
    expectNoEffect(
      await toolNamed("system.delete").execute({ path: "/etc/passwd" }),
      "Access denied",
    );
  });

  test("a missing path", async () => {
    expectNoEffect(
      await toolNamed("system.delete").execute({ path: join(root, "missing.txt") }),
      "Path not found",
    );
    expectNoEffect(
      await toolNamed("system.move").execute({
        source: join(root, "missing.txt"),
        destination: join(root, "moved.txt"),
      }),
      "not found",
    );
  });

  test("a rejected argument", async () => {
    expectNoEffect(await toolNamed("system.delete").execute({}), "must be a non-empty string");
  });

  test("an overwrite flag that is not a boolean", async () => {
    await writeFile(join(root, "draft.txt"), "DRAFT\n");

    expectNoEffect(
      await toolNamed("system.move").execute({
        source: join(root, "draft.txt"),
        destination: join(root, "moved.txt"),
        overwrite: "true",
      }),
      "overwrite must be a boolean",
    );

    expect(await readdir(root)).toEqual(["draft.txt"]);
  });

  // #3437: rename replaces an existing destination without saying so.
  test("a destination that already exists", async () => {
    const source = join(root, "draft.txt");
    const destination = join(root, "config.txt");
    await writeFile(source, "DRAFT\n");
    await writeFile(destination, "IMPORTANT EXISTING CONTENT\n");

    expectNoEffect(
      await toolNamed("system.move").execute({ source, destination }),
      `Destination already exists: ${destination}. Pass overwrite: true to replace it.`,
    );
    expectNoEffect(
      await toolNamed("system.move").execute({ source, destination, overwrite: false }),
      "Destination already exists",
    );

    // Nothing moved and nothing was replaced.
    expect(await readFile(source, "utf8")).toBe("DRAFT\n");
    expect(await readFile(destination, "utf8")).toBe("IMPORTANT EXISTING CONTENT\n");
    expect((await readdir(root)).sort()).toEqual(["config.txt", "draft.txt"]);
  });

  test("a move that rename cannot perform, whatever the flag says", async () => {
    const file = join(root, "notes.txt");
    const directory = join(root, "docs");
    await writeFile(file, "NOTES\n");
    await mkdir(directory);
    await writeFile(join(directory, "kept.txt"), "KEPT\n");

    for (const overwrite of [undefined, true]) {
      const flag = overwrite === undefined ? {} : { overwrite };
      const intoDirectory = await toolNamed("system.move").execute({
        source: file,
        destination: directory,
        ...flag,
      });
      expectNoEffect(intoDirectory, "Give the full destination path");
      expect(String(intoDirectory.content)).not.toContain("overwrite");

      const ontoFile = await toolNamed("system.move").execute({
        source: directory,
        destination: file,
        ...flag,
      });
      expectNoEffect(ontoFile, "it exists and is not a directory");
      expect(String(ontoFile.content)).not.toContain("overwrite");
    }

    expect(await readFile(file, "utf8")).toBe("NOTES\n");
    expect(await readdir(directory)).toEqual(["kept.txt"]);
  });

  test("a directory onto an existing directory without the flag", async () => {
    const source = join(root, "build");
    const destination = join(root, "dist");
    await mkdir(source);
    await writeFile(join(source, "out.js"), "OUT\n");
    await mkdir(destination);

    expectNoEffect(
      await toolNamed("system.move").execute({ source, destination }),
      "Pass overwrite: true to replace it.",
    );

    expect(await readdir(source)).toEqual(["out.js"]);
    expect(await readdir(destination)).toEqual([]);
  });

  itWhen(process.platform !== "win32")(
    "a dangling symlink at the destination",
    async () => {
      const source = join(root, "draft.txt");
      const destination = join(root, "link.txt");
      await writeFile(source, "DRAFT\n");
      await symlink(join(root, "not-there.txt"), destination);

      // stat would call the link absent, and rename would replace it.
      expectNoEffect(
        await toolNamed("system.move").execute({ source, destination }),
        "Destination already exists",
      );

      expect(await readlink(destination)).toBe(join(root, "not-there.txt"));
      expect(await readFile(source, "utf8")).toBe("DRAFT\n");
    },
  );
});

describe("system.move onto an existing destination that is not refused (#3437)", () => {
  function move(args: Record<string, unknown>): Promise<ToolResult> {
    const tool = createFilesystemTools({ allowedPaths: [root] }).find(
      (candidate) => candidate.name === "system.move",
    );
    if (tool === undefined) throw new Error("no tool system.move");
    return tool.execute(args);
  }

  test("overwrite: true replaces a file and says so", async () => {
    const source = join(root, "draft.txt");
    const destination = join(root, "config.txt");
    await writeFile(source, "DRAFT\n");
    await writeFile(destination, "IMPORTANT EXISTING CONTENT\n");

    const result = await move({ source, destination, overwrite: true });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      source,
      destination,
      moved: true,
      overwritten: true,
    });
    expect(await readFile(destination, "utf8")).toBe("DRAFT\n");
    expect(await readdir(root)).toEqual(["config.txt"]);
  });

  test("overwrite: true replaces an empty directory with a directory", async () => {
    const source = join(root, "build");
    const destination = join(root, "dist");
    await mkdir(source);
    await writeFile(join(source, "out.js"), "OUT\n");
    await mkdir(destination);

    const result = await move({ source, destination, overwrite: true });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content)).overwritten).toBe(true);
    expect(await readdir(root)).toEqual(["dist"]);
    expect(await readFile(join(destination, "out.js"), "utf8")).toBe("OUT\n");
  });

  test("a destination that does not exist needs no flag, in a directory that does not exist either", async () => {
    const source = join(root, "draft.txt");
    const destination = join(root, "archive", "2026", "draft.txt");
    await writeFile(source, "DRAFT\n");

    const result = await move({ source, destination });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({ source, destination, moved: true });
    expect(await readFile(destination, "utf8")).toBe("DRAFT\n");
    expect(await readdir(root)).toEqual(["archive"]);
  });

  test("the same file under both names is renamed without the flag", async () => {
    const source = join(root, "notes.txt");
    const hardLink = join(root, "notes-link.txt");
    await writeFile(source, "NOTES\n");
    await link(source, hardLink);
    expect((await lstat(source, { bigint: true })).ino).toBe(
      (await lstat(hardLink, { bigint: true })).ino,
    );

    // Onto itself, and onto a hard link to itself: nothing is replaced.
    for (const destination of [source, hardLink]) {
      const result = await move({ source, destination });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(String(result.content))).toEqual({ source, destination, moved: true });
    }

    expect(await readFile(hardLink, "utf8")).toBe("NOTES\n");
  });

  itWhen(process.platform !== "win32")(
    "overwrite: true replaces a dangling symlink and leaves its target alone",
    async () => {
      const source = join(root, "draft.txt");
      const destination = join(root, "link.txt");
      await writeFile(source, "DRAFT\n");
      await symlink(join(root, "not-there.txt"), destination);

      const result = await move({ source, destination, overwrite: true });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(String(result.content)).overwritten).toBe(true);
      expect((await lstat(destination)).isFile()).toBe(true);
      expect(await readFile(destination, "utf8")).toBe("DRAFT\n");
      expect(await readdir(root)).toEqual(["link.txt"]);
    },
  );
});
