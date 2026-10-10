const AGENC_INTERNAL_ARG_PREFIX = "__agenc";

/**
 * Drop every `__agenc*` key from model-supplied tool-call arguments.
 *
 * `__agenc*` keys (e.g. `__agencSessionAllowedRoots`, `__agencSessionId`)
 * are a TRUSTED INTERNAL channel the runtime injects post-approval to
 * scope filesystem confinement. A model that emits them directly could
 * widen its own allowed roots (audit #1/#2/#4). We strip them at the
 * dispatch boundary so the only `__agenc*` values that ever reach
 * `tool.execute` are those the runtime itself adds afterwards. Returns
 * the input untouched when there is nothing to strip.
 */
export function stripModelSuppliedAgenCInternalArgs(
  input: Record<string, unknown>,
): Record<string, unknown> {
  let needsStrip = false;
  for (const key of Object.keys(input)) {
    if (key.startsWith(AGENC_INTERNAL_ARG_PREFIX)) {
      needsStrip = true;
      break;
    }
  }
  if (!needsStrip) return input;
  // Own data properties only: assigning a model's JSON `__proto__` key onto
  // `{}` would make it the copy's prototype instead of an argument.
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => !key.startsWith(AGENC_INTERNAL_ARG_PREFIX),
    ),
  );
}
