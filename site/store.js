// Everything the board reads and writes, through the board's own server
// (worker/ in this repository, at /api on the same site).
//
// The server stores things in the shape GitHub issues had, since the board
// began on GitHub. Every thing on a board is an "issue", told apart by a
// "type" in a hidden marker at the top of its body:
//   an idea     (no type)  title = the idea's title, body = its details
//   a group     "group"    title = the group's name; ideas point at it
//   board text  "text"     body = the words written on the board
//   a drawing   "sketch"   body = its pen strokes, one per line
//   a board     "board"    title = the board's name; things on it name its id
//   comments    comments on an idea's issue
//   removing    closes the issue, so nothing is ever destroyed by the board
// The server also keeps the boards made before boards were issues (/tabs,
// read only; a board issue with the same id overrides one) and the list of
// who can sign in, which the admin's People panel edits.
// Lines between ideas are stored on the idea they were drawn from (`links`).
//
// Who wrote something is a first name in the same marker. The server sets it
// from the signed-in session, so nobody can post as someone else.
//
// Lists are fetched with If-None-Match, so a poll that finds nothing new is
// a tiny 304.
//
// Every write is also remembered here and laid over the server's answer
// until the server shows it, or PENDING_MS passes. The server shows its own
// writes at once; this keeps a just-pinned idea from flickering when a poll
// that started before the write lands after it.

const API = '/api';
const PENDING_MS = 120000;
const MARK = 'idea-board:v1';
const MARK_RE = /^<!-- idea-board:v1 (.*?) -->\r?\n?/s;
const IN_BROWSER = typeof document !== 'undefined';

export const COLORS = ['yellow', 'pink', 'mint', 'sky', 'lilac'];
export const GROUP_COLORS = ['blue', 'green', 'orange', 'purple', 'teal'];
export const PENS = ['ink', 'red', 'blue', 'green'];
export const TEXT_SIZES = ['s', 'm', 'l'];
// "default" follows the theme (red yarn on cork, blue on whiteboard...).
export const STRING_COLORS = ['default', 'red', 'blue', 'green', 'orange', 'purple'];
// A stroke is "colour|width|x,y x,y ...". The format is checked on the way in
// so a hand-edited issue can't break the board.
const STROKE_RE = /^(ink|red|blue|green)\|\d{1,2}\|-?\d{1,5},-?\d{1,5}( -?\d{1,5},-?\d{1,5})*$/;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function encodeBody(meta, text) {
  // "-->" inside the JSON would end the HTML comment early.
  const json = JSON.stringify(meta).replace(/-->/g, '--\\u003e');
  return `<!-- ${MARK} ${json} -->\n\n${text}`;
}

export function parseBody(body) {
  const source = body || '';
  const match = source.match(MARK_RE);
  if (!match) return { meta: null, text: source.trim() };
  let meta = null;
  try {
    meta = JSON.parse(match[1]);
  } catch {
    meta = null;
  }
  return { meta, text: source.slice(match[0].length).trim() };
}

// The server words its own refusals for people (wrong password, not on the
// list, not yours to change); anything it didn't word gets a general reason.
function explain(status, detail) {
  if (detail) return detail;
  if (status === 401) return "You've been signed out. Sign in again to carry on.";
  if (status === 403) return "You can't change that.";
  if (status === 404) return "That isn't on the board any more.";
  if (status === 429) return 'Too many tries. Wait a few minutes and try again.';
  return `The board's server had a problem (${status}). Try again in a moment.`;
}

// One request to the board's server. `token` is the session's, once signed in.
export async function call(method, path, { token, body, etag } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (etag) headers['If-None-Match'] = etag;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  // Lists change all the time; never let the browser answer from its cache.
  if (IN_BROWSER) init.cache = 'no-store';
  let res;
  try {
    res = await fetch(API + path, init);
  } catch {
    throw new ApiError(0, "Can't reach the board. Check your connection; it will keep trying.");
  }
  if (res.status === 304) return { status: 304, res, data: null };
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch {
      detail = '';
    }
    throw new ApiError(res.status, explain(res.status, detail));
  }
  const data = res.status === 204 ? null : await res.json();
  return { status: res.status, res, data };
}

// Signing in and out, before there's a Store to ask.
export const account = {
  async setupNeeded() {
    return (await call('GET', '/setup')).data.needed;
  },
  async setup(fields) {
    await call('POST', '/setup', { body: fields });
  },
  // { token, name, adminName }
  async signIn(name, password) {
    return (await call('POST', '/session', { body: { name, password } })).data;
  },
  // { name, adminName, admin }, or an ApiError with status 401 once it's over.
  async check(token) {
    return (await call('GET', '/session', { token })).data;
  },
  async signOut(token) {
    await call('DELETE', '/session', { token });
  },
  async unlockAdmin(token, password) {
    await call('POST', '/session/admin', { token, body: { password } });
  },
  async lockAdmin(token) {
    await call('DELETE', '/session/admin', { token });
  },
};

function validTab(tab) {
  return tab && typeof tab.id === 'string' && /^[a-z0-9-]{1,48}$/.test(tab.id) && typeof tab.name === 'string';
}

function finite(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

// A line is stored on the idea it was drawn from, as the other idea's number,
// or { to, color } once it has a colour other than the default.
function readLinks(raw) {
  const links = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const to = Number.isInteger(entry) ? entry : entry && Number.isInteger(entry.to) ? entry.to : null;
    if (to == null || links.some((link) => link.to === to)) continue;
    const color = entry && STRING_COLORS.includes(entry.color) ? entry.color : 'default';
    links.push({ to, color });
  }
  return links;
}

function writeLinks(links) {
  return links.map((link) => (link.color && link.color !== 'default' ? { to: link.to, color: link.color } : link.to));
}

function firstLine(text, fallback) {
  const line = String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  return (line.length > 80 ? `${line.slice(0, 77)}...` : line) || fallback;
}

function toItem(issue) {
  const { meta, text } = parseBody(issue.body);
  const m = meta || {};
  const base = {
    number: issue.number,
    tab: typeof m.tab === 'string' ? m.tab : null,
    author: (typeof m.author === 'string' && m.author) || issue.user.login,
    created: issue.created_at,
    updated: issue.updated_at,
  };
  if (m.type === 'group') {
    return { ...base, kind: 'group', name: issue.title, color: GROUP_COLORS.includes(m.color) ? m.color : 'blue' };
  }
  if (m.type === 'board' && typeof m.id === 'string' && /^[a-z0-9-]{1,60}$/.test(m.id)) {
    return {
      ...base,
      kind: 'board',
      id: m.id,
      name: issue.title,
      owner: typeof m.owner === 'string' ? m.owner : null,
      visibility: m.visibility === 'private' ? 'private' : 'public',
      personal: m.personal === true,
      deleted: m.deleted === true,
    };
  }
  if (m.type === 'text') {
    return {
      ...base,
      kind: 'text',
      text,
      x: finite(m.x) ?? 0,
      y: finite(m.y) ?? 0,
      size: TEXT_SIZES.includes(m.size) ? m.size : 'm',
      color: PENS.includes(m.color) ? m.color : 'ink',
    };
  }
  if (m.type === 'sketch') {
    return { ...base, kind: 'sketch', strokes: text.split('\n').map((s) => s.trim()).filter((s) => STROKE_RE.test(s)) };
  }
  const placed = finite(m.x) != null && finite(m.y) != null;
  return {
    ...base,
    kind: 'idea',
    title: issue.title,
    text,
    color: COLORS.includes(m.color) ? m.color : 'yellow',
    x: placed ? finite(m.x) : null,
    y: placed ? finite(m.y) : null,
    group: Number.isInteger(m.group) ? m.group : null,
    links: readLinks(m.links),
    comments: issue.comments,
  };
}

// The inverse of toItem: what an item looks like as an issue.
function encodeItem(item) {
  if (item.kind === 'board') {
    const meta = { type: 'board', id: item.id, owner: item.owner, visibility: item.visibility, author: item.author };
    if (item.personal) meta.personal = true;
    if (item.deleted) meta.deleted = true;
    return { title: item.name, body: encodeBody(meta, '') };
  }
  if (item.kind === 'group') {
    return { title: item.name, body: encodeBody({ type: 'group', tab: item.tab, color: item.color }, '') };
  }
  if (item.kind === 'text') {
    const meta = { type: 'text', tab: item.tab, x: finite(item.x) ?? 0, y: finite(item.y) ?? 0, size: item.size, color: item.color, author: item.author };
    return { title: firstLine(item.text, 'Text on the board'), body: encodeBody(meta, item.text) };
  }
  if (item.kind === 'sketch') {
    return { title: 'Drawing', body: encodeBody({ type: 'sketch', tab: item.tab, author: item.author }, item.strokes.join('\n')) };
  }
  const meta = { author: item.author, tab: item.tab, color: item.color };
  if (finite(item.x) != null && finite(item.y) != null) {
    meta.x = finite(item.x);
    meta.y = finite(item.y);
  }
  if (Number.isInteger(item.group)) meta.group = item.group;
  if (item.links && item.links.length) meta.links = writeLinks(item.links);
  return { title: item.title, body: encodeBody(meta, item.text) };
}

// A name the access list can hold: a first name, perhaps with an initial
// (Sam K.). Used by the page and the server alike. Returns the name tidied,
// or null.
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .'’-]{0,39}$/u;

export function cleanName(text) {
  const name = String(text || '').trim().replace(/\s+/g, ' ');
  return NAME_RE.test(name) ? name : null;
}

function toComment(comment) {
  const { meta, text } = parseBody(comment.body);
  return {
    id: comment.id,
    author: (meta && typeof meta.author === 'string' && meta.author) || comment.user.login,
    text,
    created: comment.created_at,
  };
}

export class Store {
  constructor({ token }) {
    this.token = token;
    this.lists = new Map();
    this.itemCache = { raw: null, items: [] };
    this.itemView = { server: null, version: -1, items: [] };
    this.commentCache = new Map();
    // Writes the server's lists may not show yet. A null value means "removed".
    this.pendingItems = new Map(); // issue number -> { item | null, at }
    this.pendingComments = new Map(); // issue number -> Map(comment id -> { comment | null, at })
    this.queues = new Map(); // issue number -> the patch in flight
    this.version = 0;
  }

  // Every confirmed write passes through here. Everyone else hears about it
  // from the server, which sends each saved change to every open board.
  remember(number, item) {
    this.pendingItems.set(number, { item, at: Date.now() });
    this.version++;
  }

  rememberComment(number, id, comment) {
    if (!this.pendingComments.has(number)) this.pendingComments.set(number, new Map());
    this.pendingComments.get(number).set(id, { comment, at: Date.now() });
    this.version++;
  }

  // Somebody else's write, sent live. It's held like one of ours until the
  // next list shows it, unless what we already have is newer.
  applyRemote(number, item) {
    const pending = this.pendingItems.get(number);
    const known = pending ? pending.item : this.itemCache.items.find((other) => other.number === number);
    if (item && known && known.updated > item.updated) return false;
    this.remember(number, item);
    return true;
  }

  // What listComments would return from what we already have, without asking
  // the server; null when this thread has never been loaded.
  cachedComments(number) {
    return this.commentCache.has(number) ? this.commentsView(number) : null;
  }

  // A 401 means the session is over (signed out elsewhere, removed from the
  // list, or the team password changed); `onSignedOut` lets the page react.
  async request(method, path, options = {}) {
    try {
      return await call(method, path, { ...options, token: this.token });
    } catch (error) {
      if (error.status === 401 && this.onSignedOut) this.onSignedOut();
      throw error;
    }
  }

  async listAll(path) {
    const cached = this.lists.get(path);
    const result = await this.request('GET', path, { etag: cached && cached.etag });
    if (result.status === 304 && cached) return cached.items;
    this.lists.set(path, { etag: result.res.headers.get('ETag'), items: result.data });
    return result.data;
  }

  // Everything on every board. Returns the same array object when nothing
  // changed, so callers can skip re-rendering with a plain === check.
  async listItems() {
    const raw = await this.listAll('/issues');
    if (raw !== this.itemCache.raw) {
      this.itemCache = { raw, items: raw.filter((issue) => !issue.pull_request).map(toItem) };
    }
    return this.view();
  }

  // The server's list with our pending writes (and relayed ones) laid over it.
  view() {
    const server = this.itemCache.items;
    const now = Date.now();
    for (const [number, entry] of this.pendingItems) {
      const live = server.find((item) => item.number === number);
      const shown = entry.item ? Boolean(live) && live.updated >= entry.item.updated : !live;
      if (shown || now - entry.at > PENDING_MS) {
        this.pendingItems.delete(number);
        this.version++;
      }
    }
    if (this.itemView.server === server && this.itemView.version === this.version) return this.itemView.items;
    const items = server.filter((item) => !this.pendingItems.has(item.number));
    for (const entry of this.pendingItems.values()) if (entry.item) items.push(entry.item);
    this.itemView = { server, version: this.version, items };
    return items;
  }

  async createItem(item) {
    const { title, body } = encodeItem(item);
    const { data } = await this.request('POST', '/issues', { body: { title, body } });
    const created = toItem(data);
    this.remember(created.number, created);
    return created;
  }

  // `changes` is any subset of the item's fields; the rest is kept.
  async updateItem(item, changes) {
    const { title, body } = encodeItem({ ...item, ...changes });
    const { data } = await this.request('PATCH', `/issues/${item.number}`, { body: { title, body } });
    const updated = toItem(data);
    this.remember(updated.number, updated);
    return updated;
  }

  // Reads the issue first and changes only what `change` returns, so a move,
  // a new line or a regroup never puts back an older title or text over
  // somebody else's edit. `change` may be an object or a function of the
  // current item; returning null means "nothing to do".
  //
  // Patches to one issue run one at a time: two at once would both read the
  // same version, and the second write would undo the first.
  patchItem(number, change) {
    const run = async () => {
      const { data } = await this.request('GET', `/issues/${number}`);
      const fetched = toItem(data);
      // With several people editing, a change sent live can be newer than
      // what the server handed back; build on whichever is newer.
      const known = this.pendingItems.get(number);
      const item = known && known.item && known.item.updated > fetched.updated ? known.item : fetched;
      const changes = typeof change === 'function' ? change(item) : change;
      return changes ? this.updateItem(item, changes) : item;
    };
    const next = (this.queues.get(number) || Promise.resolve()).then(run, run);
    this.queues.set(number, next);
    const settle = () => { if (this.queues.get(number) === next) this.queues.delete(number); };
    next.then(settle, settle);
    return next;
  }

  async removeItem(number) {
    await this.request('PATCH', `/issues/${number}`, { body: { state: 'closed' } });
    this.remember(number, null);
  }

  createIdea(fields) {
    return this.createItem({ kind: 'idea', group: null, links: [], ...fields });
  }

  updateIdea(idea, changes) {
    return this.patchItem(idea.number, changes);
  }

  moveItem(number, x, y) {
    return this.patchItem(number, { x, y });
  }

  removeIdea(number) {
    return this.removeItem(number);
  }

  addLink(from, to, color = 'default') {
    return this.patchItem(from, (idea) => (
      idea.links.some((link) => link.to === to) ? null : { links: [...idea.links, { to, color }] }));
  }

  // A line may have been drawn from either end, so both ends are checked.
  async removeLink(a, b) {
    const without = (other) => (idea) => (
      idea.links.some((link) => link.to === other) ? { links: idea.links.filter((link) => link.to !== other) } : null);
    await this.patchItem(a, without(b));
    await this.patchItem(b, without(a));
  }

  async setLinkColor(a, b, color) {
    const recolour = (other) => (idea) => (
      idea.links.some((link) => link.to === other)
        ? { links: idea.links.map((link) => (link.to === other ? { ...link, color } : link)) }
        : null);
    await this.patchItem(a, recolour(b));
    await this.patchItem(b, recolour(a));
  }

  setGroup(number, group) {
    return this.patchItem(number, { group });
  }

  // Strokes are matched by content, which survives other strokes being
  // added or erased in the meantime.
  async eraseStroke(number, line) {
    const sketch = await this.patchItem(number, (item) => (
      item.strokes.includes(line) ? { strokes: item.strokes.filter((s) => s !== line) } : null));
    if (!sketch.strokes.length) await this.removeItem(number);
  }

  async listComments(number) {
    const raw = await this.listAll(`/issues/${number}/comments`);
    const cached = this.commentCache.get(number);
    if (!cached || cached.raw !== raw) {
      this.commentCache.set(number, { raw, comments: raw.map(toComment), view: null, version: -1 });
    }
    return this.commentsView(number);
  }

  commentsView(number) {
    const cached = this.commentCache.get(number);
    const server = cached.comments;
    const pending = this.pendingComments.get(number);
    if (!pending) return server;
    const now = Date.now();
    for (const [id, entry] of pending) {
      const live = server.some((comment) => comment.id === id);
      if ((entry.comment ? live : !live) || now - entry.at > PENDING_MS) {
        pending.delete(id);
        this.version++;
      }
    }
    if (!pending.size) {
      this.pendingComments.delete(number);
      return server;
    }
    if (cached.view && cached.version === this.version) return cached.view;
    const comments = server.filter((comment) => !pending.has(comment.id));
    for (const entry of pending.values()) if (entry.comment) comments.push(entry.comment);
    comments.sort((a, b) => a.created.localeCompare(b.created));
    cached.view = comments;
    cached.version = this.version;
    return comments;
  }

  async addComment(number, { author, text }) {
    const { data } = await this.request('POST', `/issues/${number}/comments`, {
      body: { body: encodeBody({ author }, text) },
    });
    const comment = toComment(data);
    this.rememberComment(number, comment.id, comment);
    return comment;
  }

  async removeComment(number, id) {
    await this.request('DELETE', `/comments/${id}`);
    this.rememberComment(number, id, null);
  }

  // The boards from before boards were issues: [{ id, name }].
  async getTabs() {
    const { data } = await this.request('GET', '/tabs');
    return { tabs: Array.isArray(data.tabs) ? data.tabs.filter(validTab) : [] };
  }

  // Admin only: who can sign in. { names, adminName }
  async getPeople() {
    return (await this.request('GET', '/people')).data;
  }

  // Admin only. Applied on the server in one go, so two admins' changes (or
  // two windows) never undo each other. Takes effect at once: removed people
  // are signed out. Returns { names, adminName }.
  async changePeople(add, remove) {
    return (await this.request('PATCH', '/people', { body: { add, remove } })).data;
  }

  // Admin only. Signs everyone else out; they sign in with the new password.
  async setTeamPassword(password) {
    return (await this.request('PUT', '/team-password', { body: { password } })).data;
  }
}

// Shared with the server (worker/) and scripts/check.mjs.
export const _internal = { toItem, encodeItem, toComment, STROKE_RE };
