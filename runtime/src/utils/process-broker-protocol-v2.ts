import { isAbsolute } from "node:path";
import {
  PROCESS_BROKER_MAX_PAYLOAD_BYTES,
  PROCESS_BROKER_MAX_STRINGS,
} from "./process-broker-protocol.js";

export const PROCESS_BROKER_V2_CAPABILITY = "AGB2 owner-pid seccomp-snapshot-sealed-v1";

/** Internal, one-role protocol. No caller-selected descriptor numbers. */
export function serializeProcessBrokerV2Payload(input: {
  readonly program: string;
  readonly args: readonly string[];
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly ownerPid: number;
  readonly seccomp?: Uint8Array;
}): Buffer {
  const { program, args, ownerPid } = input;
  if (!isAbsolute(program) || !Number.isInteger(ownerPid) || ownerPid <= 1 || ownerPid > 0x7fffffff) {
    throw new Error("invalid original process broker owner or program");
  }
  const argv = [program, ...args];
  const environment = Object.entries(input.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => {
      if (!key || key.includes("=") || key.includes("\0")) throw new Error("invalid broker environment name");
      return `${key}=${value}`;
    });
  const strings = [program, ...argv, ...environment];
  if (strings.length > PROCESS_BROKER_MAX_STRINGS || strings.some(value => value.includes("\0"))) {
    throw new Error("invalid process broker invocation");
  }
  const seccomp = input.seccomp === undefined ? undefined : Buffer.from(input.seccomp);
  if (seccomp !== undefined && (seccomp.length < 8 || seccomp.length > 32768 || seccomp.length % 8 !== 0)) {
    throw new Error("invalid seccomp snapshot length");
  }
  const delimiter = args.indexOf("--");
  if (delimiter < 0) throw new Error("missing bwrap command delimiter");
  const descriptorOptions = new Set([
    "--add-seccomp-fd", "--ro-bind-fd", "--bind-fd", "--args", "--file",
    "--bind-data", "--ro-bind-data", "--sync-fd", "--info-fd", "--json-status-fd",
    "--userns", "--userns2", "--pidns", "--block-fd", "--userns-block-fd",
  ]);
  let references = 0;
  for (let i = 0; i < delimiter; ++i) {
    if (descriptorOptions.has(args[i]!.split("=", 1)[0]!) || args[i]!.startsWith("--seccomp=")) throw new Error("unsupported bwrap descriptor role");
    if (args[i] === "--seccomp") {
      if (args[++i] !== "3") throw new Error("invalid seccomp descriptor reference");
      references++;
    }
  }
  if (references !== (seccomp === undefined ? 0 : 1)) throw new Error("seccomp descriptor map mismatch");
  const body = Buffer.from(strings.join("\0") + "\0", "utf8");
  const map = seccomp === undefined ? Buffer.alloc(0) : Buffer.alloc(16);
  if (seccomp !== undefined) {
    map.writeUInt32BE(5, 0);
    map.writeUInt32BE(3, 4);
    map.writeUInt32BE(1, 8);
    map.writeUInt32BE(seccomp.length, 12);
  }
  const size = map.length + body.length + (seccomp?.length ?? 0);
  if (size > PROCESS_BROKER_MAX_PAYLOAD_BYTES) throw new Error("process broker payload exceeds 2 MiB");
  const header = Buffer.alloc(28);
  header.write("AGB2");
  header.writeUInt32BE(size, 4);
  header.writeUInt32BE(argv.length, 8);
  header.writeUInt32BE(environment.length, 12);
  header.writeUInt32BE(seccomp === undefined ? 0 : 1, 20);
  header.writeUInt32BE(ownerPid, 24);
  return Buffer.concat([header, map, body, seccomp ?? Buffer.alloc(0), Buffer.from([0xa5])]);
}
