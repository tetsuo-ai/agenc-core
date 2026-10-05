import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// The supported Node 26 runtime can load this ESM package synchronously.
// Keep the original subprocess implementation and load it only at first use.
export function loadExeca(): typeof import('execa') {
  return require('execa')
}
