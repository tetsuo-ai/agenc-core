/**
 * Descriptor-bound instruction file snapshots.
 *
 * Instruction paths are repository-influenced input. Validation and reads must
 * therefore refer to one opened object: callers never validate a pathname and
 * later reopen it. This module is the sole filesystem read primitive for live
 * project instructions, rules, and recursive includes.
 */
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { normalizeExternalText } from "./_deps/file-read.js";
import { instructionFilesystem, instructionFilesystemErrorCode, type InstructionExecutionEnvironment,
  type InstructionFileStat, type InstructionFilesystem, type InstructionFileHandle } from "./instruction-filesystem.js";
import { readExecutionEnvironmentBinding } from "../execution/binding.js";
import { ExecutionEnvironmentError, executionEnvironmentCacheKey, type ExecutionEnvironmentBinding } from "../execution/types.js";

/**
 * Hard ceiling for a single secure instruction file (5 MiB).
 *
 * Every surface that serves the same AGENC.md must use this number, or the
 * same file is readable in-process and silently missing elsewhere.
 */
export const MAX_SECURE_PROJECT_FILE_BYTES = 5 * 1024 * 1024;

export type InstructionSourceClass =
  | "managed"
  | "user"
  | "project"
  | "local"
  | "rule"
  | "include";

export type InstructionReadFailureReason =
  | "not_found"
  | "boundary_unavailable"
  | "outside_boundary"
  | "approval_required"
  | "approval_expired"
  | "symlink"
  | "not_regular_file"
  | "hard_link"
  | "too_large"
  | "unstable"
  | "invalid_utf8"
  | "read_error";

export interface InstructionFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface InstructionFileSnapshot {
  readonly executionBinding?: ExecutionEnvironmentBinding;
  readonly sourceClass: InstructionSourceClass;
  readonly workspaceRoot: string;
  readonly boundaryRoot: string;
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly includedBy?: string;
  readonly identity: InstructionFileIdentity;
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly sha256: string;
  readonly externalApprovalId?: string;
}

export interface InstructionReadFailure {
  readonly ok: false;
  readonly reason: InstructionReadFailureReason;
  readonly requestedPath: string;
  readonly canonicalPath?: string;
  readonly identity?: InstructionFileIdentity;
  readonly includedBy?: string;
  readonly external: boolean;
}

export type InstructionReadResult =
  | { readonly ok: true; readonly snapshot: InstructionFileSnapshot }
  | InstructionReadFailure;

export interface ExactExternalInstructionApprovalRequest {
  readonly executionBinding?: ExecutionEnvironmentBinding;
  readonly workspaceRoot: string;
  readonly includingSource: string;
  readonly includingSourceSha256: string;
  readonly targetCanonicalPath: string;
  readonly targetIdentity: InstructionFileIdentity;
  readonly expiresAt?: string;
  readonly principal: string;
}

export interface ExactExternalInstructionApproval
  extends ExactExternalInstructionApprovalRequest {
  readonly id: string;
  readonly grantedAt: string;
}

export interface ExternalInstructionApprovalAuditEvent {
  readonly executionBinding?: ExecutionEnvironmentBinding;
  readonly action: "granted" | "used" | "revoked" | "expired";
  readonly approvalId: string;
  readonly at: string;
  readonly workspaceRoot: string;
  readonly includingSource: string;
  readonly includingSourceSha256: string;
  readonly targetCanonicalPath: string;
  readonly targetIdentity: string;
  readonly expiresAt?: string;
  readonly principal: string;
}

/**
 * Process-local trusted-operator approval channel.
 *
 * It is deliberately not config-file backed: repository content cannot create,
 * persist, broaden, or revive an approval. Hosts may expose this object through
 * an authenticated operator UI; live turns pass no store by default.
 */
export class ExternalInstructionApprovalStore {
  readonly #approvals = new Map<string, ExactExternalInstructionApproval>();
  readonly #audit: ExternalInstructionApprovalAuditEvent[] = [];

  grant(request: ExactExternalInstructionApprovalRequest): ExactExternalInstructionApproval {
    if (
      request.expiresAt !== undefined &&
      !Number.isFinite(Date.parse(request.expiresAt))
    ) {
      throw new TypeError("external instruction approval expiry must be an ISO timestamp");
    }
    const targetIdentity = Object.freeze({ ...request.targetIdentity });
    const approval: ExactExternalInstructionApproval = Object.freeze({
      ...request,
      ...(request.executionBinding === undefined ? {} : { executionBinding: readExecutionEnvironmentBinding(request.executionBinding) }),
      workspaceRoot: resolve(request.workspaceRoot),
      includingSource: resolve(request.includingSource),
      includingSourceSha256: request.includingSourceSha256,
      targetCanonicalPath: resolve(request.targetCanonicalPath),
      targetIdentity,
      id: randomUUID(),
      grantedAt: new Date().toISOString(),
    });
    this.#approvals.set(approval.id, approval);
    this.#record("granted", approval);
    return approval;
  }

  revoke(id: string): boolean {
    const approval = this.#approvals.get(id);
    if (approval === undefined) return false;
    this.#approvals.delete(id);
    this.#record("revoked", approval);
    return true;
  }

  auditLog(): readonly ExternalInstructionApprovalAuditEvent[] {
    return this.#audit.map((event) => ({ ...event }));
  }

  findExact(input: {
    readonly executionBinding?: ExecutionEnvironmentBinding;
    readonly workspaceRoot: string;
    readonly includingSource: string;
    readonly includingSourceSha256: string;
    readonly targetCanonicalPath: string;
    readonly targetIdentity: InstructionFileIdentity;
  }): { readonly approval?: ExactExternalInstructionApproval; readonly expired: boolean } {
    const workspaceRoot = resolve(input.workspaceRoot);
    const includingSource = resolve(input.includingSource);
    const targetCanonicalPath = resolve(input.targetCanonicalPath);
    let expired = false;
    for (const approval of this.#approvals.values()) {
      if (
        executionEnvironmentCacheKey(approval.executionBinding ?? { kind: "local" }, "") !==
          executionEnvironmentCacheKey(input.executionBinding ?? { kind: "local" }, "") ||
        approval.workspaceRoot !== workspaceRoot ||
        approval.includingSource !== includingSource ||
        approval.includingSourceSha256 !== input.includingSourceSha256 ||
        approval.targetCanonicalPath !== targetCanonicalPath
      ) {
        continue;
      }
      if (!sameInstructionFileIdentity(approval.targetIdentity, input.targetIdentity)) continue;
      if (
        approval.expiresAt !== undefined &&
        Date.parse(approval.expiresAt) <= Date.now()
      ) {
        expired = true;
        this.#approvals.delete(approval.id);
        this.#record("expired", approval);
        continue;
      }
      return { approval, expired: false };
    }
    return { expired };
  }

  recordUse(approval: ExactExternalInstructionApproval): void {
    if (this.#approvals.get(approval.id) === approval) {
      this.#record("used", approval);
    }
  }

  #record(
    action: ExternalInstructionApprovalAuditEvent["action"],
    approval: ExactExternalInstructionApproval,
  ): void {
    this.#audit.push({
      ...(approval.executionBinding === undefined ? {} : { executionBinding: approval.executionBinding }),
      action,
      approvalId: approval.id,
      at: new Date().toISOString(),
      workspaceRoot: approval.workspaceRoot,
      includingSource: approval.includingSource,
      includingSourceSha256: approval.includingSourceSha256,
      targetCanonicalPath: approval.targetCanonicalPath,
      targetIdentity: instructionFileIdentityKey(approval.targetIdentity),
      ...(approval.expiresAt !== undefined ? { expiresAt: approval.expiresAt } : {}),
      principal: approval.principal,
    });
  }
}

export interface ReadInstructionFileOptions {
  readonly executionEnvironment?: InstructionExecutionEnvironment;
  readonly requestedPath: string;
  readonly boundaryRoot: string;
  readonly workspaceRoot: string;
  readonly sourceClass: InstructionSourceClass;
  readonly maximumBytes: number;
  readonly includedBy?: string;
  readonly includedBySha256?: string;
  readonly externalApprovals?: ExternalInstructionApprovalStore;
  /** Test seam used to deterministically replace a path after validation. */
  readonly beforeOpenForTesting?: (path: string) => void | Promise<void>;
  /** Test seam used to mutate an already-open file before its read. */
  readonly beforeReadForTesting?: (path: string) => void | Promise<void>;
}

function isSameOrChild(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function identity(stats: InstructionFileStat): InstructionFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

export function sameInstructionFileIdentity(
  left: InstructionFileIdentity,
  right: InstructionFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Stable, lossless cache key for an identity captured from an open handle. */
export function instructionFileIdentityKey(
  value: InstructionFileIdentity,
): string {
  return [
    value.dev,
    value.ino,
    value.mode,
    value.nlink,
    value.size,
    value.mtimeNs,
    value.ctimeNs,
  ].join(":");
}

function failure(
  opts: ReadInstructionFileOptions,
  reason: InstructionReadFailureReason,
  external: boolean,
  canonicalPath?: string,
  fileIdentity?: InstructionFileIdentity,
): InstructionReadFailure {
  return {
    ok: false,
    reason,
    requestedPath: resolve(opts.requestedPath),
    ...(canonicalPath !== undefined ? { canonicalPath } : {}),
    ...(fileIdentity !== undefined ? { identity: fileIdentity } : {}),
    ...(opts.includedBy !== undefined ? { includedBy: opts.includedBy } : {}),
    external,
  };
}

async function hasSymlinkBelowBoundary(
  lexicalBoundary: string,
  lexicalCandidate: string,
  filesystem: InstructionFilesystem,
): Promise<boolean> {
  const rel = relative(lexicalBoundary, lexicalCandidate);
  if (rel === "") return (await filesystem.lstat(lexicalCandidate)).isSymbolicLink();
  let cursor = lexicalBoundary;
  for (const component of rel.split(sep)) {
    if (component.length === 0 || component === ".") continue;
    cursor = resolve(cursor, component);
    if ((await filesystem.lstat(cursor)).isSymbolicLink()) return true;
  }
  return false;
}

/** Read one stable, regular, single-link instruction object exactly once. */
export async function readInstructionFileSnapshot(
  opts: ReadInstructionFileOptions,
): Promise<InstructionReadResult> {
  const filesystem = instructionFilesystem(opts.executionEnvironment);
  const executionBinding = opts.executionEnvironment === undefined ? undefined : readExecutionEnvironmentBinding(opts.executionEnvironment.binding);
  if (executionBinding !== undefined && [opts.requestedPath, opts.boundaryRoot, opts.workspaceRoot].some((path) => !isAbsolute(path))) {
    throw new TypeError("Selected task instruction paths must be absolute");
  }
  const requestedPath = resolve(opts.requestedPath);
  const lexicalBoundary = resolve(opts.boundaryRoot);
  const workspaceRoot = resolve(opts.workspaceRoot);
  let canonicalBoundary: string;
  try {
    canonicalBoundary = await filesystem.realpath(lexicalBoundary);
  } catch (error) {
    instructionFilesystemErrorCode(error);
    return failure(opts, "boundary_unavailable", false);
  }

  let canonicalPath: string;
  let pathBefore: InstructionFileStat;
  try {
    pathBefore = await filesystem.lstat(requestedPath);
    canonicalPath = await filesystem.realpath(requestedPath);
  } catch (error) {
    const code = instructionFilesystemErrorCode(error);
    return failure(opts, code === "ENOENT" ? "not_found" : "read_error", false);
  }

  const lexicalInside = isSameOrChild(lexicalBoundary, requestedPath);
  const canonicalInside = isSameOrChild(canonicalBoundary, canonicalPath);
  const external = !lexicalInside || !canonicalInside;
  let approval: ExactExternalInstructionApproval | undefined;
  if (external) {
    const includingSource = opts.includedBy;
    const includingSourceSha256 = opts.includedBySha256;
    const targetIdentity = identity(pathBefore);
    if (
      includingSource === undefined ||
      includingSourceSha256 === undefined ||
      opts.externalApprovals === undefined
    ) {
      return failure(
        opts,
        "approval_required",
        true,
        canonicalPath,
        targetIdentity,
      );
    }
    const match = opts.externalApprovals.findExact({
      executionBinding,
      workspaceRoot,
      includingSource,
      includingSourceSha256,
      targetCanonicalPath: canonicalPath,
      targetIdentity,
    });
    if (match.approval === undefined) {
      return failure(
        opts,
        match.expired ? "approval_expired" : "approval_required",
        true,
        canonicalPath,
        targetIdentity,
      );
    }
    approval = match.approval;
  }

  try {
    if (
      pathBefore.isSymbolicLink() ||
      (!external && (await hasSymlinkBelowBoundary(lexicalBoundary, requestedPath, filesystem)))
    ) {
      return failure(opts, "symlink", external, canonicalPath);
    }
  } catch (error) {
    instructionFilesystemErrorCode(error);
    return failure(opts, "unstable", external, canonicalPath);
  }
  if (!pathBefore.isFile()) {
    return failure(opts, "not_regular_file", external, canonicalPath);
  }
  if (pathBefore.nlink !== 1n) {
    return failure(opts, "hard_link", external, canonicalPath);
  }
  if (pathBefore.size > BigInt(opts.maximumBytes)) {
    return failure(opts, "too_large", external, canonicalPath);
  }

  await opts.beforeOpenForTesting?.(requestedPath);
  // A regular file can be swapped for a FIFO between lstat and open. POSIX
  // O_NONBLOCK prevents that open from hanging; the opened-handle fstat below
  // then rejects every non-regular replacement. It is a no-op for regular files.
  let handle: InstructionFileHandle;
  try {
    handle = await filesystem.open(requestedPath);
  } catch (error) {
    const code = instructionFilesystemErrorCode(error);
    return failure(
      opts,
      code === "ELOOP" ? "symlink" : code === "ENOENT" ? "unstable" : "read_error",
      external,
      canonicalPath,
    );
  }

  try {
    const opened = await handle.stat();
    const beforeIdentity = identity(pathBefore);
    const openedIdentity = identity(opened);
    if (
      !opened.isFile() ||
      !sameInstructionFileIdentity(beforeIdentity, openedIdentity) ||
      opened.nlink !== pathBefore.nlink
    ) {
      return failure(opts, "unstable", external, canonicalPath);
    }
    await opts.beforeReadForTesting?.(requestedPath);
    if (approval !== undefined) {
      const includingSource = opts.includedBy!;
      const includingSourceSha256 = opts.includedBySha256!;
      const match = opts.externalApprovals!.findExact({
        executionBinding,
        workspaceRoot,
        includingSource,
        includingSourceSha256,
        targetCanonicalPath: canonicalPath,
        targetIdentity: openedIdentity,
      });
      if (match.approval === undefined || match.approval.id !== approval.id) {
        return failure(
          opts,
          match.expired ? "approval_expired" : "approval_required",
          true,
          canonicalPath,
          openedIdentity,
        );
      }
      // This synchronous audit write is the authorization linearization point:
      // a later revoke stops future reads but cannot retroactively cancel this
      // already-authorized, already-open descriptor.
      approval = match.approval;
      opts.externalApprovals!.recordUse(approval);
    }
    const bytes = await handle.readBounded(opts.maximumBytes);
    if (bytes === null) {
      return failure(opts, "too_large", external, canonicalPath);
    }
    const afterOpened = await handle.stat();
    let afterPath: InstructionFileStat;
    let afterCanonical: string;
    try {
      [afterPath, afterCanonical] = await Promise.all([
        filesystem.lstat(requestedPath),
        filesystem.realpath(requestedPath),
      ]);
    } catch (error) {
      instructionFilesystemErrorCode(error);
      return failure(opts, "unstable", external, canonicalPath);
    }
    if (
      !sameInstructionFileIdentity(openedIdentity, identity(afterOpened)) ||
      !sameInstructionFileIdentity(openedIdentity, identity(afterPath)) ||
      afterCanonical !== canonicalPath ||
      bytes.byteLength !== Number(opened.size)
    ) {
      return failure(opts, "unstable", external, canonicalPath);
    }

    let text: string;
    try {
      text = normalizeExternalText(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      return failure(opts, "invalid_utf8", external, canonicalPath);
    }
    return {
      ok: true,
      snapshot: {
        ...(executionBinding === undefined ? {} : { executionBinding }),
        sourceClass: opts.sourceClass,
        workspaceRoot,
        boundaryRoot: canonicalBoundary,
        requestedPath,
        canonicalPath,
        ...(opts.includedBy !== undefined ? { includedBy: opts.includedBy } : {}),
        identity: openedIdentity,
        bytes,
        text,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...(approval !== undefined ? { externalApprovalId: approval.id } : {}),
      },
    };
  } catch (error) {
    if (!(error instanceof ExecutionEnvironmentError)) throw error;
    const code = instructionFilesystemErrorCode(error);
    return failure(opts, code === "ESTALE" || code === "ENOENT" ? "unstable" : "read_error", external, canonicalPath);
  } finally {
    await handle.close();
  }
}
