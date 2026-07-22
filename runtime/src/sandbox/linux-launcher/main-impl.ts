import { runLinuxSandboxEntrypoint } from "./lib.js";

const result = await runLinuxSandboxEntrypoint(process.argv.slice(2), {
  onStderr(line) {
    process.stderr.write(`${line}\n`);
  },
});
process.exit(result.exitCode);
