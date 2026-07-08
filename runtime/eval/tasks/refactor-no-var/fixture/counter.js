var count = 0;

export function increment() {
  var next = count + 1;
  count = next;
  return count;
}

export function reset() {
  count = 0;
  return count;
}
