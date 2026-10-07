import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalAuthorityPath } from "../../src/sandbox/desktop-authority-protection.js";

const roots: string[] = [];
function fixture(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agenc-realpath-")));
  roots.push(root);
  return root;
}
// Preserve the pre-change algorithm as a differential oracle, including its
// missing-leaf rule. Native failures must not create new grants or refusals.
function previousResolution(target: string): string {
  let ancestor = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(realpathSync(ancestor), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
function errorCode(action: () => unknown): string | undefined {
  try { action(); return undefined; }
  catch (error) { return (error as NodeJS.ErrnoException).code; }
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fresh authority realpath resolution", () => {
  it("matches existing and missing paths, relative paths, root and non-ASCII names", () => {
    const root = fixture();
    const directory = path.join(root, "space 雪");
    mkdirSync(directory);
    writeFileSync(path.join(directory, "file"), "data");
    for (const target of ["/", root, directory, path.join(directory, "file"),
      path.join(directory, "missing", "leaf"), path.relative(process.cwd(), directory)]) {
      expect(canonicalAuthorityPath(target)).toBe(previousResolution(target));
    }
  });

  it("resolves nested aliases and missing descendants without retaining an old target", () => {
    const root = fixture();
    mkdirSync(path.join(root, "a"));
    mkdirSync(path.join(root, "b"));
    const alias = path.join(root, "alias");
    const nested = path.join(root, "nested");
    symlinkSync("a", alias);
    symlinkSync("alias", nested);
    const target = path.join(nested, "missing", "leaf");
    expect(canonicalAuthorityPath(target)).toBe(path.join(root, "a", "missing", "leaf"));
    unlinkSync(alias);
    symlinkSync("b", alias);
    expect(canonicalAuthorityPath(target)).toBe(path.join(root, "b", "missing", "leaf"));
    expect(canonicalAuthorityPath(target)).toBe(previousResolution(target));
  });

  it("preserves dangling-link ancestor behavior", () => {
    const root = fixture();
    symlinkSync("absent", path.join(root, "dangling"));
    for (const target of [path.join(root, "dangling"), path.join(root, "dangling", "leaf")]) {
      expect(canonicalAuthorityPath(target)).toBe(previousResolution(target));
    }
  });

  it("retains loop and non-directory errors instead of treating them as missing leaves", () => {
    const root = fixture();
    symlinkSync("loop", path.join(root, "loop"));
    writeFileSync(path.join(root, "file"), "data");
    for (const [target, code] of [[path.join(root, "loop"), "ELOOP"],
      [path.join(root, "file", "leaf"), "ENOTDIR"]]) {
      expect(errorCode(() => canonicalAuthorityPath(target!))).toBe(code);
      expect(errorCode(() => canonicalAuthorityPath(target!))).toBe(errorCode(() => previousResolution(target!)));
    }
  });

  if (process.platform === "linux") {
    it("propagates an inaccessible ancestor instead of granting a lexical path", () => {
      const root = fixture();
      const denied = path.join(root, "denied");
      mkdirSync(denied);
      writeFileSync(path.join(denied, "file"), "data");
      chmodSync(denied, 0);
      try {
        const target = path.join(denied, "file");
        const previous = errorCode(() => previousResolution(target));
        expect(errorCode(() => canonicalAuthorityPath(target))).toBe(previous);
        if (process.geteuid?.() !== 0) expect(previous).toBe("EACCES");
      } finally { chmodSync(denied, 0o700); }
    });

    it("leaves non-Linux resolution on the previous implementation", () => {
      const root = fixture();
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      const native = vi.spyOn(realpathSync, "native");
      try {
        Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
        expect(canonicalAuthorityPath(root)).toBe(root);
        expect(native).not.toHaveBeenCalled();
      } finally { Object.defineProperty(process, "platform", descriptor); }
    });

    it.each(["ENOENT", "EACCES", "ELOOP", "ENOSYS"])("uses the legacy resolver after native %s", (code) => {
      const root = fixture();
      const native = vi.spyOn(realpathSync, "native").mockImplementation(() => {
        throw Object.assign(new Error("injected native failure"), { code });
      });
      const target = path.join(root, "missing", "leaf");
      expect(canonicalAuthorityPath(target)).toBe(previousResolution(target));
      expect(native).toHaveBeenCalled();
      symlinkSync("loop", path.join(root, "loop"));
      expect(errorCode(() => canonicalAuthorityPath(path.join(root, "loop")))).toBe("ELOOP");
    });

    it("does not resolve existing authorities from a cross-call cache", () => {
      const root = fixture();
      const native = vi.spyOn(realpathSync, "native");
      expect(canonicalAuthorityPath(root)).toBe(root);
      expect(canonicalAuthorityPath(root)).toBe(root);
      expect(native).toHaveBeenCalledTimes(2);
    });
  }
});
