/**
 * YAML parsing wrapper.
 *
 * Uses Bun.YAML (built-in, zero-cost) when running under Bun, otherwise falls
 * back to js-yaml. The package is lazy-required inside the
 * non-Bun branch so native Bun builds never load the ~270KB yaml parser.
 */

import { createRequire } from 'node:module'
import type { load as loadYaml } from 'js-yaml'

const require = createRequire(import.meta.url)

export function parseYaml(input: string): unknown {
  if (typeof Bun !== 'undefined') {
    // @ts-expect-error -- temporary boundary: moved utility depends on not-yet-absorbed subsystem types.
    return Bun.YAML.parse(input)
  }
  return (require('js-yaml') as { load: typeof loadYaml }).load(input)
}
