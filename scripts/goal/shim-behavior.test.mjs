#!/usr/bin/env node

import process from "node:process";
import {
  SHIM_BEHAVIOR_RATIO_LIMIT,
  measureShimBehavior,
} from "./shim-behavior.mjs";

let passed = 0;
let failed = 0;

function assert(name, condition, detail = "") {
  if (condition) {
    process.stdout.write(`✓ ${name}\n`);
    passed += 1;
  } else {
    process.stderr.write(`✗ ${name}\n`);
    if (detail) process.stderr.write(`    ${detail}\n`);
    failed += 1;
  }
}

function measure(source) {
  return measureShimBehavior(source);
}

const hookForwarder = measure(`
import { useContext } from 'react'
import AppContext from '../components/AppContext.js'

const useApp = () => useContext(AppContext)
export default useApp
`);
assert(
  "flags import-heavy hook forwarders",
  hookForwarder.violates && hookForwarder.ratio > SHIM_BEHAVIOR_RATIO_LIMIT,
  JSON.stringify(hookForwarder),
);

const singletonForwarder = measure(`
import type Ink from './ink.js'

const instances = new Map<NodeJS.WriteStream, Ink>()
export default instances
`);
assert(
  "flags import-plus-default-export singleton wrappers",
  singletonForwarder.violates && singletonForwarder.ratio > SHIM_BEHAVIOR_RATIO_LIMIT,
  JSON.stringify(singletonForwarder),
);

const boundary = measure(`
import value from './value.js'
const local = value
export { local }
const other = 1
`);
assert(
  "does not flag the exact 50 percent boundary",
  !boundary.violates && boundary.ratio === SHIM_BEHAVIOR_RATIO_LIMIT,
  JSON.stringify(boundary),
);

const realModule = measure(`
import { createContext, useContext } from 'react'

export type Props = {
  readonly exit: (error?: Error) => void
}

const AppContext = createContext<Props>({
  exit() {},
})

AppContext.displayName = 'InternalAppContext'

export function useApp() {
  return useContext(AppContext)
}

export default AppContext
`);
assert(
  "does not flag a small module with real owned behavior",
  !realModule.violates,
  JSON.stringify(realModule),
);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
