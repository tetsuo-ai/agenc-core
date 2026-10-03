// Loaded with `node --import <this file>?dir=<trace directory>` by the
// startup-modules gate. Appends one line per module this process loads:
// wall-clock milliseconds, then the module URL. The directory travels in the
// import URL, so the gate's private environment stays unchanged.
import { appendFileSync, mkdirSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";

const directory = new URL(import.meta.url).searchParams.get("dir");
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
