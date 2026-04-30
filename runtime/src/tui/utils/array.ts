// Cherry-picked from openclaude src/utils/array.ts.
// count(arr, pred) — counts elements satisfying predicate.

export function count<T>(arr: ReadonlyArray<T>, pred: (item: T) => boolean): number {
  let n = 0;
  for (const item of arr) if (pred(item)) n += 1;
  return n;
}
