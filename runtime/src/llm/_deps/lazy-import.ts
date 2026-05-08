/**
 * Local _deps stub for the gut/AgenC crossing of
 * `../utils/lazy-import.js`. Generic lazy-import helper used by LLM
 * adapters for optional npm dependencies.
 *
 * The previous implementation called `await import(packageName)` with a
 * variable specifier. tsup cannot statically discover variable
 * specifiers and silently externalizes them, so the bundled artifact
 * crashed with "Cannot find module 'openai'" / "Cannot find module
 * 'ollama'" at runtime even though the deps were installed.
 *
 * The fix: a literal-import allow-list keyed by package name. New
 * optional deps must be added to LAZY_IMPORTERS explicitly so tsup sees
 * the literal specifier at bundle time. Tests cover the allow-list /
 * miss path.
 */

type LazyModuleLoader = () => Promise<Record<string, unknown>>;

const LAZY_IMPORTERS: Record<string, LazyModuleLoader> = {
  openai: () =>
    import("openai") as unknown as Promise<Record<string, unknown>>,
  ollama: () =>
    import("ollama") as unknown as Promise<Record<string, unknown>>,
};

export async function ensureLazyModule<T>(
  packageName: string,
  createError: (message: string) => Error,
  configure: (mod: Record<string, unknown>) => T,
): Promise<T> {
  const loader = LAZY_IMPORTERS[packageName];
  if (loader === undefined) {
    throw createError(
      `${packageName} is not registered as a lazy-import target. Add it to LAZY_IMPORTERS in runtime/src/llm/_deps/lazy-import.ts so the bundler can see the literal specifier.`,
    );
  }
  let mod: Record<string, unknown>;
  try {
    mod = await loader();
  } catch {
    throw createError(
      `${packageName} package not installed. Install it: npm install ${packageName}`,
    );
  }
  return configure(mod);
}
