/**
 * Stub — utility type definitions not included in source snapshot. See
 * src/types/message.ts for the same scoping caveat (issue #473).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// Deep readonly. Functions, Maps and Sets must be special-cased BEFORE the
// generic object branch: mapping over a function's or a Map's own keys
// (`{ readonly [K in keyof T]: … }`) collapses callables to a non-callable
// `{}`, which is what broke `ReadonlyMap.keys()`/`.get()` on app state (#473).
export type DeepImmutable<T> = T extends (...args: any[]) => any
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
    : T extends ReadonlySet<infer U>
      ? ReadonlySet<DeepImmutable<U>>
      : T extends readonly (infer E)[]
        ? readonly DeepImmutable<E>[]
        : T extends object
          ? { readonly [K in keyof T]: DeepImmutable<T[K]> }
          : T

export type Permutations<T extends string, U extends string = T> = T extends T
  ? T | `${T}${Permutations<Exclude<U, T>>}`
  : never
