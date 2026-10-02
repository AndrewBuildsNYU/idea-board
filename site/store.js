// Everything the board reads and writes, through the GitHub REST API.
//
// The private data repository is the database. Every thing on a board is an
// issue, told apart by a "type" in a hidden marker at the top of its body:
//   an idea     (no type)  title = the idea's title, body = its details
//   a group     "group"    title = the group's name; ideas point at it
//   board text  "text"     body = the words written on the board
//   a drawing   "sketch"   body = its pen strokes, one per line
//   comments    comments on an idea's issue
//   removing    closes the issue, so nothing is ever destroyed by the board
//   the tabs    tabs.json at the repository root
// Lines between ideas are stored on the idea they were drawn from (`links`).
//
// Who wrote something is a first name in the same marker, because every
// write goes through one shared key and GitHub would otherwise credit the
// key's owner.
//
// Lists are fetched with If-None-Match. A 304 does not count against
// GitHub's rate limit, which is what makes polling a shared key affordable.
//
// GitHub's lists trail its writes by a few seconds (measured: a new issue was
// missing from both conditional and plain list requests for ~5 s). So every
// write is also remembered here and laid over the server's answer until the
// server shows it, or PENDING_MS passes. Without that, a just-pinned idea
// vanishes on the next poll and reappears a few seconds later.

const API = 'https://api.github.com';
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

function encodeBase64Utf8(text) {
  let s = '';
  for (const b of new TextEncoder().encode(text)) s += String.fromCharCode(b);
  return btoa(s);
}

function decodeBase64Utf8(text) {
  const s = atob(text.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
}

function nextLink(res) {
  const link = res.headers.get('Link') || '';
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

function explain(res, detail) {
  const status = res.status;
  if (status === 401) {
    return "GitHub rejected the board's access key. It may have expired. Tell whoever runs the board.";
  }
  if (status === 429 || (status === 403 && res.headers.get('X-RateLimit-Remaining') === '0')) {
    return 'GitHub is limiting how fast the board can make requests. It will catch up in a few minutes.';
  }
  if (status === 403) return "The board's access key isn't allowed to do that.";
  if (status === 404) return "The board's data couldn't be found. The access key may not cover the data repository.";
  return detail ? `GitHub said: ${detail}` : `GitHub returned an error (${status}).`;
}

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
  constructor({ repo, token }) {
    this.repo = repo;
    this.token = token;
    this.lists = new Map();
    this.itemCache = { raw: null, items: [] };
    this.itemView = { server: null, version: -1, items: [] };
    this.commentCache = new Map();
    this.tabCache = { etag: null, value: { tabs: [], sha: null } };
    this.lastTabWrite = null;
    // Writes GitHub's lists may not show yet. A null value means "removed".
    this.pendingItems = new Map(); // issue number -> { item | null, at }
    this.pendingComments = new Map(); // issue number -> Map(comment id -> { comment | null, at })
    this.queues = new Map(); // issue number -> the patch in flight
    this.version = 0;
  }

  remember(number, item) {
    this.pendingItems.set(number, { item, at: Date.now() });
    this.version++;
  }

  rememberComment(number, id, comment) {
    if (!this.pendingComments.has(number)) this.pendingComments.set(number, new Map());
    this.pendingComments.get(number).set(id, { comment, at: Date.now() });
    this.version++;
  }

  async request(method, path, { body, etag } = {}) {
    const headers = { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (etag) headers['If-None-Match'] = etag;
    const init = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    // GitHub sends max-age=60; without this the browser would serve a
    // minute-old list and hide everyone's new posts, including our own.
    if (IN_BROWSER) init.cache = 'no-store';
    let res;
    try {
      res = await fetch(path.startsWith('http') ? path : API + path, init);
    } catch {
      throw new ApiError(0, "Can't reach GitHub. Check your connection; the board will keep trying.");
    }
    if (res.status === 304) return { status: 304, res, data: null };
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).message || '';
      } catch {
        detail = '';
      }
      throw new ApiError(res.status, explain(res, detail));
    }
    const data = res.status === 204 ? null : await res.json();
    return { status: res.status, res, data };
  }

  // Every page of a list. Only page 1 is conditional; lists are sorted so
  // that any change lands on page 1 and changes its ETag.
  async listAll(path) {
    const cached = this.lists.get(path);
    const first = await this.request('GET', path, { etag: cached && cached.etag });
    if (first.status === 304 && cached) return cached.items;
    let items = first.data;
    let next = nextLink(first.res);
    while (next) {
      const page = await this.request('GET', next);
      items = items.concat(page.data);
      next = nextLink(page.res);
    }
    this.lists.set(path, { etag: first.res.headers.get('ETag'), items });
    return items;
  }

  // Everything on every board. Returns the same array object when nothing
  // changed, so callers can skip re-rendering with a plain === check.
  async listItems() {
    const raw = await this.listAll(`/repos/${this.repo}/issues?state=open&sort=updated&direction=desc&per_page=100`);
    if (raw !== this.itemCache.raw) {
      this.itemCache = { raw, items: raw.filter((issue) => !issue.pull_request).map(toItem) };
    }
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
    const { data } = await this.request('POST', `/repos/${this.repo}/issues`, { body: { title, body } });
    const created = toItem(data);
    this.remember(created.number, created);
    return created;
  }

  // `changes` is any subset of the item's fields; the rest is kept.
  async updateItem(item, changes) {
    const { title, body } = encodeItem({ ...item, ...changes });
    const { data } = await this.request('PATCH', `/repos/${this.repo}/issues/${item.number}`, { body: { title, body } });
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
      const { data } = await this.request('GET', `/repos/${this.repo}/issues/${number}`);
      const item = toItem(data);
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
    await this.request('PATCH', `/repos/${this.repo}/issues/${number}`, {
      body: { state: 'closed', state_reason: 'not_planned' },
    });
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
    const raw = await this.listAll(`/repos/${this.repo}/issues/${number}/comments?per_page=100`);
    let cached = this.commentCache.get(number);
    if (!cached || cached.raw !== raw) {
      cached = { raw, comments: raw.map(toComment), view: null, version: -1 };
      this.commentCache.set(number, cached);
    }
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
    const { data } = await this.request('POST', `/repos/${this.repo}/issues/${number}/comments`, {
      body: { body: encodeBody({ author }, text) },
    });
    const comment = toComment(data);
    this.rememberComment(number, comment.id, comment);
    return comment;
  }

  async removeComment(number, id) {
    await this.request('DELETE', `/repos/${this.repo}/issues/comments/${id}`);
    this.rememberComment(number, id, null);
  }

  // `fresh` skips the ETag so an admin edit always starts from the latest sha.
  async getTabs(fresh = false) {
    let result;
    try {
      result = await this.request('GET', `/repos/${this.repo}/contents/tabs.json`, {
        etag: fresh ? null : this.tabCache.etag,
      });
    } catch (error) {
      if (error.status === 404) return { tabs: [], sha: null };
      throw error;
    }
    if (result.status === 304) return this.tabCache.value;
    // Only the admin writes tabs, so a different sha this soon after our own
    // write is GitHub still serving the old file, not someone else's change.
    const recent = this.lastTabWrite;
    if (recent && result.data.sha !== recent.sha && Date.now() - recent.at < PENDING_MS) {
      return this.tabCache.value;
    }
    if (recent && result.data.sha === recent.sha) this.lastTabWrite = null;
    let tabs = [];
    try {
      const parsed = JSON.parse(decodeBase64Utf8(result.data.content));
      tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter(validTab) : [];
    } catch {
      tabs = [];
    }
    this.tabCache = { etag: result.res.headers.get('ETag'), value: { tabs, sha: result.data.sha } };
    return this.tabCache.value;
  }

  async saveTabs(tabs, sha, message) {
    const body = { message, content: encodeBase64Utf8(`${JSON.stringify({ tabs }, null, 2)}\n`) };
    if (sha) body.sha = sha;
    const { data } = await this.request('PUT', `/repos/${this.repo}/contents/tabs.json`, { body });
    this.tabCache = { etag: null, value: { tabs, sha: data.content.sha } };
    this.lastTabWrite = { sha: data.content.sha, at: Date.now() };
    return this.tabCache.value;
  }
}

// Exported for scripts/check.mjs.
export const _internal = { toItem, encodeItem, STROKE_RE };
