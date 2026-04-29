import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { join, relative, resolve as resolvePath } from "node:path";

import type { RuntimeExecutionLocation } from "../runtime-contract/types.js";
import { silentLogger, type Logger } from "../utils/logger.js";
import { runCommand } from "../utils/process.js";
import type { DelegationExecutionContext } from "../utils/delegation-execution-context.js";
import { createExecutionEnvelope } from "../workflow/execution-envelope.js";
import {
  isPathWithinRoot,
  normalizeArtifactPaths,
  normalizeWorkspaceRoot,
} from "../workflow/path-normalization.js";

const DEFAULT_WORKTREE_ROOT = "/tmp/agenc-runtime-worktrees";

function hashPathSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function cloneExecutionLocation(
  location: RuntimeExecutionLocation,
): RuntimeExecutionLocation {
  return JSON.parse(JSON.stringify(location)) as RuntimeExecutionLocation;
}

function getEquivalentPathRoots(path: string): readonly string[] {
  const normalizedPath = resolvePath(path);
  if (process.platform !== "darwin") {
    return [normalizedPath];
  }
  if (normalizedPath.startsWith("/private/var/")) {
    return [normalizedPath, normalizedPath.slice("/private".length)];
  }
  if (normalizedPath.startsWith("/var/")) {
    return [normalizedPath, `/private${normalizedPath}`];
  }
  return [normalizedPath];
}

function relativeToEquivalentRoot(
  path: string,
  root: string,
): string | undefined {
  for (const rootCandidate of getEquivalentPathRoots(root)) {
    for (const pathCandidate of getEquivalentPathRoots(path)) {
      if (isPathWithinRoot(pathCandidate, rootCandidate)) {
        return relative(rootCandidate, pathCandidate);
      }
    }
  }
  return undefined;
}

function translatePathForWorktree(
  path: string | undefined,
  location: RuntimeExecutionLocation,
): string | undefined {
  if (
    !path ||
    location.mode !== "worktree" ||
    !location.gitRoot ||
    !location.worktreePath
  ) {
    return path;
  }
  const normalizedPath = resolvePath(path);
  const normalizedGitRoot = resolvePath(location.gitRoot);
  const relativePath = relativeToEquivalentRoot(
    normalizedPath,
    normalizedGitRoot,
  );
  if (relativePath === undefined) {
    return normalizedPath;
  }
  return resolvePath(
    location.worktreePath,
    relativePath,
  );
}

export interface WorktreeIsolationManagerOptions {
  readonly rootDir?: string;
  readonly logger?: Logger;
}

export class WorktreeIsolationManager {
  private readonly rootDir: string;
  private readonly logger: Logger;

  constructor(options: WorktreeIsolationManagerOptions = {}) {
    this.rootDir = resolvePath(options.rootDir ?? DEFAULT_WORKTREE_ROOT);
    this.logger = options.logger ?? silentLogger;
  }

  private async resolveGitRoot(
    startPath: string | undefined,
  ): Promise<string | undefined> {
    const normalizedStart = normalizeWorkspaceRoot(startPath);
    if (!normalizedStart) {
      return undefined;
    }
    const result = await runCommand("git", ["rev-parse", "--show-toplevel"], {
      cwd: normalizedStart,
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    const gitRoot = result.stdout.trim();
    return gitRoot.length > 0 ? resolvePath(gitRoot) : undefined;
  }

  async prepareWorktree(params: {
    readonly workerId: string;
    readonly workspaceRoot?: string;
    readonly workingDirectory?: string;
  }): Promise<RuntimeExecutionLocation> {
    const workspaceRoot = normalizeWorkspaceRoot(
      params.workspaceRoot ?? params.workingDirectory,
    );
    const workingDirectory = normalizeWorkspaceRoot(
      params.workingDirectory ?? params.workspaceRoot,
    );
    const gitRoot = await this.resolveGitRoot(workingDirectory ?? workspaceRoot);
    if (!gitRoot) {
      return {
        mode: "local",
        ...(workspaceRoot ? { workspaceRoot } : {}),
        ...(workingDirectory ? { workingDirectory } : {}),
        fallbackReason: "workspace_not_git_backed",
      };
    }

    const worktreePath = join(
      this.rootDir,
      hashPathSegment(gitRoot),
      params.workerId,
    );
    await mkdir(join(this.rootDir, hashPathSegment(gitRoot)), {
      recursive: true,
    });

    let hasExistingWorktree = false;
    try {
      await access(join(worktreePath, ".git"));
      hasExistingWorktree = true;
    } catch {
      hasExistingWorktree = false;
    }

    if (!hasExistingWorktree) {
      const createResult = await runCommand(
        "git",
        ["-C", gitRoot, "worktree", "add", "--detach", worktreePath, "HEAD"],
        { cwd: gitRoot },
      );
      if (createResult.exitCode !== 0) {
        throw new Error(
          createResult.stderr.trim() ||
            createResult.stdout.trim() ||
            `Failed to create worktree for ${params.workerId}`,
        );
      }
    }

    const worktreeRefResult = await runCommand(
      "git",
      ["-C", worktreePath, "rev-parse", "HEAD"],
      { cwd: worktreePath },
    );
    const worktreeRef =
      worktreeRefResult.exitCode === 0 && worktreeRefResult.stdout.trim().length > 0
        ? worktreeRefResult.stdout.trim()
        : undefined;

    return {
      mode: "worktree",
      ...(workspaceRoot ? { workspaceRoot } : {}),
      workingDirectory:
        translatePathForWorktree(workingDirectory ?? workspaceRoot, {
          mode: "worktree",
          gitRoot,
          worktreePath,
        }) ?? worktreePath,
      gitRoot,
      worktreePath,
      ...(worktreeRef ? { worktreeRef } : {}),
      lifecycle: "active",
    };
  }

  translatePath(
    path: string | undefined,
    location: RuntimeExecutionLocation | undefined,
  ): string | undefined {
    if (!location) return path;
    return translatePathForWorktree(path, location);
  }

  translateExecutionContext(
    context: DelegationExecutionContext | undefined,
    location: RuntimeExecutionLocation | undefined,
  ): DelegationExecutionContext | undefined {
    if (!context || !location || location.mode !== "worktree") {
      return context;
    }
    return createExecutionEnvelope({
      workspaceRoot: translatePathForWorktree(context.workspaceRoot, location),
      allowedReadRoots: (context.allowedReadRoots ?? []).map((root) =>
        translatePathForWorktree(root, location),
      ),
      allowedWriteRoots: (context.allowedWriteRoots ?? []).map((root) =>
        translatePathForWorktree(root, location),
      ),
      allowedTools: context.allowedTools,
      inputArtifacts: normalizeArtifactPaths(
        (context.inputArtifacts ?? []).map((artifact) =>
          translatePathForWorktree(artifact, location),
        ),
        translatePathForWorktree(context.workspaceRoot, location),
      ),
      requiredSourceArtifacts: normalizeArtifactPaths(
        (context.requiredSourceArtifacts ?? []).map((artifact) =>
          translatePathForWorktree(artifact, location),
        ),
        translatePathForWorktree(context.workspaceRoot, location),
      ),
      targetArtifacts: normalizeArtifactPaths(
        (context.targetArtifacts ?? []).map((artifact) =>
          translatePathForWorktree(artifact, location),
        ),
        translatePathForWorktree(context.workspaceRoot, location),
      ),
      effectClass: context.effectClass,
      verificationMode: context.verificationMode,
      stepKind: context.stepKind,
      role: context.role,
      artifactRelations: (context.artifactRelations ?? []).map((relation) => ({
        relationType: relation.relationType,
        artifactPath:
          translatePathForWorktree(relation.artifactPath, location) ??
          relation.artifactPath,
      })),
      completionContract: context.completionContract,
      fallbackPolicy: context.fallbackPolicy,
      resumePolicy: context.resumePolicy,
      approvalProfile: context.approvalProfile,
      compatibilitySource: context.compatibilitySource,
    });
  }

  async cleanupLocation(
    location: RuntimeExecutionLocation | undefined,
  ): Promise<RuntimeExecutionLocation | undefined> {
    if (
      !location ||
      location.mode !== "worktree" ||
      !location.gitRoot ||
      !location.worktreePath
    ) {
      return location ? cloneExecutionLocation(location) : undefined;
    }

    const statusResult = await runCommand(
      "git",
      ["-C", location.worktreePath, "status", "--porcelain", "--untracked-files=normal"],
      { cwd: location.worktreePath },
    );
    const clean =
      statusResult.exitCode === 0 && statusResult.stdout.trim().length === 0;
    if (!clean) {
      return {
        ...cloneExecutionLocation(location),
        lifecycle: "retained_dirty",
      };
    }

    const removeResult = await runCommand(
      "git",
      ["-C", location.gitRoot, "worktree", "remove", "--force", location.worktreePath],
      { cwd: location.gitRoot },
    );
    if (removeResult.exitCode !== 0) {
      this.logger.warn("Failed to remove clean worker worktree", {
        gitRoot: location.gitRoot,
        worktreePath: location.worktreePath,
        stderr: removeResult.stderr.trim(),
      });
      return {
        ...cloneExecutionLocation(location),
        lifecycle: "retained_dirty",
      };
    }

    return {
      ...cloneExecutionLocation(location),
      lifecycle: "removed",
    };
  }
}
