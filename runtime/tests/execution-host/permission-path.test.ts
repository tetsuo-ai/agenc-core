import { describe, expect, test } from "vitest";
import { resolveExecutionPermissionPath } from "../../src/execution/permission-path.js";
import { TaskFiles } from "./task-files-fixture.js";

function link(files: TaskFiles, path: string, target: string): void {
  files.put(path, target);
  const entry = files.entries.get(path)!;
  files.entries.set(path, { ...entry, identity: { ...entry.identity, mode: String(0o120777) } });
}
const options = { cwd: "/app", homePath: "/home/task" };

describe("protected permission path evidence", () => {
  test("retains intermediate absolute and relative symlink destinations, including dangling targets", async () => {
    const files = new TaskFiles();
    files.put("/private/notes", "task");
    link(files, "/app/entry", "../alias");
    link(files, "/alias", "/private/notes");
    const result = await resolveExecutionPermissionPath(files.environment(), "entry", options);
    expect(result.paths).toEqual(["/app/entry", "/app/../alias", "/alias", "/private/notes"]);
    expect(result.description?.identity).toEqual(files.entries.get("/private/notes")!.identity);
    link(files, "/app/new", "/private/absent/file");
    expect(await resolveExecutionPermissionPath(files.environment(), "new", options)).toMatchObject({
      canonicalPath: "/private/absent/file", description: null,
      paths: ["/app/new", "/private/absent/file"],
    });
    expect(files.reads).toEqual([]);
  });

  test("walks symlinks before dot-dot and resolves missing children below aliased parents", async () => {
    const files = new TaskFiles();
    files.put("/real/nested", "", true); files.put("/real/file", "correct"); files.put("/app/file", "wrong");
    link(files, "/app/dir", "/real/nested");
    expect((await resolveExecutionPermissionPath(files.environment(), "dir/../file", options)).canonicalPath).toBe("/real/file");
    expect((await resolveExecutionPermissionPath(files.environment(), "dir/new", options)).canonicalPath).toBe("/real/nested/new");
    await expect(resolveExecutionPermissionPath(files.environment(), "missing/../file", options)).rejects.toMatchObject({ code: "not_found" });
    await expect(resolveExecutionPermissionPath(files.environment(), "file/", options)).rejects.toMatchObject({ code: "unsupported_resource" });
    link(files, "/app/root", "/");
    expect((await resolveExecutionPermissionPath(files.environment(), "root", options)).description).toEqual({
      canonicalPath: "/", identity: files.entries.get("/")!.identity,
    });
  });

  test("uses only explicit task home and fresh environment metadata", async () => {
    const left = new TaskFiles(), right = new TaskFiles();
    left.put("/home/task/file", "left"); right.put("/home/task/file", "right longer");
    const first = await resolveExecutionPermissionPath(left.environment(), "~/file", options);
    const second = await resolveExecutionPermissionPath(right.environment("d"), "~/file", options);
    expect(first.path).toBe("/home/task/file"); expect(second.description?.identity.size).not.toBe(first.description?.identity.size);
    await expect(resolveExecutionPermissionPath(left.environment(), "~/file", { cwd: "/app" })).rejects.toMatchObject({ code: "environment_not_ready" });
    left.unavailable = true;
    await expect(resolveExecutionPermissionPath(left.environment(), "~/file", options)).rejects.toMatchObject({ code: "environment_dead" });
  });

  test("rejects loops, special resources, invalid paths, and parent replacement during observation", async () => {
    const files = new TaskFiles(); files.put("/app/file", "notes");
    link(files, "/app/loop", "/app/loop");
    await expect(resolveExecutionPermissionPath(files.environment(), "loop", options)).rejects.toMatchObject({ code: "unsupported_resource" });
    files.put("/app/fifo", "");
    const fifo = files.entries.get("/app/fifo")!;
    files.entries.set("/app/fifo", { ...fifo, identity: { ...fifo.identity, mode: String(0o010600) } });
    await expect(resolveExecutionPermissionPath(files.environment(), "fifo", options)).rejects.toMatchObject({ code: "unsupported_resource" });
    await expect(resolveExecutionPermissionPath(files.environment(), "bad\0path", options)).rejects.toMatchObject({ code: "invalid_request" });
    const describePath = files.filesystem.describePath;
    files.filesystem.describePath = async (path, policy) => {
      const result = await describePath(path, policy);
      if (path === "/app/file") files.put("/app", "", true);
      return result;
    };
    await expect(resolveExecutionPermissionPath(files.environment(), "file", options)).rejects.toMatchObject({ code: "path_conflict" });
  });

  test("rejects a missing destination that appears before evidence settles", async () => {
    const files = new TaskFiles(); files.put("/app", "", true);
    const describePath = files.filesystem.describePath;
    let observedMissing = false;
    files.filesystem.describePath = async (path, policy) => {
      if (path === "/app/new" && !observedMissing) {
        observedMissing = true;
        try { return await describePath(path, policy); }
        finally { files.put("/app/new", "raced"); }
      }
      return describePath(path, policy);
    };
    await expect(resolveExecutionPermissionPath(files.environment(), "new", options)).rejects.toMatchObject({ code: "path_conflict" });
  });
});
