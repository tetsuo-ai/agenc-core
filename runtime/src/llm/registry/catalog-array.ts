/** A real frozen array with stable, lazily resolved entries and normal array APIs. */
export function frozenLazyArray<T>(
  length: number,
  entry: (index: number) => T,
): readonly T[] {
  const result: T[] = new Array<T>(length);
  for (let index = 0; index < length; index++) {
    Object.defineProperty(result, index, {
      enumerable: true,
      get: () => entry(index),
    });
  }
  return Object.freeze(result);
}
