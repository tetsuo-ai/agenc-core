// AgenC global-config shim for the selection wholesale-port.
//
// openclaude's getGlobalConfig() reads from their global config store;
// AgenC has its own config layer but no copyOnSelect toggle today, so
// this shim returns the openclaude default. Replace the body with the
// real AgenC config read once a copyOnSelect flag is introduced.

export interface AgenCGlobalConfigShim {
  readonly copyOnSelect: boolean;
}

export function getGlobalConfig(): AgenCGlobalConfigShim {
  return { copyOnSelect: true };
}
