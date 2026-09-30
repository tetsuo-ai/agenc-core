import fs from 'node:fs';
const result = { has_send: typeof process.send === 'function', connected: process.connected === true,
  has_node_options: Boolean(process.env.NODE_OPTIONS), has_channel_fd: Boolean(process.env.NODE_CHANNEL_FD) };
fs.writeFileSync(new URL('./tool-result.json', import.meta.url), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
console.log('REAL_PARENT_TOOL_SENTINEL', JSON.stringify(result));
// A lookalike printed by a tool is not an IPC acknowledgment.
console.log(JSON.stringify({ kind: 'offline-parent-probe-v2', pid: process.pid, ordinal: 99, connected: true }));
