/** Workspace root override from AGENC_WORKSPACE, or `undefined`. */
export function resolveWorkspace(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const e = env;
  return e.AGENC_WORKSPACE && e.AGENC_WORKSPACE.length > 0
    ? e.AGENC_WORKSPACE
    : undefined;
}
