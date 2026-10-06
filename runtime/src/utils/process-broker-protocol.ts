/** Private FD 4 protocol shared with native/agenc-process-broker.c. */
export const PROCESS_BROKER_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const PROCESS_BROKER_MAX_STRINGS = 65536;

export function serializeProcessBrokerPayload(
  program: string,
  args: readonly string[],
  options: { readonly argv0?: string; readonly env: NodeJS.ProcessEnv },
): Buffer {
  const argv = [options.argv0 ?? program, ...args];
  const environment = Object.entries(options.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => {
      if (name.length === 0 || name.includes("=") || name.includes("\0")) {
        throw new Error("invalid process broker environment name");
      }
      return `${name}=${value}`;
    });
  const strings = [program, ...argv, ...environment];
  if (program.length === 0 || strings.length > PROCESS_BROKER_MAX_STRINGS ||
      strings.some((value) => value.includes("\0"))) {
    throw new Error("invalid process broker invocation");
  }
  const size = strings.reduce((bytes, value) => bytes + Buffer.byteLength(value) + 1, 0);
  if (size > PROCESS_BROKER_MAX_PAYLOAD_BYTES) {
    throw new Error("process broker payload exceeds 2 MiB");
  }
  const payload = Buffer.alloc(16 + size);
  payload.write("AGB1", 0, "ascii");
  payload.writeUInt32BE(size, 4);
  payload.writeUInt32BE(argv.length, 8);
  payload.writeUInt32BE(environment.length, 12);
  let offset = 16;
  for (const value of strings) offset += payload.write(value, offset, "utf8") + 1;
  return payload;
}
