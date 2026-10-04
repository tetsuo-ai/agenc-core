import { installGlobalErrorNet } from "../utils/global-error-net.js";

export function formatUnavailableCliCwdMessage(): string {
  return "current working directory is unavailable. Open a valid directory or set AGENC_WORKSPACE.";
}

export function isUnavailableCliCwdError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const nodeError = error as NodeJS.ErrnoException & {
    readonly syscall?: string;
  };
  return nodeError.syscall === "uv_cwd" || error.message.includes("uv_cwd");
}

export function cliStartupErrorMessage(error: unknown): string {
  if (isUnavailableCliCwdError(error)) {
    return formatUnavailableCliCwdMessage();
  }
  return error instanceof Error ? error.message : String(error);
}


/** Keep error handling, buffered output and exit behavior identical at each entry. */
export async function runCliProcessMain(main: () => Promise<number>): Promise<void> {
  installGlobalErrorNet();
  let code: number;
  try {
    code = await main();
  } catch (error) {
    process.stderr.write(`agenc: ${cliStartupErrorMessage(error)}\n`);
    code = 1;
  }
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) => new Promise<void>((resolve) => stream.write("", () => resolve())),
    ),
  );
  process.exit(code);
}
