/** Fresh-process daemon entrypoint for M4 socket/SDK acceptance tests. */

import { main } from "../../../src/bin/agenc.js";

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(
    `daemon fixture failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
