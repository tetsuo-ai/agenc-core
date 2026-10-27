import { deflateRawSync } from 'node:zlib';

/** Deliberately narrow: stochastic short-vocabulary collapse, not repetition alone. */
export class DegenerateTextDetector {
  private tail = '';
  private pending = 0;
  private suspect = 0;
  observe(delta: string): boolean {
    // Fixed checkpoints make classification independent of provider chunk size.
    for (let offset = 0; offset < delta.length;) {
      const size = Math.min(256 - this.pending, delta.length - offset);
      this.tail = (this.tail + delta.slice(offset, offset + size)).slice(-2048);
      this.pending += size;
      offset += size;
      if (this.pending < 256) continue;
      this.pending = 0;
      if (this.tail.length < 2048) continue;
      this.suspect = this.isCollapsed() ? this.suspect + 1 : 0;
      if (this.suspect >= 2) return true;
    }
    return false;
  }
  private isCollapsed(): boolean {
    // Structured code, data, tables, fenced blocks and non-Latin scripts are
    // outside this detector's scope. The guard must not guess their meaning.
    if (/[{}\[\];|`"'\\]|[^\x00-\x7f]/.test(this.tail)) return false;
    const words = this.tail.toLowerCase().match(/[a-z]+/g) ?? [];
    if (words.length < 256) return false;
    const counts = new Map<string, number>();
    for (const word of words) {
      if (word.length > 16) return false;
      counts.set(word, (counts.get(word) ?? 0) + 1);
      if (counts.size > 16) return false;
    }
    // Changing numeric facts are useful progress, even with terse labels.
    // Preserve numeric vocabulary rather than collapsing every value to a word gap.
    const numbers = new Set(this.tail.match(/\d+(?:\.\d+)?/g) ?? []);
    if (numbers.size > 16) return false;
    const digitChars = (this.tail.match(/\d/g) ?? []).length;
    if (digitChars / this.tail.length >= 0.10) return false;
    const topFour = [...counts.values()].sort((a, b) => b - a).slice(0, 4).reduce((a, b) => a + b, 0);
    if (topFour / words.length < 0.95) return false;
    // Repeated lines, regular tables and periodic prose compress much more
    // than disordered salad. Compression alone is never a stop signal.
    const ratio = deflateRawSync(this.tail).length / this.tail.length;
    return ratio >= 0.22 && ratio <= 0.5;
  }
}
