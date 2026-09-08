import { agenCDaemonLocalEndpoint } from "../../../src/app-server/transport/unix-socket.ts";
import { runAgenCGatewayCli } from "../../../src/bin/gateway-cli.ts";
import { resolveAgencHome } from "../../../src/config/env.ts";

let status;
const code = await runAgenCGatewayCli({ kind: "status", json: true }, {
  env: process.env,
  stdout: text => { status = JSON.parse(text); },
});
const home = resolveAgencHome();
process.stdout.write(JSON.stringify({ home, socket: agenCDaemonLocalEndpoint(home), status }));
process.exitCode = code;
