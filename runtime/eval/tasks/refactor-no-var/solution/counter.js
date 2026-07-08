let count = 0;

export function increment() {
  const next = count + 1;
  count = next;
  return count;
}

export function reset() {
  count = 0;
  return count;
}
