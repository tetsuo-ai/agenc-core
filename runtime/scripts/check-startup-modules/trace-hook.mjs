// Loaded with `node --import` by the startup-modules gate. Appends one line per
// module this process loads: wall-clock milliseconds, then the module URL.
import { appendFileSync, mkdirSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";

const directory = process.env.AGENC_STARTUP_TRACE_DIR;
if (directory) {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${process.pid}.txt`);
  appendFileSync(file, `# ${JSON.stringify(process.argv.slice(1, 4))}\n`);
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      appendFileSync(file, `${Date.now()} ${url}\n`);
      return result;
    },
  });
}
