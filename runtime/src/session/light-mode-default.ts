/**
 * The session mode a new session starts in when its creator did not choose
 * one: `--light` / `--standard` on the CLI, or an explicit `lightMode` from a
 * daemon client. Light is the default; config.toml `light_mode = false` opts
 * out. Resumed, attached and recovered sessions keep the mode they recorded
 * and never pass through here.
 */
export const DEFAULT_LIGHT_MODE = true;

/** config.toml `light_mode`, then the release default. */
export function resolveDefaultLightMode(configured: boolean | undefined): boolean {
  return configured ?? DEFAULT_LIGHT_MODE;
}

/**
 * Settle a new session's mode. An explicit `lightMode` (a CLI flag or a
 * client's own choice) wins over config and the default.
 */
export function withDefaultLightMode<T extends { readonly lightMode?: boolean }>(
  options: T,
  configured: boolean | undefined,
): T & { readonly lightMode: boolean } {
  if (options.lightMode !== undefined) {
    return options as T & { readonly lightMode: boolean };
  }
  return Object.freeze({
    ...options,
    lightMode: resolveDefaultLightMode(configured),
  });
}
