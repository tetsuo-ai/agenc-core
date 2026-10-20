/**
 * A command line that looked read-only runs without file writes or network
 * access. When it fails on one of them, nothing was changed, and the model
 * must learn that this was AgenC's choice, not the session sandbox and not a
 * read-only workspace, or it would work around a limit that does not exist.
 * The same command run again unchanged takes the ordinary path (see
 * prepareShellObservation), so the notice says exactly that.
 */
const REFUSED_WRITE_OR_NETWORK =
  /read-only file system|operation not permitted|\bE(?:ROFS|PERM)\b|\bEAI_AGAIN\b|\bENOTFOUND\b|\bENETUNREACH\b|could not resolve (?:host|proxy)|temporary failure in name resolution|name or service not known|network is unreachable/iu;

export const READ_ONLY_COMMAND_NOTICE =
  "[read-only] AgenC ran this command without file writes or network access because it looked read-only, " +
  "and the command needed one of them. Nothing was changed. Run the same command again unchanged to run it normally.";

export function readOnlyCommandNotice(output: string, exitCode: number | null): string | null {
  if (exitCode === 0) return null;
  return REFUSED_WRITE_OR_NETWORK.test(output) ? READ_ONLY_COMMAND_NOTICE : null;
}
