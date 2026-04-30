/**
 * Ambient declarations for modules and globals referenced by the ported
 * Ink subtree that don't ship type definitions.
 */

declare module 'react-reconciler' {
  // Upstream react-reconciler 0.33 ships no first-party types, and
  // @types/react-reconciler@0.32 mismatches 0.33's argument counts. We
  // expose a permissive shape so the ported Ink core type-checks without
  // pulling in conflicting @types. Individual call sites preserve their
  // upstream `@ts-ignore` comments where runtime argument shapes differ.
  export type FiberRoot = any
  export type Reconciler = any
  function createReconciler<
    T1 = any, T2 = any, T3 = any, T4 = any, T5 = any,
    T6 = any, T7 = any, T8 = any, T9 = any, T10 = any,
    T11 = any, T12 = any, T13 = any, T14 = any,
  >(config: any): any
  export default createReconciler
}

declare module 'react-reconciler/constants.js' {
  export const LegacyRoot: unknown
  export const ConcurrentRoot: unknown
  export const NoEventPriority: unknown
  export const DefaultEventPriority: unknown
  export const ContinuousEventPriority: unknown
  export const DiscreteEventPriority: unknown
  export const IdleEventPriority: unknown
}

declare module 'bidi-js' {
  type EmbeddingLevels = {
    levels: Uint8Array
    paragraphs: Array<{ start: number; end: number; level: number }>
  }
  const bidiFactory: () => {
    getEmbeddingLevels: (text: string, direction?: string) => EmbeddingLevels
    getReorderSegments: (
      text: string,
      embeddingLevels: EmbeddingLevels,
      start?: number,
      end?: number,
    ) => Array<[number, number]>
    getReorderedString: (
      text: string,
      embeddingLevels: EmbeddingLevels,
    ) => string
    getReorderedIndices: (
      text: string,
      embeddingLevels: EmbeddingLevels,
    ) => number[]
  }
  export default bidiFactory
}

// Bun global (feature-detected at runtime in wrapAnsi.ts / stringWidth.ts).
// We only need the shape Ink reads; never executed in the Node runtime.
declare const Bun:
  | undefined
  | {
      stringWidth?: (
        str: string,
        options?: { ambiguousIsNarrow?: boolean },
      ) => number
      wrapAnsi?: (
        input: string,
        columns: number,
        options?: { hard?: boolean; wordWrap?: boolean; trim?: boolean },
      ) => string
      sleep: (ms: number) => Promise<void>
      semver?: {
        order: (a: string, b: string) => -1 | 0 | 1
        satisfies: (version: string, range: string) => boolean
      }
      hash?: ((input: string, seed?: number | bigint) => bigint) & {
        wyhash?: (input: string, seed?: number | bigint) => bigint
      }
    }
