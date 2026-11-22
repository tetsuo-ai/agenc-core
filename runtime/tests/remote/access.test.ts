import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalRemoteWorkspace, pathWithin, RemoteAccessBoundary, type RemoteGrant } from "../../src/remote/access.js";

// The remote-access boundary scopes every Telegram connection. These cases
// were part of the retired browser pairing suite; the boundary itself stays.
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "remote-access-")));
  const workspace = join(root, "workspace"); const privateHome = join(root, "private");
  mkdirSync(workspace); mkdirSync(privateHome);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const lookup = vi.fn(async (sessionId: string) => sessionId === "allowed" ? { sessionId, cwd: workspace, title: "Allowed", runtimeOptions: { credentials: "private" } } : sessionId === "outside" ? { sessionId, cwd: root } : null);
  const grant: RemoteGrant = { workspaceId: "workspace", workspacePath: workspace, sessionIds: ["allowed"], role: "control", allowFiles: true, allowApprovals: true };
  return { root, privateHome, workspace, lookup, grant };
}

describe("remote access boundary", () => {
  it("handles Windows drives, separators and case without prefix confusion", () => {
    expect(pathWithin("C:\\Work\\Project", "c:\\work\\PROJECT\\src\\a.ts", "win32")).toBe(true);
    expect(pathWithin("C:\\Work\\Project", "C:\\Work\\Project-old\\a.ts", "win32")).toBe(false);
    expect(pathWithin("C:\\Work\\Project", "D:\\Work\\Project", "win32")).toBe(false);
    expect(pathWithin("/work/Project", "/work/project/a", "linux")).toBe(false);
    expect(pathWithin("/work/project", "/work/project/../private", "darwin")).toBe(false);
  });
  it("excludes the private home even when a caller supplies a symlink alias", () => {
    const f = fixture(); const alias = join(f.root, "private-alias");
    symlinkSync(f.privateHome, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => canonicalRemoteWorkspace(f.privateHome, alias)).toThrow("REMOTE_WORKSPACE_INVALID");
    expect(() => canonicalRemoteWorkspace(f.workspace, join(f.root, "missing-home"))).toThrow();
  });
  it("denies all daemon, config and unscoped methods even to a controller", async () => {
    const f = fixture();
    const access = new RemoteAccessBoundary(f.grant, () => true, f.lookup, f.privateHome);
    for (const method of ["remote.approve", "auth.whoami", "agent.attach", "session.applyConfig", "permission.list", "commandExec.start", "session.create", "project.trustStatus", "project.trust"]) await expect(access.authorize(method, { sessionId: "allowed" })).rejects.toMatchObject({ code: "REMOTE_METHOD_DENIED" });
    await expect(access.authorize("session.transcript.v2", { sessionId: "outside" })).rejects.toMatchObject({ code: "REMOTE_SESSION_DENIED" });
    expect(JSON.stringify(await access.sessions())).not.toMatch(/cwd|credentials|runtimeOptions/);
  });
  it("viewers cannot send messages or approve tools; controllers cannot expand approval scope", async () => {
    const f = fixture();
    const viewer = new RemoteAccessBoundary({ ...f.grant, role: "view" }, () => true, f.lookup, f.privateHome);
    await expect(viewer.authorize("message.send", { sessionId: "allowed" })).rejects.toMatchObject({ code: "REMOTE_CONTROL_DENIED" });
    const controller = new RemoteAccessBoundary(f.grant, () => true, f.lookup, f.privateHome);
    await expect(controller.authorize("tool.approve", { sessionId: "allowed", requestId: "request", scope: "session" })).rejects.toMatchObject({ code: "REMOTE_APPROVAL_DENIED" });
    await expect(controller.authorize("tool.approve", { sessionId: "allowed", requestId: "request", scope: "once" })).resolves.toBeUndefined();
    await expect(controller.authorize("message.send", { sessionId: "allowed", content: "hi", clientMessageId: "stable", ifBusy: "reject", metadata: {} })).rejects.toMatchObject({ code: "REMOTE_MESSAGE_INVALID" });
  });
  it("reads ordinary files but rejects traversal, symlinks, hidden configuration and key files", () => {
    const f = fixture(); writeFileSync(join(f.workspace, "hello.ts"), "hello"); writeFileSync(join(f.workspace, ".env"), "secret"); writeFileSync(join(f.privateHome, "secret"), "secret");
    symlinkSync(f.privateHome, join(f.workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
    const access = new RemoteAccessBoundary({ ...f.grant, allowApprovals: false }, () => true, f.lookup, f.privateHome);
    expect(access.files("files.read", { path: "hello.ts" }).content).toBe("hello");
    for (const file of ["../private/secret", "linked/secret", ".env", "auth.json", "private.key", "hello.ts:secret"]) expect(() => access.files("files.read", { path: file })).toThrow();
    expect(access.files("files.list", { path: "" }).entries).toEqual([{ name: "hello.ts", type: "file" }]);
  });
});
