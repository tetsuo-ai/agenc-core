#!/usr/bin/env node

import process from "node:process";
import {
  SHIM_BEHAVIOR_RATIO_LIMIT,
  formatShimBehaviorViolation,
  measureShimBehavior,
  measureShimBehaviorForPath,
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

const upstreamIndexForwarder = measure(`
export { Something } from './Something.js'
`);
assert(
  "upstream forwarding fixture remains a ZC-20 failure",
  upstreamIndexForwarder.violates,
  JSON.stringify(upstreamIndexForwarder),
);

const multilineBarrel = measure(`
export {
  Alpha,
  Beta,
  Gamma,
} from './impl.js'
`);
assert(
  "counts multi-line forwarding statements as forwarding LOC",
  multilineBarrel.violates &&
    multilineBarrel.forwardLines === 5 &&
    multilineBarrel.ratio === 1,
  JSON.stringify(multilineBarrel),
);

const packedImportExport = measure(`
import { realImpl } from './impl.js'; export function shim(input: string): string { return realImpl(input) }
`);
assert(
  "flags same-line import plus typed forwarding export",
  packedImportExport.violates && packedImportExport.forwardLines === 1,
  JSON.stringify(packedImportExport),
);

const typedRestWrapper = measure(`
import { installLatest as installLatestImpl } from './installer.js'
export function installLatest(...args: Parameters<typeof installLatestImpl>): ReturnType<typeof installLatestImpl> { return installLatestImpl(...args) }
`);
assert(
  "flags typed rest-argument forwarding wrappers",
  typedRestWrapper.violates,
  JSON.stringify(typedRestWrapper),
);

const existingRuntimeHit = measureShimBehaviorForPath(
  "runtime/src/existing/helpers.ts",
  `
export {
  Alpha,
  Beta,
} from './impl.js'
`,
);
assert(
  "ZC-20 runtime gate formats existing forwarding-heavy files by path",
  existingRuntimeHit &&
    formatShimBehaviorViolation(existingRuntimeHit).includes(
      "runtime/src/existing/helpers.ts",
    ),
  JSON.stringify(existingRuntimeHit),
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

const importHeavyOwnedModule = measure(`
import * as React from 'react'
import type { LocalJSXCommandContext } from '../../../../commands.js'
import { Settings } from '../../components/Settings/Settings.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  return Settings({ onClose: onDone, context, defaultTab: 'Status' })
}
`);
assert(
  "does not flag import-heavy modules without forwarding LOC",
  !importHeavyOwnedModule.violates && importHeavyOwnedModule.forwardLines === 0,
  JSON.stringify(importHeavyOwnedModule),
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
