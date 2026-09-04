// One source of randomness for the whole game. crypto.getRandomValues is
// available in every browser and in node:test without imports, so the same
// module serves the game and the tests.
export function random() {
  const buffer = new Uint32Array(1)
  crypto.getRandomValues(buffer)
  return buffer[0] / 4294967296
}
