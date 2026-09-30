// Fixture-only resource management. No deletion or production cleanup policy.
export async function withFixtureCleanup<T>(
  body: (register: (order: number, close: () => void | Promise<void>) => void) => Promise<T>,
): Promise<T> {
  const resources: Array<{ order: number; close: () => void | Promise<void> }> = [];
  let result!: T, primary: unknown, failed = false;
  try { result = await body((order, close) => resources.push({ order, close })); }
  catch (error) { failed = true; primary = error; }
  const errors: unknown[] = [];
  for (const { close } of resources.sort((a, b) => a.order - b.order)) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (failed && errors.length === 0) throw primary;
  if (errors.length > 0) throw new AggregateError(failed ? [primary, ...errors] : errors, "fixture cleanup failed");
  return result;
}
