// An owner process for the prepared-launch tests: it prepares a contained
// launch in the directory it is given, prints the launch's processes once its
// watchdog is ready, and then waits to be killed.
import {
  prepareContainedProcessLaunch,
  preparedContainedProcessLaunchForTesting,
} from "../../../src/utils/supervisedProcess.js";

const cwd = process.argv[2];
if (cwd === undefined) throw new Error("usage: prepared-launch-owner <cwd>");
prepareContainedProcessLaunch(cwd);
const poll = setInterval(() => {
  const launch = preparedContainedProcessLaunchForTesting();
  if (launch?.ready !== true) return;
  clearInterval(poll);
  process.stdout.write(`${JSON.stringify(launch)}\n`);
  // The prepared launch keeps nothing alive; this does.
  setInterval(() => {}, 60_000);
}, 10);
