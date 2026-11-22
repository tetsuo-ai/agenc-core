/**
 * Commands retired with the AgenC account sign-in. The words stay reserved so
 * `agenc login` never becomes a prompt for the model; each one explains what
 * happened instead.
 *
 * @module
 */

const RETIRED_SIGN_IN_COMMANDS: ReadonlySet<string> = new Set([
  "login",
  "logout",
  "whoami",
  "account-access",
]);

const RETIRED_SIGN_IN_NOTICE = [
  "The AgenC account sign-in is retired. AgenC runs on your own provider.",
  "Sign in with a provider: agenc openai-login or agenc grok-login.",
  "Or add a provider key: agenc onboard, or /providers in a session.",
].join("\n");

const RETIRED_REMOTE_NOTICE =
  "Phone remote control (agenc remote) is retired with the AgenC account sign-in.";

/** The notice for a retired command or help topic, or null when it is not one. */
export function retiredCommandNotice(command: string | undefined): string | null {
  if (command === undefined) return null;
  if (RETIRED_SIGN_IN_COMMANDS.has(command)) return RETIRED_SIGN_IN_NOTICE;
  if (command === "remote") return RETIRED_REMOTE_NOTICE;
  return null;
}
