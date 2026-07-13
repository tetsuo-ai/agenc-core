/**
 * Default cwd for *daemon process infrastructure* only (e.g. multi-project
 * thread-store primary key, snapshot policy default route).
 *
 * DAE-02: this must NOT be used for agent.create / session.create — those
 * require an absolute client-supplied workspace via
 * `requireAbsoluteWorkspaceCwd` in workspace-cwd.ts.
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
