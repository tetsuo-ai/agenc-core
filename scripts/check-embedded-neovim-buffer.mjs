#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const matrixPath = path.resolve(import.meta.dirname, "../parity/embedded-neovim-buffer.json");
const reviewsDir = path.resolve(import.meta.dirname, "../parity/embedded-neovim-buffer.reviews");
const rowReviewMode = process.env.AGENC_EMBEDDED_NEOVIM_CONTRACT_ROW_REVIEW === "1";
const defaultFlags = [
  "--require-inventory",
  "--require-edge-cases",
  "--require-reviews",
  "--require-commands",
  "--run-commands",
];
const checkerFlags = rowReviewMode
  ? defaultFlags.filter((flag) => flag !== "--require-reviews" && flag !== "--run-commands")
  : defaultFlags;

function candidateCheckerPaths() {
  const explicit = process.env.AGENC_IMPLEMENTATION_CONTRACT_CHECKER;
  if (explicit) {
    return [path.resolve(explicit)];
  }

  const home = homedir();
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(home, ".codex");
  const agentsHome = process.env.AGENTS_HOME
    ? path.resolve(process.env.AGENTS_HOME)
    : path.join(home, ".agents");
  const claudeHome = process.env.CLAUDE_HOME
    ? path.resolve(process.env.CLAUDE_HOME)
    : path.join(home, ".claude");

  return [
    path.join(codexHome, "skills", "implementation-contract", "scripts", "check_contract.mjs"),
    path.join(
      codexHome,
      "skills",
      "implementation-contract.bak-pre-symlink-20260430",
      "scripts",
      "check_contract.mjs",
    ),
    path.join(agentsHome, "skills", "implementation-contract", "scripts", "check_contract.mjs"),
    path.join(claudeHome, "skills", "implementation-contract", "scripts", "check_contract.mjs"),
  ];
}

function resolveCheckerPath() {
  const candidates = candidateCheckerPaths();
  const checkerPath = candidates.find((candidate) => existsSync(candidate));
  if (checkerPath) {
    return checkerPath;
  }

  process.stderr.write(
    [
      "implementation-contract checker not found.",
      "Set AGENC_IMPLEMENTATION_CONTRACT_CHECKER=/path/to/check_contract.mjs or install the implementation-contract skill.",
      "Checked:",
      ...candidates.map((candidate) => `- ${candidate}`),
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function relativePath(filePath) {
  return path.relative(repoRoot, filePath) || ".";
}

function readJson(filePath, errors) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`${relativePath(filePath)} is not readable JSON: ${error.message}`);
    return undefined;
  }
}

function checkApprovedReview(filePath, label, errors) {
  if (!existsSync(filePath)) {
    errors.push(`missing ${label} review: ${relativePath(filePath)}`);
    return;
  }

  const review = readJson(filePath, errors);
  if (review && review.verdict !== "APPROVED") {
    errors.push(
      `${relativePath(filePath)} must have verdict "APPROVED" before final contract checks`,
    );
  }
}

function validateLocalRequirements() {
  const errors = [];
  const matrix = readJson(matrixPath, errors);
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : undefined;

  if (!rows) {
    errors.push(`${relativePath(matrixPath)} must include a rows array`);
  } else {
    for (const [index, row] of rows.entries()) {
      const rowId = typeof row?.id === "string" && row.id.length > 0
        ? row.id
        : `row ${index + 1}`;

      if (!Array.isArray(row?.edgeCases) || row.edgeCases.length === 0) {
        errors.push(`${rowId} must include at least one edgeCases entry`);
      }

      if (!rowReviewMode) {
        checkApprovedReview(
          path.join(reviewsDir, `${rowId}.json`),
          `row ${rowId}`,
          errors,
        );
      }
    }
  }

  if (!rowReviewMode) {
    checkApprovedReview(path.join(reviewsDir, "_contract.json"), "aggregate", errors);
  }

  if (errors.length > 0) {
    process.stderr.write(
      [
        "embedded-neovim contract wrapper validation failed:",
        ...errors.map((error) => `- ${error}`),
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
}

function supportedCheckerFlags(checkerPath) {
  const help = spawnSync(process.execPath, [checkerPath, "--help"], {
    encoding: "utf8",
  });
  if (help.error || help.status !== 0) {
    return new Set(defaultFlags);
  }

  const helpText = `${help.stdout}\n${help.stderr}`;
  return new Set(defaultFlags.filter((flag) => helpText.includes(flag)));
}

const checkerPath = resolveCheckerPath();
validateLocalRequirements();
const supportedFlags = supportedCheckerFlags(checkerPath);
const delegatedFlags = checkerFlags.filter((flag) => supportedFlags.has(flag));
const result = spawnSync(process.execPath, [
  checkerPath,
  "--matrix",
  matrixPath,
  ...delegatedFlags,
  ...process.argv.slice(2),
], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
