import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const PINS = Object.freeze({
  '../luna-finance-io-v1/journal.mjs': '804f5312aee4779a8651816282066a2cc4a17d5e0d2ddbcd6c5b86748e53a824',
  '../luna-finance-v1/accounting.mjs': 'b602fcb75b42fb6671affb8de105fc7b661a8e4f258a0541db9d5952c271ac7e',
  '../luna-finance-v1/ledger-json.mjs': 'f7b034ba5def781b2e0246709734cf32f564f7bccdab7e138124b5895a0b2750',
});
export function verifyPins() {
  for (const [relative, expected] of Object.entries(PINS)) {
    if (createHash('sha256').update(readFileSync(new URL(relative, import.meta.url))).digest('hex') !== expected) {
      throw new Error('Synthetic process dependency mismatch');
    }
  }
}
