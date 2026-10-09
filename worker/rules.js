// Who may see and change what, decided on the server from the items
// themselves. The page applies the same rules to decide which buttons to
// show (canChange, canManageBoard and canDeleteBoard in site/app.js); these
// make them hold for anyone calling the API directly.
//
// `who` is the signed-in person: { name, admin }, where admin means admin
// tools are on.

import { parseBody, encodeBody, _internal } from '../site/store.js';

const { toItem } = _internal;

export function sameName(a, b) {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

// Every board's owner and visibility, by id, from the open issues and the
// boards from before boards were issues (which belong to the admin). As on
// the page, the oldest board issue with an id is the board.
export function boardIndex(issues, legacyTabs, adminName) {
  const boards = new Map();
  for (const tab of legacyTabs) boards.set(tab.id, { owner: adminName, visibility: 'public' });
  const seen = new Set();
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    const item = toItem(issue);
    if (item.kind !== 'board' || seen.has(item.id)) continue;
    seen.add(item.id);
    boards.set(item.id, { owner: item.owner || '', visibility: item.deleted ? 'public' : item.visibility });
  }
  return boards;
}

// Private boards, and everything on them, are seen by their owner only;
// not even the admin sees them.
export function canSee(item, name, boards) {
  if (item.kind === 'board') return item.visibility !== 'private' || sameName(item.owner, name);
  const board = item.tab != null ? boards.get(item.tab) : null;
  return !board || board.visibility !== 'private' || sameName(board.owner, name);
}

// Things anyone may do to anything they can see: move it, group it, draw a
// line from it.
const FREE = new Set(['x', 'y', 'group', 'links']);
const BOOKKEEPING = new Set(['number', 'created', 'updated', 'comments', 'author']);

function changedFields(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !BOOKKEEPING.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

export function mayChange(before, after, who, boards) {
  if (after.kind !== before.kind) return false;
  if (!canSee(after, who.name, boards)) return false;
  const changed = changedFields(before, after);
  if (!changed.length) return true;
  // Groups have no author; anyone tidying the board may rename one.
  if (before.kind === 'group') return true;
  if (before.kind === 'board') {
    if (before.personal || changed.some((key) => key !== 'name' && key !== 'visibility')) return false;
    if (sameName(before.owner, who.name)) return true;
    // The admin may rename someone else's public board, not hide it.
    return who.admin && before.visibility === 'public' && changed.every((key) => key === 'name');
  }
  if (changed.every((key) => FREE.has(key))) return true;
  return who.admin || sameName(before.author, who.name);
}

// Posting something new: not onto someone else's private board, and a second
// issue for an existing board (an old board becoming an issue, or a
// duplicate made in a race) only by its owner, or the admin renaming it.
export function mayCreate(item, who, boards) {
  if (!canSee(item, who.name, boards)) return false;
  if (item.kind !== 'board') return true;
  const existing = boards.get(item.id);
  if (!existing) return !item.deleted;
  return sameName(existing.owner, who.name) || (who.admin && existing.visibility === 'public' && !item.deleted);
}

// Removing (closing) something. Deleting a board takes everything on it, so
// a board's owner may remove anything on their board.
export function mayRemove(item, who, boards) {
  if (item.kind === 'board') return !item.personal && sameName(item.owner, who.name);
  if (item.kind === 'group' || who.admin || sameName(item.author, who.name)) return true;
  const board = item.tab != null ? boards.get(item.tab) : null;
  return Boolean(board) && sameName(board.owner, who.name);
}

// A new item's body with its author set to whoever is posting. A new board
// is theirs, unless the admin is turning an old board into an issue.
export function stampNew(body, who) {
  const { meta, text } = parseBody(body);
  const m = { ...(meta || {}), author: who.name };
  if (m.type === 'board' && !(who.admin && typeof m.owner === 'string')) m.owner = who.name;
  return encodeBody(m, text);
}

// A changed body keeps what identifies the item and who made it, whatever
// was sent: its type, author, and for a board its id, owner and kind.
const FIXED = ['type', 'author', 'id', 'owner', 'personal', 'deleted'];

export function stampChange(oldBody, newBody) {
  const before = parseBody(oldBody).meta || {};
  const { meta, text } = parseBody(newBody);
  const m = { ...(meta || {}) };
  for (const key of FIXED) {
    if (key in before) m[key] = before[key];
    else delete m[key];
  }
  // A body written on github.com had no marker; it stays without one.
  return Object.keys(m).length || parseBody(oldBody).meta ? encodeBody(m, text) : text;
}

export { toItem };
