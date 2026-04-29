// Global types for the Ink host-element set. React 19 resolves intrinsic
// elements via both the classic `JSX.IntrinsicElements` namespace and the
// `React.JSX.IntrinsicElements` namespace, so declare both to cover the
// jsx-runtime resolver paths.
declare namespace JSX {
  interface IntrinsicElements {
    'ink-box': Record<string, unknown>
    'ink-text': Record<string, unknown>
    'ink-root': Record<string, unknown>
    'ink-virtual-text': Record<string, unknown>
    'ink-link': Record<string, unknown>
    'ink-progress': Record<string, unknown>
    'ink-raw-ansi': Record<string, unknown>
  }
}

import 'react'
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': Record<string, unknown>
      'ink-text': Record<string, unknown>
      'ink-root': Record<string, unknown>
      'ink-virtual-text': Record<string, unknown>
      'ink-link': Record<string, unknown>
      'ink-progress': Record<string, unknown>
      'ink-raw-ansi': Record<string, unknown>
    }
  }
}
