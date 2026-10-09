// Offline checks that run before every deploy: the hidden marker survives
// anything a person can type, every kind of thing on a board survives a trip
// through the server's issue shape, names are checked the same way
// everywhere, and the server's rules let people do what the page offers them
// and nothing more.

import assert from 'node:assert/strict';
import { encodeBody, parseBody, cleanName, _internal } from '../site/store.js';
import { boardIndex, canSee, mayCreate, mayChange, mayRemove, stampNew, stampChange } from '../worker/rules.js';

const { toItem, encodeItem } = _internal;

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

const board = roundTrip({ kind: 'board', id: 'b-abc123', name: 'Planning', owner: 'Dan', visibility: 'private', author: 'Dan' });
assert.deepEqual([board.kind, board.id, board.name, board.owner, board.visibility, board.personal, board.deleted], ['board', 'b-abc123', 'Planning', 'Dan', 'private', false, false]);
const mine = roundTrip({ kind: 'board', id: 'me-dan', name: 'My Board', owner: 'Dan', visibility: 'private', personal: true, author: 'Dan' });
assert.equal(mine.personal, true);
const gone = roundTrip({ kind: 'board', id: 'general', name: 'General', owner: 'Andrew', visibility: 'public', deleted: true, author: 'Andrew' });
assert.deepEqual([gone.deleted, gone.visibility], [true, 'public']);
// A board marker with a malformed id isn't a board; it falls back to an idea rather than breaking the list.
assert.equal(toItem({ number: 5, title: 'x', body: encodeBody({ type: 'board', id: 'Bad Id!' }, ''), user: { login: 'o' }, created_at: 't', updated_at: 't' }).kind, 'idea');

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

assert.equal(cleanName('  Sam   K. '), 'Sam K.');
assert.equal(cleanName('O’Neil'), 'O’Neil');
assert.equal(cleanName('Zoë'), 'Zoë');
for (const bad of ['', '   ', 'Ana, Ben', '- Ana', '* Ana', '<b>Ana</b>', 'a'.repeat(41)]) assert.equal(cleanName(bad), null, bad);

// ---- the server's rules

function issue(number, item) {
  const { title, body } = encodeItem(item);
  return { number, title, body, user: { login: item.author || 'x' }, created_at: 't', updated_at: 't', comments: 0 };
}
const issues = [
  issue(1, { kind: 'board', id: 'team', name: 'Team', owner: 'Dan', visibility: 'public', author: 'Dan' }),
  issue(2, { kind: 'board', id: 'me-ana', name: 'My Board', owner: 'Ana', visibility: 'private', personal: true, author: 'Ana' }),
  issue(3, { kind: 'idea', title: 'Public idea', text: '', author: 'Ana', tab: 'team', color: 'yellow', links: [] }),
  issue(4, { kind: 'idea', title: 'Secret idea', text: '', author: 'Ana', tab: 'me-ana', color: 'yellow', links: [] }),
  issue(5, { kind: 'board', id: 'team', name: 'Team (dup)', owner: 'Eve', visibility: 'private', author: 'Eve' }),
];
const boards = boardIndex(issues, [{ id: 'general', name: 'General' }], 'Andrew');
const item = (n) => toItem(issues.find((i) => i.number === n));
const ana = { name: 'Ana', admin: false };
const ben = { name: 'ben', admin: false };
const dan = { name: 'Dan', admin: false };
const admin = { name: 'Andrew', admin: true };

// The oldest board issue with an id is the board; old boards are the admin's.
assert.deepEqual(boards.get('team'), { owner: 'Dan', visibility: 'public' });
assert.deepEqual(boards.get('general'), { owner: 'Andrew', visibility: 'public' });
// Private boards and what's on them: their owner only, not even the admin.
assert.equal(canSee(item(2), 'ana', boards), true);
assert.equal(canSee(item(2), 'Ben', boards), false);
assert.equal(canSee(item(4), 'Andrew', boards), false);
assert.equal(canSee(item(3), 'Ben', boards), true);

// Anyone may move, group or link what they can see; only its author or the
// admin may change what it says.
const pub = item(3);
assert.equal(mayChange(pub, { ...pub, x: 10, y: 20, group: 9, links: [{ to: 4, color: 'red' }] }, ben, boards), true);
assert.equal(mayChange(pub, { ...pub, title: 'Hijacked' }, ben, boards), false);
assert.equal(mayChange(pub, { ...pub, title: 'Better' }, ana, boards), true);
assert.equal(mayChange(pub, { ...pub, title: 'Tidied' }, admin, boards), true);
assert.equal(mayChange(pub, { ...pub, tab: 'me-ana' }, ben, boards), false);
assert.equal(mayChange(pub, { ...pub, kind: 'text' }, ana, boards), false);
// Boards: the owner renames or hides; the admin may rename a public one only.
const team = item(1);
assert.equal(mayChange(team, { ...team, name: 'Renamed' }, dan, boards), true);
assert.equal(mayChange(team, { ...team, visibility: 'private' }, dan, boards), true);
assert.equal(mayChange(team, { ...team, name: 'Renamed' }, admin, boards), true);
assert.equal(mayChange(team, { ...team, visibility: 'private' }, admin, boards), false);
assert.equal(mayChange(team, { ...team, name: 'Renamed' }, ben, boards), false);
assert.equal(mayChange(item(2), { ...item(2), name: 'Mine' }, ana, boards), false, 'a personal board keeps its name');

// Removing: your own things; the admin anything; a board's owner anything on
// their board (deleting it); only the owner removes a board.
assert.equal(mayRemove(pub, ana, boards), true);
assert.equal(mayRemove(pub, ben, boards), false);
assert.equal(mayRemove(pub, admin, boards), true);
assert.equal(mayRemove(pub, dan, boards), true);
assert.equal(mayRemove(team, dan, boards), true);
assert.equal(mayRemove(team, admin, boards), false);
assert.equal(mayRemove(item(2), ana, boards), false, 'nobody deletes a personal board');

// Posting: not onto someone's private board; a second issue for an existing
// board only by its owner (or the admin renaming a public one).
assert.equal(mayCreate({ ...pub, tab: 'me-ana' }, ben, boards), false);
assert.equal(mayCreate({ ...pub, tab: 'me-ana' }, ana, boards), true);
assert.equal(mayCreate(toItem(issue(9, { kind: 'board', id: 'general', name: 'General', owner: 'Andrew', visibility: 'public', deleted: true, author: 'x' })), ben, boards), false);
assert.equal(mayCreate(toItem(issue(9, { kind: 'board', id: 'general', name: 'General!', owner: 'Andrew', visibility: 'public', author: 'x' })), admin, boards), true);
assert.equal(mayCreate(toItem(issue(9, { kind: 'board', id: 'b-new', name: 'New', owner: 'Ben', visibility: 'private', author: 'ben' })), ben, boards), true);

// The server, not the page, says who wrote something, and an edit can't
// change who made it or what it is.
const posted = parseBody(stampNew(encodeBody({ author: 'Andrew', tab: 'team' }, 'hi'), ben));
assert.deepEqual([posted.meta.author, posted.text], ['ben', 'hi']);
assert.equal(parseBody(stampNew(encodeBody({ type: 'board', id: 'b-x', owner: 'Dan' }, ''), ben)).meta.owner, 'ben');
const original = encodeBody({ type: 'board', id: 'b-x', owner: 'Dan', author: 'Dan', visibility: 'public' }, '');
const edited = parseBody(stampChange(original, encodeBody({ type: 'group', id: 'b-y', owner: 'Ben', author: 'Ben', visibility: 'private' }, ''))).meta;
assert.deepEqual([edited.type, edited.id, edited.owner, edited.author, edited.visibility], ['board', 'b-x', 'Dan', 'Dan', 'private']);
assert.equal(stampChange('written on github.com', 'still plain'), 'still plain');

console.log('All checks passed.');
