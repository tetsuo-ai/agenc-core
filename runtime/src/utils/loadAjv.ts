import { createRequire } from "node:module";
import type { Ajv } from "ajv";

const require = createRequire(import.meta.url);

/** Keep the synchronous validation API without loading Ajv during daemon boot. */
export function loadAjv(): typeof Ajv {
  return (require("ajv") as typeof import("ajv")).Ajv;
}
