// Everything the board reads and writes, through the GitHub REST API.
//
// The private data repository is the database:
//   an idea     = an open issue (title = the idea's title)
//   a comment   = a comment on that issue
//   removing    = closing the issue, so nothing is ever destroyed by the board
//   the tabs    = tabs.json at the repository root
//
// Who wrote something is a first name carried in a hidden HTML comment at the
// top of the issue or comment body, because every write goes through one
// shared key and GitHub would otherwise credit the key's owner.
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

function toIdea(issue) {
  const { meta, text } = parseBody(issue.body);
  return {
    number: issue.number,
    title: issue.title,
    text,
    author: (meta && typeof meta.author === 'string' && meta.author) || issue.user.login,
    tab: meta && typeof meta.tab === 'string' ? meta.tab : null,
    color: meta && COLORS.includes(meta.color) ? meta.color : 'yellow',
    created: issue.created_at,
    updated: issue.updated_at,
    comments: issue.comments,
  };
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
    this.ideaCache = { raw: null, ideas: [] };
    this.ideaView = { server: null, version: -1, ideas: [] };
    this.commentCache = new Map();
    this.tabCache = { etag: null, value: { tabs: [], sha: null } };
    this.lastTabWrite = null;
    // Writes GitHub's lists may not show yet. A null value means "removed".
    this.pendingIdeas = new Map(); // issue number -> { idea | null, at }
    this.pendingComments = new Map(); // issue number -> Map(comment id -> { comment | null, at })
    this.version = 0;
  }

  rememberIdea(number, idea) {
    this.pendingIdeas.set(number, { idea, at: Date.now() });
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

  // Returns the same array object when nothing changed, so callers can skip
  // re-rendering with a plain === check.
  async listIdeas() {
    const raw = await this.listAll(`/repos/${this.repo}/issues?state=open&sort=updated&direction=desc&per_page=100`);
    if (raw !== this.ideaCache.raw) {
      this.ideaCache = { raw, ideas: raw.filter((issue) => !issue.pull_request).map(toIdea) };
    }
    const server = this.ideaCache.ideas;
    const now = Date.now();
    for (const [number, entry] of this.pendingIdeas) {
      const live = server.find((idea) => idea.number === number);
      const shown = entry.idea ? Boolean(live) && live.updated >= entry.idea.updated : !live;
      if (shown || now - entry.at > PENDING_MS) {
        this.pendingIdeas.delete(number);
        this.version++;
      }
    }
    if (this.ideaView.server === server && this.ideaView.version === this.version) return this.ideaView.ideas;
    const ideas = server.filter((idea) => !this.pendingIdeas.has(idea.number));
    for (const entry of this.pendingIdeas.values()) if (entry.idea) ideas.push(entry.idea);
    this.ideaView = { server, version: this.version, ideas };
    return ideas;
  }

  async createIdea({ title, text, tab, color, author }) {
    const body = encodeBody({ author, tab, color }, text);
    const { data } = await this.request('POST', `/repos/${this.repo}/issues`, { body: { title, body } });
    const idea = toIdea(data);
    this.rememberIdea(idea.number, idea);
    return idea;
  }

  async updateIdea(idea, { title, text, tab, color }) {
    const body = encodeBody({ author: idea.author, tab, color }, text);
    const { data } = await this.request('PATCH', `/repos/${this.repo}/issues/${idea.number}`, { body: { title, body } });
    const updated = toIdea(data);
    this.rememberIdea(updated.number, updated);
    return updated;
  }

  async removeIdea(number) {
    await this.request('PATCH', `/repos/${this.repo}/issues/${number}`, {
      body: { state: 'closed', state_reason: 'not_planned' },
    });
    this.rememberIdea(number, null);
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
