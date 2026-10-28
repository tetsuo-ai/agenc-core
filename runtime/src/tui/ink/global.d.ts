// Stub — global types for Ink renderer.
//
// tsconfig.json pulls in @types/react (React 19), whose react-jsx runtime
// resolves intrinsic elements from `React.JSX.IntrinsicElements`. The
// module augmentation below adds the same Ink host elements to the GLOBAL
// `JSX` namespace for consumers without @types/react.
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
