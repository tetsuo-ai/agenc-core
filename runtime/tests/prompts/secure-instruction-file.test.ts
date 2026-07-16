import {
  linkSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

import {
  ExternalInstructionApprovalStore,
  readInstructionFileSnapshot,
} from "./secure-instruction-file.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agenc-secure-instruction-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("descriptor-bound instruction snapshots", () => {
  test("returns a digest and bytes from the same stable regular file", async () => {
    const root = tempRoot();
    const file = join(root, "AGENC.md");
    writeFileSync(file, "hello\r\n", "utf8");
    const read = await readInstructionFileSnapshot({
      requestedPath: file,
      boundaryRoot: root,
      workspaceRoot: root,
      sourceClass: "project",
      maximumBytes: 100,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.snapshot.text).toBe("hello\n");
    expect(read.snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(read.snapshot.identity.nlink).toBe(1n);
  });

  test("rejects leaf/intermediate symlinks and broken links", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(join(outside, "secret.md"), "secret", "utf8");
    symlinkSync(join(outside, "secret.md"), join(root, "leaf.md"));
    symlinkSync(outside, join(root, "parent"));
    symlinkSync(join(outside, "missing.md"), join(root, "broken.md"));

    for (const file of [join(root, "leaf.md"), join(root, "parent", "secret.md")]) {
      const read = await readInstructionFileSnapshot({
        requestedPath: file,
        boundaryRoot: root,
        workspaceRoot: root,
        sourceClass: "project",
        maximumBytes: 100,
      });
      expect(read.ok).toBe(false);
      if (!read.ok) expect(["approval_required", "symlink"]).toContain(read.reason);
    }
    const broken = await readInstructionFileSnapshot({
      requestedPath: join(root, "broken.md"),
      boundaryRoot: root,
      workspaceRoot: root,
      sourceClass: "project",
      maximumBytes: 100,
    });
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.reason).toBe("not_found");
  });

  test("rejects hard links and validation-to-open replacement races", async () => {
    const root = tempRoot();
    const original = join(root, "AGENC.md");
    const alias = join(root, "alias.md");
    writeFileSync(original, "safe", "utf8");
    linkSync(original, alias);
    const hardLink = await readInstructionFileSnapshot({
      requestedPath: alias,
      boundaryRoot: root,
      workspaceRoot: root,
      sourceClass: "project",
      maximumBytes: 100,
    });
    expect(hardLink.ok).toBe(false);
    if (!hardLink.ok) expect(hardLink.reason).toBe("hard_link");

    rmSync(alias);
    const replacement = join(root, "replacement.md");
    writeFileSync(replacement, "attacker", "utf8");
    const swapped = await readInstructionFileSnapshot({
      requestedPath: original,
      boundaryRoot: root,
      workspaceRoot: root,
      sourceClass: "project",
      maximumBytes: 100,
      beforeOpenForTesting: () => {
        renameSync(replacement, original);
      },
    });
    expect(swapped.ok).toBe(false);
    if (!swapped.ok) expect(swapped.reason).toBe("unstable");
  });

  test("rejects mutation of the already-open inode", async () => {
    const root = tempRoot();
    const file = join(root, "AGENC.md");
    writeFileSync(file, "before", "utf8");
    const read = await readInstructionFileSnapshot({
      requestedPath: file,
      boundaryRoot: root,
      workspaceRoot: root,
      sourceClass: "project",
      maximumBytes: 100,
      beforeReadForTesting: () => writeFileSync(file, "after!", "utf8"),
    });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("unstable");
  });

  test.runIf(process.platform !== "win32")(
    "rejects FIFOs without opening their blocking content stream",
    async () => {
      const root = tempRoot();
      const fifo = join(root, "rule.md");
      const made = spawnSync("mkfifo", [fifo]);
      if (made.status !== 0) return;
      const read = await readInstructionFileSnapshot({
        requestedPath: fifo,
        boundaryRoot: root,
        workspaceRoot: root,
        sourceClass: "rule",
        maximumBytes: 100,
      });
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.reason).toBe("not_regular_file");
    },
  );

  test.runIf(process.platform !== "win32")(
    "does not block when a validated regular file is replaced by a FIFO",
    async () => {
      const root = tempRoot();
      const file = join(root, "rule.md");
      writeFileSync(file, "regular", "utf8");
      const read = await readInstructionFileSnapshot({
        requestedPath: file,
        boundaryRoot: root,
        workspaceRoot: root,
        sourceClass: "rule",
        maximumBytes: 100,
        beforeOpenForTesting: () => {
          rmSync(file);
          expect(spawnSync("mkfifo", [file]).status).toBe(0);
        },
      });
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.reason).toBe("unstable");
    },
  );

  test("rejects oversized and invalid UTF-8 instruction files", async () => {
    const root = tempRoot();
    const oversized = join(root, "large.md");
    const invalid = join(root, "invalid.md");
    writeFileSync(oversized, "12345", "utf8");
    writeFileSync(invalid, Buffer.from([0xff, 0xfe, 0xfd]));
    const tooLarge = await readInstructionFileSnapshot({
      requestedPath: oversized,
      boundaryRoot: root,
      workspaceRoot: root,
      sourceClass: "project",
      maximumBytes: 4,
    });
    const badUtf8 = await readInstructionFileSnapshot({
      requestedPath: invalid,
      boundaryRoot: root,
      workspaceRoot: root,
      sourceClass: "project",
      maximumBytes: 10,
    });
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.reason).toBe("too_large");
    expect(badUtf8.ok).toBe(false);
    if (!badUtf8.ok) expect(badUtf8.reason).toBe("invalid_utf8");
  });

  test("requires a revocable exact workspace/source/digest/target identity approval before external bytes open", async () => {
    const workspace = tempRoot();
    const outside = tempRoot();
    const parent = join(workspace, "AGENC.md");
    const target = join(outside, "shared.md");
    writeFileSync(parent, "@include ../shared.md", "utf8");
    writeFileSync(target, "approved", "utf8");
    const parentRead = await readInstructionFileSnapshot({
      requestedPath: parent,
      boundaryRoot: workspace,
      workspaceRoot: workspace,
      sourceClass: "project",
      maximumBytes: 100,
    });
    expect(parentRead.ok).toBe(true);
    if (!parentRead.ok) return;

    let opened = false;
    const denied = await readInstructionFileSnapshot({
      requestedPath: target,
      boundaryRoot: workspace,
      workspaceRoot: workspace,
      sourceClass: "include",
      maximumBytes: 100,
      includedBy: parentRead.snapshot.canonicalPath,
      includedBySha256: parentRead.snapshot.sha256,
      beforeOpenForTesting: () => {
        opened = true;
      },
    });
    expect(denied.ok).toBe(false);
    expect(opened).toBe(false);
    if (denied.ok || denied.identity === undefined || denied.canonicalPath === undefined) return;
    expect(denied.reason).toBe("approval_required");

    const approvals = new ExternalInstructionApprovalStore();
    const approval = approvals.grant({
      workspaceRoot: workspace,
      includingSource: parentRead.snapshot.canonicalPath,
      includingSourceSha256: parentRead.snapshot.sha256,
      targetCanonicalPath: denied.canonicalPath,
      targetIdentity: denied.identity,
      principal: "operator:test",
    });
    const approved = await readInstructionFileSnapshot({
      requestedPath: target,
      boundaryRoot: workspace,
      workspaceRoot: workspace,
      sourceClass: "include",
      maximumBytes: 100,
      includedBy: parentRead.snapshot.canonicalPath,
      includedBySha256: parentRead.snapshot.sha256,
      externalApprovals: approvals,
    });
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.snapshot.text).toBe("approved");
      expect(approved.snapshot.externalApprovalId).toBe(approval.id);
    }
    expect(approvals.auditLog().map((event) => event.action)).toEqual([
      "granted",
      "used",
    ]);

    expect(approvals.revoke(approval.id)).toBe(true);
    const revoked = await readInstructionFileSnapshot({
      requestedPath: target,
      boundaryRoot: workspace,
      workspaceRoot: workspace,
      sourceClass: "include",
      maximumBytes: 100,
      includedBy: parentRead.snapshot.canonicalPath,
      includedBySha256: parentRead.snapshot.sha256,
      externalApprovals: approvals,
    });
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.reason).toBe("approval_required");
  });

  test("does not transfer approval after target identity changes or expiry", async () => {
    const workspace = tempRoot();
    const outside = tempRoot();
    const parent = join(workspace, "AGENC.md");
    const target = join(outside, "target.md");
    writeFileSync(parent, "parent", "utf8");
    writeFileSync(target, "one", "utf8");
    const parentRead = await readInstructionFileSnapshot({
      requestedPath: parent,
      boundaryRoot: workspace,
      workspaceRoot: workspace,
      sourceClass: "project",
      maximumBytes: 100,
    });
    if (!parentRead.ok) throw new Error("parent setup failed");
    const discovery = await readInstructionFileSnapshot({
      requestedPath: target,
      boundaryRoot: workspace,
      workspaceRoot: workspace,
      sourceClass: "include",
      maximumBytes: 100,
      includedBy: parentRead.snapshot.canonicalPath,
      includedBySha256: parentRead.snapshot.sha256,
    });
    if (discovery.ok || discovery.identity === undefined || discovery.canonicalPath === undefined) {
      throw new Error("external discovery setup failed");
    }
    const approvals = new ExternalInstructionApprovalStore();
    approvals.grant({
      workspaceRoot: workspace,
      includingSource: parentRead.snapshot.canonicalPath,
      includingSourceSha256: parentRead.snapshot.sha256,
      targetCanonicalPath: discovery.canonicalPath,
      targetIdentity: discovery.identity,
      expiresAt: new Date(Date.now() - 1).toISOString(),
      principal: "operator:test",
    });
    const expired = await readInstructionFileSnapshot({
      requestedPath: target,
      boundaryRoot: workspace,
      workspaceRoot: workspace,
      sourceClass: "include",
      maximumBytes: 100,
      includedBy: parentRead.snapshot.canonicalPath,
      includedBySha256: parentRead.snapshot.sha256,
      externalApprovals: approvals,
    });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.reason).toBe("approval_expired");

    const liveApprovals = new ExternalInstructionApprovalStore();
    liveApprovals.grant({
      workspaceRoot: workspace,
      includingSource: parentRead.snapshot.canonicalPath,
      includingSourceSha256: parentRead.snapshot.sha256,
      targetCanonicalPath: discovery.canonicalPath,
      targetIdentity: discovery.identity,
      principal: "operator:test",
    });
    rmSync(target);
    writeFileSync(target, "two", "utf8");
    const replaced = await readInstructionFileSnapshot({
      requestedPath: target,
      boundaryRoot: workspace,
      workspaceRoot: workspace,
      sourceClass: "include",
      maximumBytes: 100,
      includedBy: parentRead.snapshot.canonicalPath,
      includedBySha256: parentRead.snapshot.sha256,
      externalApprovals: liveApprovals,
    });
    expect(replaced.ok).toBe(false);
    if (!replaced.ok) expect(replaced.reason).toBe("approval_required");
  });

  test("revalidates approval immediately before read and rejects malformed expiry", async () => {
    const workspace = tempRoot();
    const outside = tempRoot();
    const parent = join(workspace, "AGENC.md");
    const target = join(outside, "target.md");
    writeFileSync(parent, "parent", "utf8");
    writeFileSync(target, "SECRET", "utf8");
    const parentRead = await readInstructionFileSnapshot({
      requestedPath: parent,
      boundaryRoot: workspace,
      workspaceRoot: workspace,
      sourceClass: "project",
      maximumBytes: 100,
    });
    if (!parentRead.ok) throw new Error("parent setup failed");
    const discovery = await readInstructionFileSnapshot({
      requestedPath: target,
      boundaryRoot: workspace,
      workspaceRoot: workspace,
      sourceClass: "include",
      maximumBytes: 100,
      includedBy: parentRead.snapshot.canonicalPath,
      includedBySha256: parentRead.snapshot.sha256,
    });
    if (discovery.ok || discovery.identity === undefined || discovery.canonicalPath === undefined) {
      throw new Error("external discovery setup failed");
    }
    const approvals = new ExternalInstructionApprovalStore();
    expect(() => approvals.grant({
      workspaceRoot: workspace,
      includingSource: parentRead.snapshot.canonicalPath,
      includingSourceSha256: parentRead.snapshot.sha256,
      targetCanonicalPath: discovery.canonicalPath,
      targetIdentity: discovery.identity,
      expiresAt: "not-a-date",
      principal: "operator:test",
    })).toThrow(/expiry/);

    const approval = approvals.grant({
      workspaceRoot: workspace,
      includingSource: parentRead.snapshot.canonicalPath,
      includingSourceSha256: parentRead.snapshot.sha256,
      targetCanonicalPath: discovery.canonicalPath,
      targetIdentity: discovery.identity,
      principal: "operator:test",
    });
    const revoked = await readInstructionFileSnapshot({
      requestedPath: target,
      boundaryRoot: workspace,
      workspaceRoot: workspace,
      sourceClass: "include",
      maximumBytes: 100,
      includedBy: parentRead.snapshot.canonicalPath,
      includedBySha256: parentRead.snapshot.sha256,
      externalApprovals: approvals,
      beforeOpenForTesting: () => {
        approvals.revoke(approval.id);
      },
    });
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.reason).toBe("approval_required");
    expect(approvals.auditLog().map((event) => event.action)).toEqual([
      "granted",
      "revoked",
    ]);
  });

  test("never approves external hard links and freezes granted scope", async () => {
    const workspace = tempRoot();
    const outside = tempRoot();
    const parent = join(workspace, "AGENC.md");
    const target = join(outside, "target.md");
    const alias = join(outside, "alias.md");
    writeFileSync(parent, "parent", "utf8");
    writeFileSync(target, "shared", "utf8");
    linkSync(target, alias);
    const parentRead = await readInstructionFileSnapshot({
      requestedPath: parent,
      boundaryRoot: workspace,
      workspaceRoot: workspace,
      sourceClass: "project",
      maximumBytes: 100,
    });
    if (!parentRead.ok) throw new Error("parent setup failed");
    const discovery = await readInstructionFileSnapshot({
      requestedPath: target,
      boundaryRoot: workspace,
      workspaceRoot: workspace,
      sourceClass: "include",
      maximumBytes: 100,
      includedBy: parentRead.snapshot.canonicalPath,
      includedBySha256: parentRead.snapshot.sha256,
    });
    if (discovery.ok || discovery.identity === undefined || discovery.canonicalPath === undefined) {
      throw new Error("external discovery setup failed");
    }
    const approvals = new ExternalInstructionApprovalStore();
    const approval = approvals.grant({
      workspaceRoot: workspace,
      includingSource: parentRead.snapshot.canonicalPath,
      includingSourceSha256: parentRead.snapshot.sha256,
      targetCanonicalPath: discovery.canonicalPath,
      targetIdentity: discovery.identity,
      principal: "operator:test",
    });
    expect(Object.isFrozen(approval)).toBe(true);
    expect(Object.isFrozen(approval.targetIdentity)).toBe(true);

    const read = await readInstructionFileSnapshot({
      requestedPath: target,
      boundaryRoot: workspace,
      workspaceRoot: workspace,
      sourceClass: "include",
      maximumBytes: 100,
      includedBy: parentRead.snapshot.canonicalPath,
      includedBySha256: parentRead.snapshot.sha256,
      externalApprovals: approvals,
    });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("hard_link");
    expect(approvals.auditLog()[0]?.targetIdentity).toMatch(/^\d+:/);
  });
});
