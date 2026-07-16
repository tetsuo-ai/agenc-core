import { stat } from "node:fs/promises";
import { relative, resolve as resolvePath } from "node:path";

import type { Tool } from "../types.js";
import { collectWorkspaceLanguages } from "./code-intel.js";
import {
  codingToolMetadata,
  errorResult,
  listRepoFiles,
  MANIFEST_NAMES,
  MAX_DIFF_BYTES,
  okResult,
  parseStatusPorcelain,
  parseWorktreePorcelain,
  resolveRepoRoot,
  runSandboxedToolCommand,
  summarizeChanges,
  toOptionalString,
  toOptionalStringArray,
  type CodingToolConfig,
} from "./coding-common.js";
import {
  resolveToolAllowedPaths,
  safePath,
} from "./filesystem.js";

function runGitToolCommand(
  toolArgs: Record<string, unknown>,
  commandArgs: readonly string[],
  cwd: string,
  maxBuffer?: number,
) {
  return runSandboxedToolCommand({
    toolArgs,
    program: "git",
    args: commandArgs,
    cwd,
    ...(maxBuffer !== undefined ? { maxBuffer } : {}),
  });
}

export function createGitAndRepoTools(config: CodingToolConfig): readonly Tool[] {
  const repoInventoryTool: Tool = {
    name: "system.repoInventory",
    description:
      "Return a repo-local coding inventory: repo root, branch, current worktree, top-level directories, manifests, file counts, and detected languages.",
    metadata: codingToolMetadata("system.repoInventory", false, ["coding", "operator"], {
      family: "repo",
      deferred: true,
      keywords: ["inventory", "manifest", "language", "worktree"],
    }),
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const files = await listRepoFiles(repoRoot, args);
      const status = await runGitToolCommand(
        args,
        ["-C", repoRoot, "status", "--porcelain", "--branch"],
        repoRoot,
      );
      const branchInfo = parseStatusPorcelain(status.stdout);
      const languages = await collectWorkspaceLanguages(repoRoot, args);
      const topLevelDirectories = [...new Set(
        files
          .map((filePath) => relative(repoRoot, filePath).split(/[\\/]/)[0] ?? "")
          .filter((segment) => segment.length > 0 && !segment.includes(".")),
      )].slice(0, 50);
      const manifests = (
        await Promise.all(
          MANIFEST_NAMES.map(async (name) => {
            const manifestPath = resolvePath(repoRoot, name);
            const manifestStat = await stat(manifestPath).catch(() => undefined);
            return manifestStat?.isFile() ? name : null;
          }),
        )
      ).filter(
        (entry): entry is (typeof MANIFEST_NAMES)[number] => entry !== null,
      );
      const worktrees = await runGitToolCommand(
        args,
        ["-C", repoRoot, "worktree", "list", "--porcelain"],
        repoRoot,
      );
      return okResult({
        repoRoot,
        branch: branchInfo.branch ?? null,
        upstream: branchInfo.upstream ?? null,
        ahead: branchInfo.ahead ?? 0,
        behind: branchInfo.behind ?? 0,
        detached: branchInfo.detached,
        fileCount: files.length,
        topLevelDirectories,
        manifests,
        languages,
        worktrees: parseWorktreePorcelain(worktrees.stdout).map((worktree) => {
          return {
            worktree: worktree.path,
            branch: worktree.branch,
            head: worktree.head,
            bare: worktree.bare,
            detached: worktree.detached,
          };
        }),
      });
    },
  };

  const gitStatusTool: Tool = {
    name: "system.gitStatus",
    description: "Return structured git status for the current repo or worktree.",
    metadata: codingToolMetadata("system.gitStatus", false, ["coding", "validation"], {
      family: "git",
      deferred: true,
      keywords: ["status", "changed", "dirty", "branch"],
    }),
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    async execute(args) {
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const result = await runGitToolCommand(
        args,
        ["-C", repoRoot, "status", "--porcelain", "--branch"],
        repoRoot,
      );
      if (result.exitCode !== 0) {
        return errorResult(result.stderr.trim() || result.stdout.trim() || "git status failed");
      }
      const parsed = parseStatusPorcelain(result.stdout);
      return okResult({
        repoRoot,
        ...parsed,
        summary: summarizeChanges(parsed.changed),
      });
    },
  };

  const gitDiffTool: Tool = {
    name: "system.gitDiff",
    description: "Return a structured git diff for the current repo/worktree, staged changes, or specific revisions.",
    metadata: codingToolMetadata("system.gitDiff", false, ["coding", "review"], {
      family: "git",
      deferred: true,
      keywords: ["diff", "patch", "staged", "review"],
    }),
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        staged: { type: "boolean" },
        fromRef: { type: "string" },
        toRef: { type: "string" },
        filePaths: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const command = ["-C", repoRoot, "diff", "--no-ext-diff", "--binary"];
      if (args.staged === true) command.push("--cached");
      const fromRef = toOptionalString(args.fromRef);
      const toRef = toOptionalString(args.toRef);
      // Refs are model-controlled. A ref beginning with "-" is parsed by git as
      // an option (e.g. "--output=/path" clobbers files, "--ext-diff" enables
      // RCE), so reject those rather than smuggling them into argv.
      if (fromRef?.startsWith("-")) {
        return errorResult("fromRef must not begin with '-'");
      }
      if (toRef?.startsWith("-")) {
        return errorResult("toRef must not begin with '-'");
      }
      if (fromRef && toRef) {
        command.push(fromRef, toRef);
      } else if (fromRef) {
        command.push(fromRef);
      }
      const filePaths = toOptionalStringArray(args.filePaths);
      if (filePaths && filePaths.length > 0) {
        command.push("--", ...filePaths);
      }
      const result = await runGitToolCommand(args, command, repoRoot, MAX_DIFF_BYTES);
      if (result.exitCode !== 0) {
        return errorResult(result.stderr.trim() || result.stdout.trim() || "git diff failed");
      }
      return okResult({
        repoRoot,
        staged: args.staged === true,
        fromRef: fromRef ?? null,
        toRef: toRef ?? null,
        truncated: Buffer.byteLength(result.stdout, "utf8") >= MAX_DIFF_BYTES,
        diff: result.stdout,
      });
    },
  };

  const gitShowTool: Tool = {
    name: "system.gitShow",
    description: "Show a commit, object, or path revision from git with optional patch content.",
    metadata: codingToolMetadata("system.gitShow", false, ["coding", "review"], {
      family: "git",
      deferred: true,
      keywords: ["show", "commit", "object", "revision"],
    }),
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        ref: { type: "string" },
        noPatch: { type: "boolean" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    async execute(args) {
      const ref = toOptionalString(args.ref);
      if (!ref) return errorResult("ref must be a non-empty string");
      // The ref is model-controlled. A ref beginning with "-" is parsed by git
      // as an option (e.g. "--output=/path" clobbers files, "--ext-diff"
      // enables RCE), so reject it rather than smuggling it into argv.
      if (ref.startsWith("-")) {
        return errorResult("ref must not begin with '-'");
      }
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const result = await runGitToolCommand(
        args,
        ["-C", repoRoot, "show", ...(args.noPatch === true ? ["--stat", "--summary"] : []), ref],
        repoRoot,
        MAX_DIFF_BYTES,
      );
      if (result.exitCode !== 0) {
        return errorResult(result.stderr.trim() || result.stdout.trim() || "git show failed");
      }
      return okResult({
        repoRoot,
        ref,
        output: result.stdout,
      });
    },
  };

  const gitBranchInfoTool: Tool = {
    name: "system.gitBranchInfo",
    description: "Return current branch, upstream, ahead/behind, HEAD, and worktree context.",
    metadata: codingToolMetadata("system.gitBranchInfo", false, ["coding", "validation"], {
      family: "git",
      deferred: true,
      keywords: ["branch", "upstream", "ahead", "behind", "head"],
    }),
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    async execute(args) {
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const head = await runGitToolCommand(
        args,
        ["-C", repoRoot, "rev-parse", "HEAD"],
        repoRoot,
      );
      const status = await runGitToolCommand(
        args,
        ["-C", repoRoot, "status", "--porcelain", "--branch"],
        repoRoot,
      );
      const parsed = parseStatusPorcelain(status.stdout);
      return okResult({
        repoRoot,
        head: head.stdout.trim() || null,
        branch: parsed.branch ?? null,
        upstream: parsed.upstream ?? null,
        ahead: parsed.ahead ?? 0,
        behind: parsed.behind ?? 0,
        detached: parsed.detached,
      });
    },
  };

  const gitChangeSummaryTool: Tool = {
    name: "system.gitChangeSummary",
    description: "Return a cheap structured summary of staged, unstaged, untracked, and conflicted files.",
    metadata: codingToolMetadata("system.gitChangeSummary", false, ["coding", "validation"], {
      family: "git",
      deferred: true,
      keywords: ["changes", "summary", "staged", "unstaged", "untracked"],
    }),
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    async execute(args) {
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const status = await runGitToolCommand(
        args,
        ["-C", repoRoot, "status", "--porcelain", "--branch"],
        repoRoot,
      );
      if (status.exitCode !== 0) {
        return errorResult(status.stderr.trim() || status.stdout.trim() || "git status failed");
      }
      const parsed = parseStatusPorcelain(status.stdout);
      return okResult({
        repoRoot,
        summary: summarizeChanges(parsed.changed),
        totalChanged: parsed.changed.length,
      });
    },
  };

  const gitWorktreeListTool: Tool = {
    name: "system.gitWorktreeList",
    description: "List git worktrees for the current repository.",
    metadata: codingToolMetadata("system.gitWorktreeList", false, ["coding", "operator"], {
      family: "git",
      deferred: true,
      keywords: ["worktree", "list", "branch"],
    }),
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    async execute(args) {
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const result = await runGitToolCommand(
        args,
        ["-C", repoRoot, "worktree", "list", "--porcelain"],
        repoRoot,
      );
      if (result.exitCode !== 0) {
        return errorResult(result.stderr.trim() || result.stdout.trim() || "git worktree list failed");
      }
      const worktrees = parseWorktreePorcelain(result.stdout);
      return okResult({ repoRoot, worktrees });
    },
  };

  const gitWorktreeCreateTool: Tool = {
    name: "system.gitWorktreeCreate",
    description: "Create a git worktree from the current repository.",
    metadata: codingToolMetadata("system.gitWorktreeCreate", true, ["coding", "operator"], {
      family: "git",
      deferred: true,
      keywords: ["worktree", "create", "add", "branch"],
    }),
    requiresApproval: true,
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo root or any path inside the repo." },
        worktreePath: { type: "string", description: "Target path for the new worktree." },
        branch: { type: "string" },
        ref: { type: "string" },
        detached: { type: "boolean" },
      },
      required: ["worktreePath"],
      additionalProperties: false,
    },
    async execute(args) {
      const worktreePath = toOptionalString(args.worktreePath);
      if (!worktreePath) return errorResult("worktreePath must be a non-empty string");
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const allowedPaths = resolveToolAllowedPaths(config.allowedPaths, args);
      const safeWorktreePath = await safePath(worktreePath, allowedPaths);
      if (!safeWorktreePath.safe) {
        return errorResult(safeWorktreePath.reason ?? "worktreePath is outside allowed directories");
      }
      const command = ["-C", repoRoot, "worktree", "add"];
      if (args.detached === true) command.push("--detach");
      const branch = toOptionalString(args.branch);
      const ref = toOptionalString(args.ref);
      // branch/ref are model-controlled. A value beginning with "-" is parsed by
      // git as an option (e.g. "--lock", "--orphan", "--detach"), letting a model
      // smuggle worktree-add options into argv, so reject those rather than
      // passing them through.
      if (branch?.startsWith("-")) {
        return errorResult("branch must not begin with '-'");
      }
      if (ref?.startsWith("-")) {
        return errorResult("ref must not begin with '-'");
      }
      if (branch) {
        command.push("-b", branch);
      }
      command.push(safeWorktreePath.resolved);
      if (ref) {
        command.push(ref);
      }
      const result = await runGitToolCommand(args, command, repoRoot);
      if (result.exitCode !== 0) {
        return errorResult(
          result.stderr.trim() || result.stdout.trim() || "git worktree add failed",
        );
      }
      return okResult({
        repoRoot,
        worktreePath: safeWorktreePath.resolved,
        branch: branch ?? null,
        ref: ref ?? null,
        detached: args.detached === true,
        output: result.stdout.trim(),
      });
    },
  };

  const gitWorktreeRemoveTool: Tool = {
    name: "system.gitWorktreeRemove",
    description: "Remove a git worktree. Dirty worktrees are blocked unless force=true.",
    metadata: codingToolMetadata("system.gitWorktreeRemove", true, ["coding", "operator"], {
      family: "git",
      deferred: true,
      keywords: ["worktree", "remove", "delete", "force"],
    }),
    requiresApproval: true,
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo root or any path inside the repo." },
        worktreePath: { type: "string" },
        force: { type: "boolean" },
      },
      required: ["worktreePath"],
      additionalProperties: false,
    },
    async execute(args) {
      const worktreePath = toOptionalString(args.worktreePath);
      if (!worktreePath) return errorResult("worktreePath must be a non-empty string");
      const repoRoot = await resolveRepoRoot({ config, args, pathArgKeys: ["path"] });
      if (typeof repoRoot !== "string") return errorResult(repoRoot.error);
      const allowedPaths = resolveToolAllowedPaths(config.allowedPaths, args);
      const safeWorktreePath = await safePath(worktreePath, allowedPaths);
      if (!safeWorktreePath.safe) {
        return errorResult(safeWorktreePath.reason ?? "worktreePath is outside allowed directories");
      }
      const status = await runGitToolCommand(
        args,
        ["-C", safeWorktreePath.resolved, "status", "--porcelain", "--untracked-files=normal"],
        safeWorktreePath.resolved,
      );
      const dirty = status.exitCode === 0 && status.stdout.trim().length > 0;
      if (dirty && args.force !== true) {
        return errorResult(
          `Worktree ${safeWorktreePath.resolved} has uncommitted changes; re-run with force=true to remove it.`,
        );
      }
      const result = await runGitToolCommand(
        args,
        [
          "-C",
          repoRoot,
          "worktree",
          "remove",
          ...(args.force === true ? ["--force"] : []),
          safeWorktreePath.resolved,
        ],
        repoRoot,
      );
      if (result.exitCode !== 0) {
        return errorResult(
          result.stderr.trim() || result.stdout.trim() || "git worktree remove failed",
        );
      }
      return okResult({
        repoRoot,
        worktreePath: safeWorktreePath.resolved,
        dirty,
        removed: true,
      });
    },
  };

  const gitWorktreeStatusTool: Tool = {
    name: "system.gitWorktreeStatus",
    description: "Return branch, HEAD, and cleanliness for a worktree path.",
    metadata: codingToolMetadata("system.gitWorktreeStatus", false, ["coding", "operator"], {
      family: "git",
      deferred: true,
      keywords: ["worktree", "status", "dirty", "branch"],
    }),
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      properties: {
        worktreePath: { type: "string" },
      },
      required: ["worktreePath"],
      additionalProperties: false,
    },
    async execute(args) {
      const worktreePath = toOptionalString(args.worktreePath);
      if (!worktreePath) return errorResult("worktreePath must be a non-empty string");
      const allowedPaths = resolveToolAllowedPaths(config.allowedPaths, args);
      const safeWorktreePath = await safePath(worktreePath, allowedPaths);
      if (!safeWorktreePath.safe) {
        return errorResult(safeWorktreePath.reason ?? "worktreePath is outside allowed directories");
      }
      const branch = await runGitToolCommand(
        args,
        ["-C", safeWorktreePath.resolved, "rev-parse", "--abbrev-ref", "HEAD"],
        safeWorktreePath.resolved,
      );
      const head = await runGitToolCommand(
        args,
        ["-C", safeWorktreePath.resolved, "rev-parse", "HEAD"],
        safeWorktreePath.resolved,
      );
      const status = await runGitToolCommand(
        args,
        ["-C", safeWorktreePath.resolved, "status", "--porcelain", "--untracked-files=normal"],
        safeWorktreePath.resolved,
      );
      return okResult({
        worktreePath: safeWorktreePath.resolved,
        branch: branch.stdout.trim() || null,
        head: head.stdout.trim() || null,
        dirty: status.stdout.trim().length > 0,
        statusLines: status.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      });
    },
  };

  return [
    repoInventoryTool,
    gitStatusTool,
    gitDiffTool,
    gitShowTool,
    gitBranchInfoTool,
    gitChangeSummaryTool,
    gitWorktreeListTool,
    gitWorktreeCreateTool,
    gitWorktreeRemoveTool,
    gitWorktreeStatusTool,
  ];
}
