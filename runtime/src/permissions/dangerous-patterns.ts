/**
 * Ports upstream `src/utils/permissions/dangerousPatterns.ts` constants into
 * the live permission-mode path.
 *
 * The constants are intentionally separate from `mode.ts` so rule stripping
 * uses the same shared Bash/PowerShell interpreter list as the upstream
 * permission setup code instead of an inline subset.
 */

/**
 * Cross-platform code-execution entry points present on both Unix and Windows.
 * Shared to prevent the Bash and PowerShell lists drifting apart on
 * interpreter additions.
 */
export const CROSS_PLATFORM_CODE_EXEC = [
  // Interpreters
  "python",
  "python3",
  "python2",
  "node",
  "deno",
  "tsx",
  "ruby",
  "perl",
  "php",
  "lua",
  // Package runners
  "npx",
  "bunx",
  "npm run",
  "yarn run",
  "pnpm run",
  "bun run",
  // Shells reachable from both Git Bash / WSL on Windows and native Unix
  "bash",
  "sh",
  // Remote arbitrary-command wrapper
  "ssh",
] as const;

export const DANGEROUS_BASH_PATTERNS: readonly string[] = [
  ...CROSS_PLATFORM_CODE_EXEC,
  "zsh",
  "fish",
  "eval",
  "exec",
  "env",
  "xargs",
  "sudo",
  ...(process.env.USER_TYPE === "ant"
    ? [
        "fa run",
        "coo",
        "gh",
        "gh api",
        "curl",
        "wget",
        "git",
        "kubectl",
        "aws",
        "gcloud",
        "gsutil",
      ]
    : []),
];
