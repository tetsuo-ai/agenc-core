import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  NETWORK_DISABLED,
  NETWORK_ENABLED,
  READ_ONLY_ACCESS_FULL,
  SandboxDeniedError,
  defaultReadOnlySubpathsFor,
  getWritableRootsWithCwd,
  isPathWritable,
  newDangerFullAccessPolicy,
  newExternalSandboxPolicy,
  newReadOnlyPolicy,
  newWorkspaceWritePolicy,
  sandboxAllowsNetwork,
  type SandboxPolicy,
} from "./sandbox.js";

const isPosix = path.sep === "/";

describe("SandboxPolicy — 4 variants construct cleanly", () => {
  test("danger_full_access variant", () => {
    const p: SandboxPolicy = newDangerFullAccessPolicy();
    expect(p.kind).toBe("danger_full_access");
  });

  test("read_only variant carries access + network", () => {
    const p = newReadOnlyPolicy();
    expect(p.kind).toBe("read_only");
    if (p.kind === "read_only") {
      expect(p.access).toEqual(READ_ONLY_ACCESS_FULL);
      expect(p.network_access).toEqual(NETWORK_DISABLED);
    }
  });

  test("workspace_write variant defaults to disabled tmp exclusions", () => {
    const p = newWorkspaceWritePolicy();
    expect(p.kind).toBe("workspace_write");
    if (p.kind === "workspace_write") {
      expect(p.writable_roots).toEqual([]);
      expect(p.exclude_slash_tmp).toBe(false);
      expect(p.exclude_tmpdir_env_var).toBe(false);
      expect(p.network_access).toEqual(NETWORK_DISABLED);
    }
  });

  test("external_sandbox variant carries network only", () => {
    const p = newExternalSandboxPolicy(NETWORK_ENABLED);
    expect(p.kind).toBe("external_sandbox");
    if (p.kind === "external_sandbox") {
      expect(p.network_access.mode).toBe("enabled");
    }
  });
});

describe("defaultReadOnlySubpathsFor", () => {
  test("emits .git, .agenc, .agents under the root (AgenC behavior)", () => {
    const root = isPosix ? "/tmp/repo" : "C:\\tmp\\repo";
    const subs = defaultReadOnlySubpathsFor(root);
    expect(subs).toContain(path.join(root, ".git"));
    expect(subs).toContain(path.join(root, ".agenc"));
    expect(subs).toContain(path.join(root, ".agents"));
  });
});

describe("getWritableRootsWithCwd", () => {
  const tmpdirOriginal = process.env["TMPDIR"];
  afterEach(() => {
    if (tmpdirOriginal === undefined) {
      delete process.env["TMPDIR"];
    } else {
      process.env["TMPDIR"] = tmpdirOriginal;
    }
  });

  test("non-workspace_write policies yield no writable roots", () => {
    expect(getWritableRootsWithCwd(newDangerFullAccessPolicy(), "/anywhere")).toEqual(
      [],
    );
    expect(getWritableRootsWithCwd(newReadOnlyPolicy(), "/anywhere")).toEqual([]);
    expect(getWritableRootsWithCwd(newExternalSandboxPolicy(), "/anywhere")).toEqual(
      [],
    );
  });

  test("workspace_write pushes cwd + /tmp (POSIX) + $TMPDIR", () => {
    const cwd = isPosix ? "/home/tester/repo" : "C:\\home\\tester\\repo";
    process.env["TMPDIR"] = isPosix ? "/var/tmp" : "C:\\Temp";
    const p = newWorkspaceWritePolicy();
    const roots = getWritableRootsWithCwd(p, cwd);
    const rootPaths = roots.map((r) => r.root);
    expect(rootPaths).toContain(path.normalize(cwd));
    if (isPosix) {
      expect(rootPaths).toContain("/tmp");
    }
    expect(rootPaths).toContain(path.normalize(process.env["TMPDIR"] as string));
  });

  test("exclude_slash_tmp keeps /tmp out of the list", () => {
    if (!isPosix) return;
    process.env["TMPDIR"] = "";
    const p = newWorkspaceWritePolicy({ exclude_slash_tmp: true });
    const roots = getWritableRootsWithCwd(p, "/home/x");
    const rootPaths = roots.map((r) => r.root);
    expect(rootPaths).not.toContain("/tmp");
    expect(rootPaths).toContain("/home/x");
  });

  test("exclude_tmpdir_env_var keeps $TMPDIR out of the list", () => {
    process.env["TMPDIR"] = isPosix ? "/var/tmp" : "C:\\Temp";
    const p = newWorkspaceWritePolicy({
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    });
    const roots = getWritableRootsWithCwd(p, isPosix ? "/home/x" : "C:\\x");
    const rootPaths = roots.map((r) => r.root);
    expect(rootPaths).not.toContain(path.normalize(process.env["TMPDIR"] as string));
  });

  test("explicit writable_roots entries come first and keep their subpaths", () => {
    const root = isPosix ? "/srv/shared" : "C:\\srv\\shared";
    const cwd = isPosix ? "/home/x/repo" : "C:\\home\\x\\repo";
    const p = newWorkspaceWritePolicy({
      writable_roots: [
        { root, read_only_subpaths: [path.join(root, ".custom-lock")] },
      ],
      exclude_slash_tmp: true,
      exclude_tmpdir_env_var: true,
    });
    const roots = getWritableRootsWithCwd(p, cwd);
    const first = roots[0];
    expect(first?.root).toBe(path.normalize(root));
    expect(first?.read_only_subpaths).toContain(path.join(root, ".custom-lock"));
  });
});

describe("isPathWritable", () => {
  const cwd = isPosix ? "/home/x/repo" : "C:\\home\\x\\repo";

  test("danger_full_access → any path writable", () => {
    const p = newDangerFullAccessPolicy();
    expect(isPathWritable(p, cwd, cwd)).toBe(true);
    expect(isPathWritable(p, isPosix ? "/etc/passwd" : "C:\\Windows", cwd)).toBe(
      true,
    );
  });

  test("read_only → never writable", () => {
    const p = newReadOnlyPolicy();
    expect(isPathWritable(p, cwd, cwd)).toBe(false);
    expect(isPathWritable(p, path.join(cwd, "scratch.txt"), cwd)).toBe(false);
  });

  test("workspace_write + cwd descendant → writable", () => {
    const p = newWorkspaceWritePolicy({
      exclude_slash_tmp: true,
      exclude_tmpdir_env_var: true,
    });
    expect(isPathWritable(p, path.join(cwd, "src", "file.ts"), cwd)).toBe(true);
  });

  test("workspace_write + outside writable roots → not writable", () => {
    const p = newWorkspaceWritePolicy({
      exclude_slash_tmp: true,
      exclude_tmpdir_env_var: true,
    });
    const outside = isPosix ? "/etc/hosts" : "C:\\Windows\\hosts";
    expect(isPathWritable(p, outside, cwd)).toBe(false);
  });

  test("workspace_write + .git/hooks under writable root → blocked", () => {
    const p = newWorkspaceWritePolicy({
      exclude_slash_tmp: true,
      exclude_tmpdir_env_var: true,
    });
    const gitHook = path.join(cwd, ".git", "hooks", "pre-commit");
    expect(isPathWritable(p, gitHook, cwd)).toBe(false);
  });

  test("workspace_write + .agenc subtree → blocked", () => {
    const p = newWorkspaceWritePolicy({
      exclude_slash_tmp: true,
      exclude_tmpdir_env_var: true,
    });
    const agencState = path.join(cwd, ".agenc", "state.json");
    expect(isPathWritable(p, agencState, cwd)).toBe(false);
  });

  test("external_sandbox → writable (host sandbox enforces)", () => {
    const p = newExternalSandboxPolicy();
    expect(isPathWritable(p, isPosix ? "/var/foo" : "C:\\var\\foo", cwd)).toBe(
      true,
    );
  });
});

describe("sandboxAllowsNetwork", () => {
  test("danger_full_access → true", () => {
    expect(sandboxAllowsNetwork(newDangerFullAccessPolicy())).toBe(true);
  });

  test("read_only defaults to disabled → false", () => {
    expect(sandboxAllowsNetwork(newReadOnlyPolicy())).toBe(false);
  });

  test("read_only with NETWORK_ENABLED → true", () => {
    expect(
      sandboxAllowsNetwork(newReadOnlyPolicy({ network: NETWORK_ENABLED })),
    ).toBe(true);
  });

  test("workspace_write respects network_access.mode", () => {
    const offP = newWorkspaceWritePolicy({ network: NETWORK_DISABLED });
    const onP = newWorkspaceWritePolicy({ network: NETWORK_ENABLED });
    expect(sandboxAllowsNetwork(offP)).toBe(false);
    expect(sandboxAllowsNetwork(onP)).toBe(true);
  });

  test("external_sandbox respects network_access.mode", () => {
    expect(sandboxAllowsNetwork(newExternalSandboxPolicy(NETWORK_ENABLED))).toBe(
      true,
    );
    expect(sandboxAllowsNetwork(newExternalSandboxPolicy(NETWORK_DISABLED))).toBe(
      false,
    );
  });
});

describe("SandboxDeniedError", () => {
  test("carries denial kind, target, and the policy", () => {
    const policy = newWorkspaceWritePolicy();
    const err = new SandboxDeniedError("path blocked", {
      denial: "filesystem",
      target: "/etc/hosts",
      policy,
    });
    expect(err.name).toBe("SandboxDeniedError");
    expect(err.kind).toBe("sandbox_denied");
    expect(err.denial).toBe("filesystem");
    expect(err.target).toBe("/etc/hosts");
    expect(err.policy).toBe(policy);
  });

  test("network denial kind round-trips", () => {
    const policy = newReadOnlyPolicy();
    const err = new SandboxDeniedError("net blocked", {
      denial: "network",
      target: "https://example.com",
      policy,
    });
    expect(err.denial).toBe("network");
  });
});
