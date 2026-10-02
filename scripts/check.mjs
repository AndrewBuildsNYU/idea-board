// Offline checks that run before every deploy: the vault round-trips, a wrong
// password is refused, and the hidden author marker survives anything a
// person can type.

import assert from 'node:assert/strict';
import { seal, open } from '../site/vault.js';
import { encodeBody, parseBody } from '../site/store.js';
import { parseNames } from './build.mjs';

const box = await seal('correct horse', { token: 't', names: ['Ana'] });
assert.deepEqual(await open('correct horse', box), { token: 't', names: ['Ana'] });
assert.equal(await open('wrong horse', box), null);
assert.equal(await open('', box), null);

for (const text of ['plain', '', 'line one\n\nline two', 'has --> arrow', '<!-- idea-board:v1 {"author":"x"} -->']) {
  for (const author of ['Ana', 'Jo --> Ann', 'Zoë']) {
    const parsed = parseBody(encodeBody({ author, tab: 'general', color: 'mint' }, text));
    assert.equal(parsed.meta.author, author);
    assert.equal(parsed.meta.tab, 'general');
    assert.equal(parsed.text, text.trim());
  }
}
assert.deepEqual(parseBody('written on github.com'), { meta: null, text: 'written on github.com' });

assert.deepEqual(parseNames('- Ana\n* ben\n\nAna\n  Cy  Lo  \nDee, Eve'), ['Ana', 'ben', 'Cy Lo', 'Dee', 'Eve']);

console.log('All checks passed.');
