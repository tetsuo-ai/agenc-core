export async function rememberSuccessfulLookup<T>(
  tables: {
    readonly inFlight: Map<string, Promise<T>>;
    readonly success: Map<string, T>;
  },
  key: string,
  load: () => Promise<T>,
  isSuccess: (value: T) => boolean,
): Promise<T> {
  const hit = tables.success.get(key);
  if (hit !== undefined) return hit;
  const pending = tables.inFlight.get(key);
  if (pending !== undefined) return await pending;
  const request = load();
  tables.inFlight.set(key, request);
  try {
    const value = await request;
    if (isSuccess(value)) tables.success.set(key, value);
    return value;
  } finally {
    tables.inFlight.delete(key);
  }
}
