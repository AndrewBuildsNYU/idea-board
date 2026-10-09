// The board's server: one Durable Object that keeps everything in its own
// SQLite database and holds every open board's live connection.
//
// What it stores has the shape GitHub issues had, since the board began on
// GitHub, so the page reads and writes it with the same code (site/store.js).
// It also keeps who can sign in, the two passwords (hashed) and the
// sessions. Nothing here expires: there are no outside keys to renew.
//
// Signing in checks a first name against the list and the team password,
// and hands back a random session key; only its hash is stored. Removing
// someone, or changing the team password, deletes sessions, so it takes
// effect at once, including on boards already open.

import { DurableObject } from 'cloudflare:workers';
import { cleanName, parseBody, encodeBody, _internal } from '../site/store.js';
import { sameName, boardIndex, canSee, mayCreate, mayChange, mayRemove, stampNew, stampChange, toItem } from './rules.js';

const { toComment } = _internal;

const LIMITS = { title: 256, body: 65536, request: 1048576 };
// 100,000 rounds is the most Workers' PBKDF2 allows. Guessing online is
// slowed further by TRIES; there's no published file to guess against.
const PASSWORD = { iterations: 100000, min: 8, max: 200 };
const SESSION = { idle: 30 * 24 * 3600 * 1000, touch: 3600 * 1000 };
const TRIES = { window: 15 * 60 * 1000, max: 10 };
const LIVE = { protocol: 'fedi-boards', max: 120000, types: new Set(['hello', 'bye', 'move', 'ink', 'ink-done', 'ink-cancel']) };
const SIGNED_OUT = 4001;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS issues (
    number INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, login TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open',
    comments INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS issues_open ON issues (state, updated_at)',
  `CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY, issue INTEGER NOT NULL, body TEXT NOT NULL, login TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS comments_issue ON comments (issue, created_at)',
  'CREATE TABLE IF NOT EXISTS people (name TEXT PRIMARY KEY, position INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS sessions (
    hash TEXT PRIMARY KEY, name TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL, seen INTEGER NOT NULL)`,
  'CREATE TABLE IF NOT EXISTS failures (ip TEXT NOT NULL, at INTEGER NOT NULL)',
];

class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function refuse(status, message) {
  throw new Refusal(status, message);
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

const encoder = new TextEncoder();

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomKey(bytes = 32) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

function same(a, b) {
  const x = encoder.encode(String(a));
  const y = encoder.encode(String(b));
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = PASSWORD.iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2$${iterations}$${hex(salt)}$${hex(bits)}`;
}

async function passwordMatches(password, stored) {
  if (!stored || typeof password !== 'string' || !password) return false;
  const [, iterations, salt] = stored.split('$');
  const candidate = await hashPassword(password, Uint8Array.from(salt.match(/../g), (h) => parseInt(h, 16)), Number(iterations));
  return same(candidate, stored);
}

function newPassword(value, what) {
  const password = typeof value === 'string' ? value : '';
  if (password.length < PASSWORD.min || password.length > PASSWORD.max) {
    refuse(400, `The ${what} needs at least ${PASSWORD.min} characters.`);
  }
  return password;
}

function text(value, max, what) {
  if (typeof value !== 'string') refuse(400, `Missing ${what}.`);
  if (value.length > max) refuse(413, `That ${what} is too long.`);
  return value;
}

function now() {
  return new Date().toISOString();
}

function issueOut(row) {
  return {
    number: row.number,
    title: row.title,
    body: row.body,
    user: { login: row.login },
    created_at: row.created_at,
    updated_at: row.updated_at,
    comments: row.comments,
    state: row.state,
  };
}

function commentOut(row) {
  return { id: row.id, body: row.body, user: { login: row.login }, created_at: row.created_at, updated_at: row.updated_at };
}

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const statement of SCHEMA) this.sql.exec(statement);
    this.snapshot = null;
  }

  // ------------------------------------------------------------ routing

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method;
    try {
      if (path === '/live') return this.openLive(request);
      if (path === '/setup' && method === 'GET') return json({ needed: this.needsSetup() });
      if (path === '/setup' && method === 'POST') return await this.setup(request, await readBody(request));
      if (path === '/import' && method === 'POST') return this.importData(await readBody(request));
      if (path === '/session' && method === 'POST') return await this.signIn(request, await readBody(request));

      const who = await this.who(request.headers.get('Authorization')?.replace(/^Bearer\s+/i, ''));
      if (path === '/session' && method === 'GET') return json({ name: who.name, adminName: this.adminName(), admin: who.admin });
      if (path === '/session' && method === 'DELETE') return this.endSessions([who.hash]);
      if (path === '/session/admin' && method === 'POST') return await this.unlockAdmin(request, who, await readBody(request));
      if (path === '/session/admin' && method === 'DELETE') return this.lockAdmin(who);
      if (path === '/issues' && method === 'GET') return this.listIssues(request, who);
      if (path === '/issues' && method === 'POST') return this.createIssue(who, await readBody(request));
      if (path === '/tabs' && method === 'GET') return json({ tabs: this.legacyTabs() });
      if (path === '/people' && method === 'GET') return json(this.peopleOut(this.adminOnly(who)));
      if (path === '/people' && method === 'PATCH') return this.changePeople(this.adminOnly(who), await readBody(request));
      if (path === '/team-password' && method === 'PUT') return await this.setTeamPassword(this.adminOnly(who), await readBody(request));

      let match = path.match(/^\/issues\/(\d+)$/);
      if (match && method === 'GET') return json(this.visibleIssue(who, Number(match[1])));
      if (match && method === 'PATCH') return this.changeIssue(who, Number(match[1]), await readBody(request));
      match = path.match(/^\/issues\/(\d+)\/comments$/);
      if (match && method === 'GET') return this.listComments(who, Number(match[1]));
      if (match && method === 'POST') return this.addComment(who, Number(match[1]), await readBody(request));
      match = path.match(/^\/comments\/(\d+)$/);
      if (match && method === 'DELETE') return this.removeComment(who, Number(match[1]));
      refuse(404, 'Not found.');
    } catch (error) {
      if (error instanceof Refusal) return json({ message: error.message }, error.status);
      console.error(error);
      return json({ message: 'Something went wrong on the board\'s server. Try again in a moment.' }, 500);
    }
  }

  // ------------------------------------------------------------ settings

  setting(key) {
    const row = this.sql.exec('SELECT value FROM settings WHERE key = ?', key).toArray()[0];
    return row ? row.value : null;
  }

  setSetting(key, value) {
    this.sql.exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, String(value));
  }

  needsSetup() {
    return !this.setting('team_password');
  }

  adminName() {
    return this.setting('admin_name') || '';
  }

  legacyTabs() {
    try {
      return JSON.parse(this.setting('tabs') || '[]');
    } catch {
      return [];
    }
  }

  people() {
    return this.sql.exec('SELECT name FROM people ORDER BY position').toArray().map((row) => row.name);
  }

  setPeople(names) {
    this.sql.exec('DELETE FROM people');
    names.forEach((name, position) => this.sql.exec('INSERT INTO people (name, position) VALUES (?, ?)', name, position));
  }

  peopleOut() {
    return { names: this.people(), adminName: this.adminName() };
  }

  // Every write ends here: the next read rebuilds the snapshot.
  changed() {
    this.setSetting('version', Number(this.setting('version') || 0) + 1);
    this.snapshot = null;
  }

  // The open issues, parsed, and who owns which board. Rebuilt after a write.
  current() {
    const version = this.setting('version') || '0';
    if (this.snapshot && this.snapshot.version === version) return this.snapshot;
    const issues = this.sql.exec("SELECT * FROM issues WHERE state = 'open' ORDER BY updated_at DESC, number DESC").toArray().map(issueOut);
    const items = new Map(issues.map((issue) => [issue.number, toItem(issue)]));
    const boards = boardIndex(issues, this.legacyTabs(), this.adminName());
    this.snapshot = { version, issues, items, boards };
    return this.snapshot;
  }

  // ------------------------------------------------------------ setting up

  async setup(request, input) {
    if (!this.needsSetup()) refuse(409, 'This board is already set up.');
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    this.limitTries(ip);
    if (!this.env.SETUP_CODE || !same(String(input.code || '').trim(), this.env.SETUP_CODE)) {
      this.failedTry(ip);
      refuse(403, "That setup code isn't right.");
    }
    const adminName = cleanName(input.adminName);
    if (!adminName) refuse(400, 'Enter your first name, as the team knows you.');
    const adminPassword = newPassword(input.adminPassword, 'admin password');
    const teamPassword = newPassword(input.teamPassword, 'team password');
    if (adminPassword === teamPassword) refuse(400, 'Use a different password for admin tools than for the team.');
    this.setSetting('admin_name', adminName);
    this.setSetting('admin_password', await hashPassword(adminPassword));
    this.setSetting('team_password', await hashPassword(teamPassword));
    const names = this.people();
    if (!names.some((name) => sameName(name, adminName))) this.setPeople([adminName, ...names]);
    this.changed();
    return json({ ok: true });
  }

  // Copies in a board from elsewhere (the old GitHub one), only before setup
  // and only with the setup code. Running it again replaces what it copied.
  importData(input) {
    if (!this.needsSetup()) refuse(409, 'This board is already set up, so nothing was imported.');
    if (!this.env.SETUP_CODE || !same(String(input.code || ''), this.env.SETUP_CODE)) refuse(403, "That setup code isn't right.");
    const issues = Array.isArray(input.issues) ? input.issues : [];
    const comments = Array.isArray(input.comments) ? input.comments : [];
    const names = (Array.isArray(input.names) ? input.names : []).map(cleanName).filter(Boolean);
    const tabs = Array.isArray(input.tabs) ? input.tabs : [];
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM issues');
      this.sql.exec('DELETE FROM comments');
      for (const i of issues) {
        this.sql.exec(
          'INSERT INTO issues (number, title, body, login, created_at, updated_at, state, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          i.number, i.title, i.body || '', i.user?.login || 'github', i.created_at, i.updated_at, i.state === 'open' ? 'open' : 'closed', i.comments || 0,
        );
      }
      for (const c of comments) {
        this.sql.exec(
          'INSERT INTO comments (id, issue, body, login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          c.id, c.issue, c.body || '', c.user?.login || 'github', c.created_at, c.updated_at || c.created_at,
        );
      }
      this.setPeople([...new Map(names.map((name) => [name.toLowerCase(), name])).values()]);
      this.setSetting('tabs', JSON.stringify(tabs));
    });
    this.changed();
    return json({ issues: issues.length, comments: comments.length, people: this.people().length });
  }

  // ------------------------------------------------------------ sessions

  limitTries(ip) {
    const since = Date.now() - TRIES.window;
    this.sql.exec('DELETE FROM failures WHERE at < ?', since);
    const { n } = this.sql.exec('SELECT COUNT(*) AS n FROM failures WHERE ip = ?', ip).one();
    if (n >= TRIES.max) refuse(429, 'Too many wrong tries. Wait 15 minutes and try again.');
  }

  failedTry(ip) {
    this.sql.exec('INSERT INTO failures (ip, at) VALUES (?, ?)', ip, Date.now());
  }

  async signIn(request, input) {
    if (this.needsSetup()) refuse(409, "This board isn't set up yet.");
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    this.limitTries(ip);
    const typed = String(input.name || '').trim().replace(/\s+/g, ' ');
    if (!typed || typeof input.password !== 'string' || !input.password) refuse(400, 'Enter your first name and the team password.');
    if (!(await passwordMatches(input.password, this.setting('team_password')))) {
      this.failedTry(ip);
      refuse(401, "That password isn't right. Check it with whoever runs the board.");
    }
    const name = [this.adminName(), ...this.people()].find((other) => other && sameName(other, typed));
    if (!name) refuse(403, `${typed} isn't on this board's access list. Ask whoever runs the board to add you.`);
    const token = randomKey();
    const at = Date.now();
    this.sql.exec('INSERT INTO sessions (hash, name, admin, created, seen) VALUES (?, ?, 0, ?, ?)', await sha256(token), name, at, at);
    this.sql.exec('DELETE FROM sessions WHERE seen < ?', at - SESSION.idle);
    return json({ token, name, adminName: this.adminName() });
  }

  async who(token) {
    if (!token) refuse(401, "You've been signed out. Sign in again to carry on.");
    const hash = await sha256(token);
    const row = this.sql.exec('SELECT * FROM sessions WHERE hash = ?', hash).toArray()[0];
    const at = Date.now();
    if (!row || at - row.seen > SESSION.idle) refuse(401, "You've been signed out. Sign in again to carry on.");
    if (at - row.seen > SESSION.touch) this.sql.exec('UPDATE sessions SET seen = ? WHERE hash = ?', at, hash);
    return { hash, name: row.name, admin: row.admin === 1 && sameName(row.name, this.adminName()) };
  }

  adminOnly(who) {
    if (!who.admin) refuse(403, 'Only the admin can do that. Turn on admin tools first.');
    return who;
  }

  async unlockAdmin(request, who, input) {
    if (!sameName(who.name, this.adminName())) refuse(403, 'Only the admin can turn on admin tools.');
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    this.limitTries(ip);
    if (!(await passwordMatches(input.password, this.setting('admin_password')))) {
      this.failedTry(ip);
      refuse(403, "That admin password isn't right.");
    }
    this.sql.exec('UPDATE sessions SET admin = 1 WHERE hash = ?', who.hash);
    return json({ admin: true });
  }

  lockAdmin(who) {
    this.sql.exec('UPDATE sessions SET admin = 0 WHERE hash = ?', who.hash);
    return new Response(null, { status: 204 });
  }

  // Ends sessions and closes their live connections, which tells those
  // boards they've been signed out.
  endSessions(hashes) {
    for (const hash of hashes) {
      this.sql.exec('DELETE FROM sessions WHERE hash = ?', hash);
      for (const ws of this.ctx.getWebSockets(hash)) {
        try {
          ws.close(SIGNED_OUT, 'Signed out');
        } catch {
          // Already closing.
        }
      }
    }
    return new Response(null, { status: 204 });
  }

  // ------------------------------------------------------------ people

  changePeople(who, input) {
    const add = Array.isArray(input.add) ? input.add : [];
    const remove = Array.isArray(input.remove) ? input.remove : [];
    const cleaned = add.map(cleanName);
    if (cleaned.some((name) => !name)) refuse(400, 'Use first names of up to 40 letters. Spaces, full stops, apostrophes and hyphens are fine, as in Sam K.');
    const adminName = this.adminName();
    const before = this.people();
    const kept = before.filter((name) => sameName(name, adminName) || !remove.some((other) => sameName(other, name)));
    for (const name of cleaned) if (!kept.some((other) => sameName(other, name))) kept.push(name);
    this.ctx.storage.transactionSync(() => this.setPeople(kept));
    // Whoever is gone is signed out now, everywhere.
    const gone = before.filter((name) => !kept.some((other) => sameName(other, name)));
    if (gone.length) {
      const sessions = this.sql.exec('SELECT hash, name FROM sessions').toArray();
      this.endSessions(sessions.filter((row) => gone.some((name) => sameName(name, row.name))).map((row) => row.hash));
    }
    return json(this.peopleOut());
  }

  async setTeamPassword(who, input) {
    const password = newPassword(input.password, 'team password');
    if (await passwordMatches(password, this.setting('admin_password'))) refuse(400, 'Use a different password for the team than for admin tools.');
    this.setSetting('team_password', await hashPassword(password));
    const others = this.sql.exec('SELECT hash FROM sessions WHERE hash != ?', who.hash).toArray().map((row) => row.hash);
    this.endSessions(others);
    return json({ signedOut: others.length });
  }

  // ------------------------------------------------------------ issues

  listIssues(request, who) {
    const { version, issues, items, boards } = this.current();
    const etag = `"v${version}"`;
    if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
    return json(issues.filter((issue) => canSee(items.get(issue.number), who.name, boards)), 200, { ETag: etag });
  }

  row(number) {
    return this.sql.exec('SELECT * FROM issues WHERE number = ?', number).toArray()[0] || null;
  }

  visibleIssue(who, number) {
    const row = this.row(number);
    const issue = row && row.state === 'open' ? issueOut(row) : null;
    if (!issue || !canSee(toItem(issue), who.name, this.current().boards)) refuse(404, "That isn't on the board any more.");
    return issue;
  }

  createIssue(who, input) {
    const title = text(input.title, LIMITS.title, 'title');
    const body = stampNew(text(input.body ?? '', LIMITS.body, 'text'), who);
    const at = now();
    const draft = issueOut({ number: 0, title, body, login: who.name, created_at: at, updated_at: at, comments: 0, state: 'open' });
    const { boards } = this.current();
    if (!mayCreate(toItem(draft), who, boards)) refuse(403, "You can't add that there.");
    const { n } = this.sql.exec('SELECT MAX(number) AS n FROM issues').one();
    const number = (n || 0) + 1;
    this.sql.exec(
      "INSERT INTO issues (number, title, body, login, created_at, updated_at, state, comments) VALUES (?, ?, ?, ?, ?, ?, 'open', 0)",
      number, title, body, who.name, at, at,
    );
    this.changed();
    const issue = issueOut(this.row(number));
    this.sendItem(issue, null, boards);
    return json(issue, 201);
  }

  changeIssue(who, number, input) {
    const row = this.row(number);
    if (!row || row.state !== 'open') refuse(404, "That isn't on the board any more.");
    const { boards } = this.current();
    const before = toItem(issueOut(row));
    if (!canSee(before, who.name, boards)) refuse(404, "That isn't on the board any more.");
    if (input.state === 'closed') {
      if (!mayRemove(before, who, boards)) refuse(403, 'Only the person who made that, or the admin, can remove it.');
      this.sql.exec("UPDATE issues SET state = 'closed', updated_at = ? WHERE number = ?", now(), number);
      this.changed();
      this.sendRemoved(number, before, boards);
      return json(issueOut(this.row(number)));
    }
    const title = input.title !== undefined ? text(input.title, LIMITS.title, 'title') : row.title;
    const body = input.body !== undefined ? stampChange(row.body, text(input.body, LIMITS.body, 'text')) : row.body;
    const after = toItem(issueOut({ ...row, title, body }));
    if (!mayChange(before, after, who, boards)) {
      refuse(403, before.kind === 'board' ? 'Only the person who made this board can change that.' : 'Only the person who made that, or the admin, can change it.');
    }
    this.sql.exec('UPDATE issues SET title = ?, body = ?, updated_at = ? WHERE number = ?', title, body, now(), number);
    this.changed();
    const issue = issueOut(this.row(number));
    this.sendItem(issue, before, boards);
    return json(issue);
  }

  // ------------------------------------------------------------ comments

  listComments(who, number) {
    this.visibleIssue(who, number);
    const rows = this.sql.exec('SELECT * FROM comments WHERE issue = ? ORDER BY created_at, id', number).toArray();
    return json(rows.map(commentOut));
  }

  addComment(who, number, input) {
    this.visibleIssue(who, number);
    const { text: words } = parseBody(text(input.body, LIMITS.body, 'comment'));
    if (!words) refuse(400, 'Write something first.');
    const body = encodeBody({ author: who.name }, words);
    const at = now();
    const { n } = this.sql.exec('SELECT MAX(id) AS n FROM comments').one();
    const id = (n || 0) + 1;
    this.sql.exec('INSERT INTO comments (id, issue, body, login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, number, body, who.name, at, at);
    this.sql.exec('UPDATE issues SET comments = comments + 1, updated_at = ? WHERE number = ?', at, number);
    this.changed();
    const comment = commentOut(this.sql.exec('SELECT * FROM comments WHERE id = ?', id).one());
    this.sendComment(number, id, toComment(comment));
    return json(comment, 201);
  }

  removeComment(who, id) {
    const row = this.sql.exec('SELECT * FROM comments WHERE id = ?', id).toArray()[0];
    if (!row) refuse(404, "That comment isn't there any more.");
    this.visibleIssue(who, row.issue);
    const comment = toComment(commentOut(row));
    if (!who.admin && !sameName(comment.author, who.name)) refuse(403, 'Only the person who wrote that, or the admin, can remove it.');
    this.sql.exec('DELETE FROM comments WHERE id = ?', id);
    this.sql.exec('UPDATE issues SET comments = MAX(comments - 1, 0), updated_at = ? WHERE number = ?', now(), row.issue);
    this.changed();
    this.sendComment(row.issue, id, null);
    return new Response(null, { status: 204 });
  }

  // ------------------------------------------------------------ live

  // The session key comes as the second WebSocket subprotocol, which keeps
  // it out of URLs (and so out of logs).
  async openLive(request) {
    if (request.headers.get('Upgrade') !== 'websocket') refuse(426, 'This address is for live updates.');
    const offered = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((s) => s.trim());
    if (offered[0] !== LIVE.protocol) refuse(400, 'Unknown live protocol.');
    const who = await this.who(offered[1]);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [who.hash]);
    server.serializeAttachment({ name: who.name, from: randomKey(9) });
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': LIVE.protocol } });
  }

  // Passes on what people do but don't save (who's here, a note being
  // dragged, a stroke being drawn) to everyone else, stamped with who sent
  // it, and never to someone who can't see the board it's on.
  webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > LIVE.max) return;
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment();
    if (!me || !message || !LIVE.types.has(message.t)) return;
    message.from = me.from;
    if (message.t === 'hello') message.name = me.name;
    this.relay(ws, message);
  }

  webSocketClose(ws, code) {
    this.relay(ws, { t: 'bye', from: ws.deserializeAttachment()?.from });
    try {
      ws.close(code === 1005 ? 1000 : code, 'Closing');
    } catch {
      // Already closed.
    }
  }

  webSocketError(ws) {
    this.relay(ws, { t: 'bye', from: ws.deserializeAttachment()?.from });
  }

  relay(sender, message) {
    const { items, boards } = this.current();
    const hidden = (tab, name) => {
      const board = tab != null ? boards.get(tab) : null;
      return Boolean(board) && board.visibility === 'private' && !sameName(board.owner, name);
    };
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === sender) continue;
      const them = ws.deserializeAttachment();
      if (!them) continue;
      let out = message;
      if ((message.t === 'ink' || message.t === 'ink-done') && hidden(message.tab, them.name)) continue;
      if (message.t === 'hello' && hidden(message.tab, them.name)) out = { ...message, tab: null };
      if (message.t === 'move') {
        const moves = (message.moves || []).filter((move) => {
          const item = items.get(move.number);
          return item && canSee(item, them.name, boards);
        });
        if (!moves.length) continue;
        out = { ...message, moves };
      }
      send(ws, out);
    }
  }

  // A saved change, to everyone who can see it. Someone who could see it
  // before and can't now (a board made private) hears that it's gone.
  sendItem(issue, before, boardsBefore) {
    const { boards } = this.current();
    const item = toItem(issue);
    for (const ws of this.ctx.getWebSockets()) {
      const them = ws.deserializeAttachment();
      if (!them) continue;
      if (canSee(item, them.name, boards)) send(ws, { t: 'item', number: issue.number, item });
      else if (before && canSee(before, them.name, boardsBefore)) send(ws, { t: 'item', number: issue.number, item: null });
    }
  }

  sendRemoved(number, before, boardsBefore) {
    for (const ws of this.ctx.getWebSockets()) {
      const them = ws.deserializeAttachment();
      if (them && canSee(before, them.name, boardsBefore)) send(ws, { t: 'item', number, item: null });
    }
  }

  sendComment(number, id, comment) {
    const { items, boards } = this.current();
    const item = items.get(number);
    for (const ws of this.ctx.getWebSockets()) {
      const them = ws.deserializeAttachment();
      if (!them || !item || !canSee(item, them.name, boards)) continue;
      send(ws, { t: 'comment', number, id, comment });
      send(ws, { t: 'item', number, item });
    }
  }
}

function send(ws, message) {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The connection is closing; that board will catch up when it reconnects.
  }
}

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > LIMITS.request) refuse(413, 'That is too big to save.');
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    refuse(400, "That request wasn't readable.");
  }
  return {};
}
