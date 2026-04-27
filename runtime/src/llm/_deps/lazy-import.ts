/**
 * Local _deps stub for the gut/AgenC crossing of
 * `../utils/lazy-import.js`. Generic lazy-import helper used by LLM
 * adapters for optional npm dependencies.
 */

export async function ensureLazyModule<T>(
  packageName: string,
  createError: (message: string) => Error,
  configure: (mod: Record<string, unknown>) => T,
): Promise<T> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(packageName)) as Record<string, unknown>;
  } catch {
    throw createError(
      `${packageName} package not installed. Install it: npm install ${packageName}`,
    );
  }
  return configure(mod);
}
