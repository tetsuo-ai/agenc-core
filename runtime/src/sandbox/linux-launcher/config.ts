// The leaf constants module, never `../engine/index.js`: this file reads
// these values while it initialises, and the engine index re-exports the
// manager, which reaches back here through the bound read-only profile.
import {
  AGENC_INHERITED_CWD_SANDBOX_PATH,
  AGENC_LINUX_SANDBOX_ARG0,
} from "../engine/constants.js";

export const LINUX_SANDBOX_ARG0 = AGENC_LINUX_SANDBOX_ARG0;
export const DEFAULT_BWRAP_PROGRAM = "bwrap";
export const FALLBACK_BWRAP_PROGRAM = "bubblewrap";
export const SECCOMP_STDIN_FD = 3;
export const INHERITED_CWD_FD = 4;
export const AGENC_PROXY_SOCKET_DIR_PREFIX = "agenc-linux-sandbox-proxy-";
export const INHERITED_CWD_SANDBOX_PATH = AGENC_INHERITED_CWD_SANDBOX_PATH;
