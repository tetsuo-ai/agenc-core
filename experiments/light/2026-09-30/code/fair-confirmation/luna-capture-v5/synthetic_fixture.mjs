// TEST ONLY. Never run inside real admission or derive expected hashes from wire.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pythonResult = spawnSync('python3', ['-I', '-S', '-B', '-c',
  'import os,sys;print(os.path.realpath(sys.executable))'], { encoding: 'utf8', timeout: 5000 });
if (pythonResult.status !== 0) throw new Error('Synthetic Python unavailable');
const python = pythonResult.stdout.trim();

export function assembly(recipe = {}) {
  const result = spawnSync(python, ['-I', '-S', '-B', path.join(here, 'fixture_builder.py')], {
    input: JSON.stringify(recipe), encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    env: { LANG: 'C.UTF-8' },
  });
  if (result.status !== 0) throw new Error('Synthetic assembly failed');
  return JSON.parse(result.stdout);
}

export function installBinding(root, recipe = {}) {
  const fixture = assembly(recipe);
  const contractPath = path.join(root, 'binding-contract.json');
  fs.writeFileSync(contractPath, Buffer.from(fixture.contract_base64, 'base64'), { flag: 'wx', mode: 0o600 });
  return { fixture, binding: {
    contract_path: contractPath, expected: fixture.expected,
    deployed_source_pins: fixture.deployed_source_pins,
    binding_source_sha256: sha(fs.readFileSync(path.join(here, '../prompt-binding-v2/prompt_binding.py'))),
    bridge_source_sha256: sha(fs.readFileSync(path.join(here, 'binding_bridge.py'))),
    python_path: python, python_sha256: sha(fs.readFileSync(python)),
  } };
}
