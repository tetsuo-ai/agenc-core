// Stub — global types for Ink renderer.
//
// Two JSX resolution paths exist depending on tsconfig:
//   - tsconfig.tui.json sets "types": [] so @types/react is absent; the
//     react-jsx transform falls back to the GLOBAL `JSX` namespace below.
//   - tsconfig.json pulls in @types/react (React 19), whose react-jsx runtime
//     resolves intrinsic elements from `React.JSX.IntrinsicElements`. The
//     module augmentation below adds the same Ink host elements there.
declare global {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': Record<string, unknown>
      'ink-text': Record<string, unknown>
      'ink-link': Record<string, unknown>
      'ink-root': Record<string, unknown>
      'ink-virtual-text': Record<string, unknown>
      'ink-raw-ansi': Record<string, unknown>
    }
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': Record<string, unknown>
      'ink-text': Record<string, unknown>
      'ink-link': Record<string, unknown>
      'ink-root': Record<string, unknown>
      'ink-virtual-text': Record<string, unknown>
      'ink-raw-ansi': Record<string, unknown>
    }
  }
}

export {}
