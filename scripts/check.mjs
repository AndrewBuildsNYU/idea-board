// Offline checks that run before every deploy: the vault round-trips, a wrong
// password is refused, the hidden marker survives anything a person can
// type, and every kind of thing on a board survives a trip through an issue.

import assert from 'node:assert/strict';
import { seal, open } from '../site/vault.js';
import { encodeBody, parseBody, _internal } from '../site/store.js';
import { parseNames } from './build.mjs';

const { toItem, encodeItem } = _internal;

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

// An item written by the board, read back as GitHub would hand it over.
function roundTrip(item) {
  const { title, body } = encodeItem(item);
  return toItem({ number: 7, title, body, user: { login: 'owner' }, created_at: 't0', updated_at: 't1', comments: 2 });
}

const links = [{ to: 3, color: 'default' }, { to: 4, color: 'green' }];
const idea = roundTrip({ kind: 'idea', title: 'Demo day', text: 'Fridays', author: 'Ana', tab: 'general', color: 'sky', x: 1234, y: 56, group: 9, links });
assert.equal(idea.kind, 'idea');
assert.deepEqual([idea.title, idea.text, idea.author, idea.color, idea.x, idea.y, idea.group], ['Demo day', 'Fridays', 'Ana', 'sky', 1234, 56, 9]);
assert.deepEqual(idea.links, links);
// Lines saved before colours existed are plain numbers; they read as the theme colour.
const older = toItem({ number: 9, title: 'Old', body: encodeBody({ author: 'Ana', links: [3, 3, 5, 'x'] }, ''), user: { login: 'o' }, created_at: 't', updated_at: 't' });
assert.deepEqual(older.links, [{ to: 3, color: 'default' }, { to: 5, color: 'default' }]);
// The default colour is stored compactly, so old and new boards read each other.
assert.deepEqual(parseBody(encodeItem({ kind: 'idea', title: 'T', text: '', author: 'A', links }).body).meta.links, [3, { to: 4, color: 'green' }]);

const loose = roundTrip({ kind: 'idea', title: 'Unplaced', text: '', author: 'Ana', tab: 't', color: 'pink', x: null, y: null, group: null, links: [] });
assert.equal(loose.x, null);
assert.equal(loose.group, null);
assert.deepEqual(loose.links, []);

const group = roundTrip({ kind: 'group', name: 'Onboarding', tab: 'general', color: 'teal' });
assert.deepEqual([group.kind, group.name, group.color, group.tab], ['group', 'Onboarding', 'teal', 'general']);

const text = roundTrip({ kind: 'text', text: 'Big idea -->\nsecond line', tab: 'general', x: 10, y: 20, size: 'l', color: 'red', author: 'Ben' });
assert.deepEqual([text.kind, text.text, text.size, text.color, text.x, text.y, text.author], ['text', 'Big idea -->\nsecond line', 'l', 'red', 10, 20, 'Ben']);

const strokes = ['ink|6|10,10 20,25 40,30', 'blue|3|5,5'];
const sketch = roundTrip({ kind: 'sketch', tab: 'general', author: 'Cy', strokes });
assert.deepEqual([sketch.kind, sketch.author], ['sketch', 'Cy']);
assert.deepEqual(sketch.strokes, strokes);
// A hand-edited stroke that doesn't fit the format is dropped, not drawn.
const tampered = toItem({ number: 8, title: 'Drawing', body: encodeBody({ type: 'sketch', tab: 'g', author: 'Cy' }, 'ink|6|1,1 2,2\n<script>|9|x'), user: { login: 'o' }, created_at: 't', updated_at: 't' });
assert.deepEqual(tampered.strokes, ['ink|6|1,1 2,2']);

assert.deepEqual(parseNames('- Ana\n* ben\n\nAna\n  Cy  Lo  \nDee, Eve'), ['Ana', 'ben', 'Cy Lo', 'Dee', 'Eve']);

console.log('All checks passed.');
