import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admitsNamespaceInitMount, prepareNamespaceInitArtifact } from "../../../src/sandbox/linux-launcher/namespace-init-artifact.js";

let root: string, dist: string, target: string, args: string[];
const marker = "AGENC_NAMESPACE_INIT_ENTRY_V1\n";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "namespace-artifact-"));
  dist = path.join(root, "dist"); target = path.join(dist, "agenc-namespace-init-entry");
  fs.mkdirSync(dist);
  fs.writeFileSync(target, marker, { mode: 0o644 });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@tetsuo-ai/runtime",
    agencNamespaceInitEntry: "dist/agenc-namespace-init-entry" }));
  args = ["--new-session", "--die-with-parent", "--unshare-user", "--unshare-pid",
    "--ro-bind", "/", "/", "--ro-bind", dist, dist, "--proc", "/proc", "--", "/bin/true"];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const beforeCommand = (extra: string[]) => [...args.slice(0, -2), ...extra, ...args.slice(-2)];

describe.runIf(process.platform === "linux")("reserved installed namespace init artifact", () => {
  it("requires the explicit trusted read-only mount and retains fresh identity checks", () => {
    const guard = prepareNamespaceInitArtifact(root, args);
    expect(guard?.target).toBe(target); expect(guard?.isCurrent()).toBe(true);
    fs.renameSync(target, target + ".old"); fs.writeFileSync(target, marker);
    expect(guard?.isCurrent()).toBe(false);
    expect(prepareNamespaceInitArtifact(root, args)).toBeDefined();
    const noDist = args.filter((_, i) => i < 7 || i > 9);
    expect(prepareNamespaceInitArtifact(root, noDist)).toBeUndefined();
  });

  it("accepts only existing canonical directory scaffolding after the read-only root and before the trusted bind", () => {
    const scaffold = ["--dir", path.dirname(root), "--dir", root];
    const layout = [...args.slice(0, 7), ...scaffold, ...args.slice(7)];
    expect(prepareNamespaceInitArtifact(root, layout)?.isCurrent()).toBe(true);
    expect(prepareNamespaceInitArtifact(root, [...scaffold, ...args])).toBeUndefined();
    expect(prepareNamespaceInitArtifact(root, beforeCommand(scaffold))).toBeUndefined();
    expect(prepareNamespaceInitArtifact(root, [...args.slice(0, 7), "--dir", target, ...args.slice(7)])).toBeUndefined();
  });

  it("rejects missing, forged, writable, aliased and multiply linked placeholders", () => {
    fs.unlinkSync(target);
    expect(prepareNamespaceInitArtifact(root, args)).toBeUndefined();
    fs.writeFileSync(target, marker.toLowerCase());
    expect(prepareNamespaceInitArtifact(root, args)).toBeUndefined();
    fs.writeFileSync(target, marker); fs.chmodSync(target, 0o666);
    expect(prepareNamespaceInitArtifact(root, args)).toBeUndefined();
    fs.chmodSync(target, 0o644); fs.linkSync(target, target + ".alias");
    expect(prepareNamespaceInitArtifact(root, args)).toBeUndefined();
    fs.unlinkSync(target); fs.symlinkSync(target + ".alias", target);
    expect(prepareNamespaceInitArtifact(root, args)).toBeUndefined();
  });

  it("does not accept caller-selected metadata paths or stale package declarations", () => {
    const guard = prepareNamespaceInitArtifact(root, args)!;
    const manifest = path.join(root, "package.json");
    for (const value of [undefined, "../entry", target, "dist/./agenc-namespace-init-entry"]) {
      fs.writeFileSync(manifest, JSON.stringify({ name: "@tetsuo-ai/runtime", agencNamespaceInitEntry: value }));
      expect(prepareNamespaceInitArtifact(root, args)).toBeUndefined();
      expect(guard.isCurrent()).toBe(false);
    }
    fs.writeFileSync(manifest, JSON.stringify({ name: "other", agencNamespaceInitEntry: "dist/agenc-namespace-init-entry" }));
    expect(prepareNamespaceInitArtifact(root, args)).toBeUndefined();
  });

  it("rejects masks, writable ancestry, alternate mount ordering and duplicate authority", () => {
    for (const extra of [["--bind", "/", "/"], ["--ro-bind", "/", "/"],
      ["--tmpfs", target], ["--dir", root], ["--remount-ro", dist],
      ["--ro-bind", dist, dist], ["--bind", dist, "/other"],
      ["--dev-bind", root, "/other"], ["--ro-bind", "/dev/null", target],
      ["--symlink", "/other", target]]) {
      expect(prepareNamespaceInitArtifact(root, beforeCommand(extra)), extra.join(" ")).toBeUndefined();
    }
    const writableRoot = [...args]; writableRoot[4] = "--bind";
    expect(prepareNamespaceInitArtifact(root, writableRoot)).toBeUndefined();
    const maskedRoot = [...args.slice(0, 4), "--tmpfs", "/", ...args.slice(7)];
    expect(prepareNamespaceInitArtifact(root, maskedRoot)).toBeUndefined();
  });

  it("rechecks source and destination aliases before handoff", () => {
    const alias = path.join(root, "alias"), safe = path.join(root, "safe");
    fs.mkdirSync(safe); fs.symlinkSync(safe, alias);
    const layout = beforeCommand(["--bind", alias, "/other"]);
    const guard = prepareNamespaceInitArtifact(root, layout)!;
    expect(guard.isCurrent()).toBe(true);
    fs.unlinkSync(alias); fs.symlinkSync(dist, alias);
    expect(guard.isCurrent()).toBe(false);
    expect(prepareNamespaceInitArtifact(root, beforeCommand(["--ro-bind", safe, alias]))).toBeUndefined();
  });

  it("requires namespace, proc and death guards, rejects caller FD roles and helper invocation", () => {
    for (const option of ["--unshare-user", "--unshare-pid", "--die-with-parent"]) {
      expect(prepareNamespaceInitArtifact(root, args.filter(x => x !== option))).toBeUndefined();
      expect(prepareNamespaceInitArtifact(root, beforeCommand([option]))).toBeUndefined();
    }
    expect(prepareNamespaceInitArtifact(root, args.filter((_, i) => i !== 10 && i !== 11))).toBeUndefined();
    for (const extra of [["--as-pid-1"], ["--ro-bind-data", "6", target],
      ["--info-fd", "4"], ["--perms", "0500"], ["--unknown"], ["--bind"]]) {
      expect(prepareNamespaceInitArtifact(root, beforeCommand(extra))).toBeUndefined();
    }
    expect(prepareNamespaceInitArtifact(root, [...args.slice(0, -1), target])).toBeUndefined();
    expect(prepareNamespaceInitArtifact(root, [...args.slice(0, -1), "true"])).toBeUndefined();
    expect(admitsNamespaceInitMount(beforeCommand(["--tmpfs", dist + "/../dist"]), target)).toBe(false);
    expect(admitsNamespaceInitMount(beforeCommand(["--tmpfs", "/unrelated/"]), target)).toBe(false);
  });

  it("permits unrelated policy mounts without altering or reordering them", () => {
    const directory = path.join(root, "work"); fs.mkdirSync(directory);
    const layout = beforeCommand(["--bind", directory, directory, "--tmpfs", "/masked",
      "--remount-ro", "/masked", "--dev", "/dev", "--dev-bind", "/dev/null", "/dev/null",
      "--unshare-net", "--seccomp", "3", "--chdir", directory]);
    const original = [...layout];
    expect(prepareNamespaceInitArtifact(root, layout)?.isCurrent()).toBe(true);
    expect(layout).toEqual(original);
  });
});
