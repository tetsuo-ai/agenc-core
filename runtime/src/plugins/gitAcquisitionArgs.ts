/**
 * Git configuration for every run that acquires plugin bytes (marketplace
 * clones, plugin git sources). Publisher signatures cover the repository's
 * bytes, so the checkout must reproduce them exactly: Git for Windows ships
 * with `core.autocrlf=true` at system level, which rewrites LF to CRLF on
 * checkout and made every signed marketplace install fail on Windows with
 * "plugin signature payload digest mismatch: commands/pick-model.md"
 * (2026-09-18, fresh Windows 11 profile, Git 2.55). Explicit LF line endings
 * and no conversion give the same bytes on every platform.
 */
export const GIT_CHECKOUT_BYTES_ARGS = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
] as const;
