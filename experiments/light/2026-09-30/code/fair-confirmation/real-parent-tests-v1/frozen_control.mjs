// Test-only source extraction. Never evaluates a probe entrypoint or spawns a
// client. Exact pins prevent these characterizations silently changing target.
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';

const pins = {
  v1: '326e2194ad2b17df53d857c3668b254d0aee37f4531f0792c7a03c93cffd5f3c',
  v2: '4758a1d5d7d243b3048ac46f3db977fb52505e222ddc23c8280878721b903d77',
};

export function frozenControl(version, bindings) {
  if (!Object.hasOwn(pins, version)) throw new Error('Unknown frozen version');
  const source = fs.readFileSync(new URL(`../real-parent-${version}/probe.mjs`, import.meta.url), 'utf8');
  if (crypto.createHash('sha256').update(source).digest('hex') !== pins[version]) {
    throw new Error('Frozen probe source changed; independent review required');
  }
  const start = source.indexOf('function start(');
  const end = source.indexOf('const result = { arm', start);
  const listeners = source.match(/  owner\.on\('message',[\s\S]*?owner\.on\('disconnect',[^\n]+/);
  const cleanup = source.match(/finally \{([\s\S]*?)\n\}\n(?:try \{ result\.tool|result\.valid)/);
  const valid = source.match(/result\.valid = ([\s\S]*?);\nwrite/);
  const readyStart = source.indexOf('    const deadline = Date.now() + 15000;');
  const readyEnd = source.indexOf('    const status = await command', readyStart);
  const publication = source.match(/write\(join\(root, 'result.json'\), result\);[\s\S]*?console\.log/);
  if (start < 0 || end < start || !listeners || !cleanup || !valid || readyStart < 0 || !publication) {
    throw new Error('Unexpected frozen source shape');
  }
  const context = vm.createContext({ ...bindings });
  const methods = source.slice(start, end);
  return vm.runInContext(`${methods}
    ({start, wait, command,
      attach: () => {${listeners[0]}},
      cleanup: async () => {${cleanup[1]}},
      readyLoop: async () => {${source.slice(readyStart, readyEnd)}},
      valid: () => (${valid[1]}),
      publish: () => {${publication[0].slice(0, publication[0].lastIndexOf('console.log'))}}
    })`, context);
}
