/**
 * DAE-02: Prefer an explicit workspace env over the daemon process cwd so
 * multi-project agents don't inherit the first shell that autostarted the
 * daemon when `cwd` is omitted on create.
 *
 * Note: clients that omit cwd and do not set these env vars still fall back
 * to process.cwd() (daemon OS cwd). First-party agent-cli always sends cwd.
 */
export function resolveDaemonDefaultCwd(env: NodeJS.ProcessEnv = process.env): string {
  const workspace =
    env.AGENC_WORKSPACE?.trim() ||
    env.AGENC_PROJECT_DIR?.trim() ||
    env.PWD?.trim();
  if (workspace && workspace.length > 0) {
    return workspace;
  }
  return process.cwd();
}
