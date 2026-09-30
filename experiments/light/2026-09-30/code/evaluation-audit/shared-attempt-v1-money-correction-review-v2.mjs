// Same preserved four assertions; new candidate pin and absolute file-URL import.
// The first wrapper's data-URL-relative import failure remains separately retained.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const original = fs.readFileSync(new URL('./shared-attempt-v1-money-review.mjs', import.meta.url), 'utf8');
assert.equal(sha(original), '77168336c3289f91d5ec9c3adc4dcc25248dfa8fba85fc929589fb3f72402ce9');
const oldPin = '0200630c27d92ae056d32f7157475a73ad0668adc8c5fe0649e422e834fb5775';
const newPin = 'dbc239d6d13f611143b473476a40ac2421eca0bb51277fb19375ea336a606dc9';
assert.equal(original.split(oldPin).length, 2);
assert.equal(original.split('import(source)').length, 2);
assert.equal(sha(fs.readFileSync('/private/tmp/light-takeover/fair-confirmation/shared-attempt-v1/initial-source.mjs.txt')), oldPin);
const selected = original.replace(oldPin, newPin).replace('import(source)', "import('file://' + source)");
await import('data:text/javascript;base64,' + Buffer.from(selected).toString('base64'));
