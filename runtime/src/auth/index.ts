export type * from "./backend.js";
export { LocalAuthBackend } from "./backends/local.js";
export type {
  LocalAuthBackendOptions,
  LocalAuthLoginResult,
  LocalAuthWhoamiResult,
} from "./backends/local.js";
export {
  createAuthBackend,
  InvalidAuthBackendConfigError,
  resolveAuthBackendKind,
} from "./selection.js";
export type { AuthBackendSelectionOptions } from "./selection.js";
