// FEDI Boards' screens: sign in, boards (each a zoomable surface of notes,
// lines between them, groups, handwritten text and drawings; shared with the
// team or private to one person), one idea with its comments, and the admin
// tools for tidying up shared boards.
//
// All user-written text reaches the page through textContent (the h() helper
// appends strings as text nodes). Nothing here ever assigns innerHTML.

import { open as openVault } from './vault.js';
import { Store, COLORS, GROUP_COLORS, PENS, STRING_COLORS } from './store.js';
import { renderView, buildNotesPdf } from './exporter.js';
import { Live } from './live.js';

const KEYS = {
  session: 'idea-board:session',
  tab: 'idea-board:tab',
  theme: 'idea-board:theme',
  views: 'idea-board:views',
  rail: 'idea-board:rail',
  pen: 'idea-board:pen',
  string: 'idea-board:string',
};
// GitHub is still checked as the record: every 30 s while live updates are
// flowing, every 5 s when they aren't. Everyone shares one GitHub key and
// its hourly request limit, so with many people on the board the slow
// check matters; the relay carries the changes in between.
const POLL = { live: 30000, fallback: 5000, tabs: 60000, comments: 10000 };
const PRESENCE = { every: 20000, expire: 50000 };

// Every tab's board is this big, in board pixels, and nothing can leave it.
const BOARD = { width: 3200, height: 2000 };
// How far people can zoom out and in.
const ZOOM = { min: 0.25, max: 2, step: 1.25 };
// A note's width is fixed; its height is nominal, for layout and clamping.
const NOTE = { width: 220, height: 170 };
const SLOT = { width: 250, height: 230 };
// How far past the board's edge someone can pan, in screen pixels.
const PAN_SLACK = 80;
const PEN_WIDTHS = { s: 3, m: 6, l: 12 };
// GitHub caps an issue body at 65,536 characters; a drawing that grows past
// this carries on in a new one.
const SKETCH_LIMIT = 60000;
const DOUBLE_TAP = { ms: 400, px: 24 };
const THEMES = ['auto', 'cork', 'whiteboard', 'chalk', 'night'];
const SVG_NS = 'http://www.w3.org/2000/svg';

const state = {
  vault: null,
  session: null, // { name, member, admin, vaultId }
  store: null,
  admin: null, // a Store holding the admin key, once unlocked
  loaded: false,
  tabs: [], // the boards this person can see
  allBoards: [], // every board, including other people's private ones (never shown)
  boardItems: [],
  legacyTabs: [],
  editingBoard: null,
  current: null,
  serverItems: null,
  items: [],
  ideas: [],
  groups: [],
  texts: [],
  sketches: [],
  detail: null,
  comments: [],
  commentsLoaded: false,
  editing: null,
  editingText: null,
  editingGroup: null,
  newSpot: null,
  textSpot: null,
  tabMode: 'create',
  timers: [],
  commentTimer: null,
  busy: { items: false, tabs: false, comments: false },
  view: { zoom: 1, x: 32, y: 32 },
  views: {},
  spots: new Map(),
  mode: 'move',
  selected: new Set(),
  lineStart: null,
  pen: { color: 'ink', size: 'm' },
  stringColor: 'default',
  editingLine: null,
  eraser: false,
  draft: null,
  liveStroke: null,
  erasing: null,
  drag: null,
  staleBoard: false,
  suppressClick: false,
  pointers: new Map(),
  gesture: null,
  panStart: null,
  lastTap: null,
  menuSpot: null,
  moves: new Map(), // item number -> { spot, timer, saving }
  live: null,
  liveStatus: 'off',
  lastPoll: 0,
  reconcileTimer: null,
  peers: new Map(), // sender id -> { name, tab, at }
  remoteMoves: new Map(), // item number -> { x, y, at, seq, from }
  remoteInk: new Map(), // stroke id -> { tab, color, width, points, line, at }
  outgoingMoves: new Map(),
  outgoingTimer: null,
  sendSeq: 0,
};

const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value != null) el.setAttribute(key, value);
  return el;
}

function readStorage(kind, key) {
  try {
    return JSON.parse(window[kind].getItem(key));
  } catch {
    return null;
  }
}

function writeStorage(kind, key, value) {
  try {
    if (value == null) window[kind].removeItem(key);
    else window[kind].setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the board still works, it just forgets on reload.
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(iso) {
  let value = (Date.parse(iso) - Date.now()) / 1000;
  if (Math.abs(value) < 60) return 'just now';
  const steps = [[60, 'minute'], [24, 'hour'], [7, 'day'], [4.345, 'week'], [12, 'month'], [Infinity, 'year']];
  value /= 60;
  for (const [size, unit] of steps) {
    if (Math.abs(value) < size) return relative.format(Math.round(value), unit);
    value /= size;
  }
  return '';
}

function tilt(number) {
  return (((number * 37) % 7) - 3) * 0.45;
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('toast--error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 3500);
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
}

async function busy(button, label, work) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await work();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function sameName(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function isAdminName() {
  return Boolean(state.session && state.session.member.admin && sameName(state.session.name, state.session.member.admin));
}

function canChange(author) {
  return Boolean(state.admin) || sameName(author, state.session.name);
}

// Internally a board is still a "tab": state.tabs is the boards this person
// can see, in the order the side panel lists them.
function currentTab() {
  return state.tabs.find((tab) => tab.id === state.current) || null;
}

// Which visible board something is on, or null when it's on a board this
// person can't see (somebody else's private board, or one that was deleted).
// Things from before boards were named at all go on the first shared board.
function tabOf(item) {
  if (state.tabs.some((tab) => tab.id === item.tab)) return item.tab;
  if (item.tab == null) {
    const shared = state.tabs.find((tab) => tab.visibility === 'public');
    return shared ? shared.id : null;
  }
  return null;
}

function boardById(id) {
  return state.allBoards.find((board) => board.id === id) || null;
}

function isPrivateBoard(id) {
  const board = boardById(id);
  return Boolean(board && board.visibility === 'private');
}

// What the relay may carry about an item: nothing on a private board goes to
// other people's browsers. A board itself is always relayed (only its name
// and settings), so one made private or deleted leaves everyone's list at once.
function shareable(item) {
  if (!item) return true;
  if (item.kind === 'board') return true;
  return !isPrivateBoard(item.tab);
}

function personalBoardId(name) {
  return `me-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'board'}`;
}

function canManageBoard(board) {
  if (!board || !state.session) return false;
  if (board.personal) return false;
  return sameName(board.owner || '', state.session.name) || (Boolean(state.admin) && board.visibility === 'public');
}

// Only the person who made a board can delete it; the admin can rename
// someone else's public board but not delete it. (The boards from before
// boards were issues belong to the admin.)
function canDeleteBoard(board) {
  if (!board || !state.session || board.personal) return false;
  return sameName(board.owner || '', state.session.name);
}

// Boards come from two places: board issues, and the older tabs.json (read
// only; a board issue with the same id overrides its entry, including a
// "deleted" one). The owner of an old board is the admin.
function computeBoards() {
  const me = state.session ? state.session.name : '';
  const fromIssues = new Map();
  for (const board of [...state.boardItems].sort((a, b) => a.number - b.number)) {
    if (!fromIssues.has(board.id)) fromIssues.set(board.id, board); // a duplicate made in a race: oldest wins
  }
  const adminName = state.session ? state.session.member.admin : null;
  const legacy = state.legacyTabs
    .filter((tab) => !fromIssues.has(tab.id))
    .map((tab, index) => ({ id: tab.id, name: tab.name, owner: adminName, visibility: 'public', personal: false, legacy: true, order: index }));
  const all = [...legacy, ...[...fromIssues.values()].filter((board) => !board.deleted)];
  state.allBoards = [...legacy, ...fromIssues.values()];
  const mine = (board) => sameName(board.owner || '', me);
  const visible = all.filter((board) => board.visibility === 'public' || mine(board));
  const rank = (board) => (board.personal && mine(board) ? 0 : board.legacy ? 1 : 2);
  visible.sort((a, b) => rank(a) - rank(b) || (a.legacy ? a.order - b.order : (a.number || 0) - (b.number || 0)));
  state.tabs = visible;
}

function onTab(list, tabId = state.current) {
  return list.filter((item) => tabOf(item) === tabId);
}

function ideasIn(tabId) {
  return onTab(state.ideas, tabId);
}

function findItem(number) {
  return state.items.find((item) => item.number === number) || null;
}

// ---------------------------------------------------------------- local item state

function setItems(items) {
  state.items = items;
  state.ideas = items.filter((item) => item.kind === 'idea');
  state.groups = items.filter((item) => item.kind === 'group');
  state.texts = items.filter((item) => item.kind === 'text');
  state.sketches = items.filter((item) => item.kind === 'sketch');
  state.boardItems = items.filter((item) => item.kind === 'board');
  computeBoards();
}

function patchLocal(number, changes) {
  setItems(state.items.map((item) => (item.number === number ? { ...item, ...changes } : item)));
}

function upsertLocal(item) {
  const exists = state.items.some((other) => other.number === item.number);
  setItems(exists ? state.items.map((other) => (other.number === item.number ? item : other)) : [...state.items, item]);
}

// What this browser knows that the server doesn't show yet: positions on
// their way and the drawing in progress. Applied on every refresh so nothing
// jumps back while it's being saved.
function withLocal(items) {
  let out = items;
  const now = Date.now();
  for (const [number, move] of state.remoteMoves) if (now - move.at > 15000) state.remoteMoves.delete(number);
  if (state.moves.size || state.remoteMoves.size) {
    out = out.map((item) => {
      // Our own unsaved move wins; then one somebody else is making right now.
      const move = state.moves.get(item.number);
      if (move) return { ...item, x: move.spot.x, y: move.spot.y };
      const remote = state.remoteMoves.get(item.number);
      return remote ? { ...item, x: remote.x, y: remote.y } : item;
    });
  }
  const draft = state.draft;
  if (draft && (draft.strokes.length || draft.number != null)) {
    const local = draftItem(draft);
    out = out.some((item) => item.number === local.number)
      ? out.map((item) => (item.number === local.number ? local : item))
      : [...out, local];
    if (!draft.strokes.length) out = out.filter((item) => item.number !== local.number);
  }
  return out;
}

// ---------------------------------------------------------------- theme and panel

function savedTheme() {
  try {
    const theme = localStorage.getItem(KEYS.theme);
    return THEMES.includes(theme) ? theme : 'auto';
  } catch {
    return 'auto';
  }
}

function applyTheme(theme) {
  const value = THEMES.includes(theme) ? theme : 'auto';
  if (value === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', value);
  try {
    localStorage.setItem(KEYS.theme, value);
  } catch {
    // Not remembered, but applied for this visit.
  }
}

function setRail(collapsed) {
  $('app').classList.toggle('rail-collapsed', collapsed);
  $('rail-toggle').setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  $('rail-toggle-label').textContent = collapsed ? 'Show the side panel' : 'Hide the side panel';
  $('rail-toggle').title = collapsed ? 'Show the side panel' : 'Hide the side panel';
  writeStorage('localStorage', KEYS.rail, collapsed ? 'collapsed' : 'open');
}

// ---------------------------------------------------------------- sign in

async function boot() {
  state.views = readStorage('localStorage', KEYS.views) || {};
  if (typeof state.views !== 'object' || Array.isArray(state.views)) state.views = {};
  const pen = readStorage('localStorage', KEYS.pen);
  if (pen && PENS.includes(pen.color) && PEN_WIDTHS[pen.size]) state.pen = { color: pen.color, size: pen.size };
  const string = readStorage('localStorage', KEYS.string);
  if (STRING_COLORS.includes(string)) state.stringColor = string;
  wire();
  try {
    const res = await fetch('vault.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('vault');
    state.vault = await res.json();
  } catch {
    showSignin('unavailable');
    return;
  }
  if (state.vault.pending) {
    showSignin('pending');
    return;
  }
  // A rebuild re-seals the vault with a new salt. Forcing a fresh sign-in then
  // is what makes a name removed from the access list take effect.
  const saved = readStorage('sessionStorage', KEYS.session);
  if (saved && saved.member && saved.vaultId === state.vault.member.salt) {
    startBoard(saved);
    return;
  }
  writeStorage('sessionStorage', KEYS.session, null);
  showSignin('ready');
}

function showSignin(mode) {
  $('app').hidden = true;
  $('signin').hidden = false;
  $('signin-form').hidden = mode !== 'ready';
  const note = $('signin-note');
  note.hidden = mode === 'ready';
  if (mode === 'pending') {
    note.textContent = "This board is almost ready. Its access keys haven't been added yet, so nobody can sign in.";
  } else if (mode === 'unavailable') {
    note.textContent = "The board couldn't load its settings. Refresh the page to try again.";
  }
  if (mode === 'ready') $('signin-name').focus();
}

async function signIn(event) {
  event.preventDefault();
  $('signin-error').hidden = true;
  const name = $('signin-name').value.trim();
  const password = $('signin-password').value;
  if (!name || !password) {
    showError('signin-error', 'Enter your first name and the team password.');
    return;
  }
  await busy($('signin-submit'), 'Checking...', async () => {
    const member = await openVault(password, state.vault.member);
    if (!member) {
      showError('signin-error', "That password isn't right. Check it with whoever runs the board.");
      return;
    }
    const match = member.names.find((n) => sameName(n, name));
    if (!match) {
      showError('signin-error', `${name} isn't on this board's access list. Ask whoever runs the board to add you.`);
      return;
    }
    $('signin-password').value = '';
    const session = { name: match, member, admin: null, vaultId: state.vault.member.salt };
    writeStorage('sessionStorage', KEYS.session, session);
    startBoard(session);
  });
}

function signOut() {
  if (state.mode !== 'move') setMode('move');
  stopLive();
  stopPolling();
  closeDialogs();
  writeStorage('sessionStorage', KEYS.session, null);
  Object.assign(state, { store: null, admin: null, loaded: false, legacyTabs: [], serverItems: null, current: null });
  setItems([]);
  state.session = null;
  history.replaceState(null, '', location.pathname);
  showSignin('ready');
}

function saveSession() {
  writeStorage('sessionStorage', KEYS.session, state.session);
}

// ---------------------------------------------------------------- data

async function startBoard(session) {
  state.session = session;
  state.store = new Store(session.member);
  state.admin = session.admin ? new Store(session.admin) : null;
  $('signin').hidden = true;
  $('app').hidden = false;
  setRail(readStorage('localStorage', KEYS.rail) === 'collapsed');
  setMode('move');
  renderAll();
  startLive();
  await Promise.all([refreshTabs(), refreshItems()]);
  await ensureMyBoard();
  state.loaded = true;
  chooseTab(initialTab());
  startPolling();
}

// Everyone has a private "My Board". It's made the first time they sign in
// (only once the board list has loaded, so a failed load can't make a second).
async function ensureMyBoard() {
  const me = state.session.name;
  if (state.serverItems == null) return;
  if (state.allBoards.some((board) => board.personal && sameName(board.owner || '', me))) return;
  try {
    upsertLocal(await state.store.createItem({
      kind: 'board', id: personalBoardId(me), name: 'My Board', owner: me, visibility: 'private', personal: true, author: me,
    }));
  } catch (error) {
    toast(`Your private board couldn't be set up. ${error.message}`, true);
  }
}

// Opens on the board in the address, else the last one used, else the first
// shared board (where the team is), else whatever there is.
function initialTab() {
  const ids = state.tabs.map((tab) => tab.id);
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (ids.includes(fromHash)) return fromHash;
  const remembered = readStorage('localStorage', KEYS.tab);
  if (ids.includes(remembered)) return remembered;
  const shared = state.tabs.find((tab) => tab.visibility === 'public');
  return shared ? shared.id : ids[0] || null;
}

function chooseTab(id) {
  if (id !== state.current && state.mode !== 'move') setMode('move');
  const changed = id !== state.current;
  state.current = id;
  if (id) {
    history.replaceState(null, '', `#${id}`);
    writeStorage('localStorage', KEYS.tab, id);
  }
  renderAll();
  restoreView();
  if (changed) sayHello(false);
  renderPresence();
}

async function refreshTabs() {
  if (state.busy.tabs || !state.store) return;
  state.busy.tabs = true;
  try {
    // The boards from before boards were issues; read only.
    const { tabs } = await state.store.getTabs();
    if (tabs !== state.legacyTabs) {
      state.legacyTabs = tabs;
      computeBoards();
      renderAll();
    }
    $('banner').hidden = true;
  } catch (error) {
    showBanner(error);
  } finally {
    state.busy.tabs = false;
  }
}

async function refreshItems() {
  if (state.busy.items || !state.store) return;
  state.busy.items = true;
  state.lastPoll = Date.now();
  try {
    const items = await state.store.listItems();
    if (items !== state.serverItems) {
      state.serverItems = items;
      setItems(withLocal(items));
      renderAll();
      if (state.detail != null) renderDetail();
    }
    $('banner').hidden = true;
  } catch (error) {
    showBanner(error);
  } finally {
    state.busy.items = false;
  }
}

function showBanner(error) {
  const banner = $('banner');
  banner.textContent = error.message;
  banner.hidden = false;
}

function startPolling() {
  stopPolling();
  state.timers.push(setInterval(() => {
    if (document.hidden) return;
    const every = state.liveStatus === 'live' ? POLL.live : POLL.fallback;
    if (Date.now() - state.lastPoll >= every - 250) refreshItems();
  }, POLL.fallback));
  state.timers.push(setInterval(() => { if (!document.hidden) refreshTabs(); }, POLL.tabs));
}

function stopPolling() {
  state.timers.forEach(clearInterval);
  state.timers = [];
}

// ---------------------------------------------------------------- live updates

function startLive() {
  stopLive();
  const { member } = state.session;
  // Nothing on a private board is relayed: other people's browsers never get it.
  state.store.onChange = (number, item) => {
    if (shareable(item || findItem(number))) announce({ t: 'item', number, item });
  };
  state.store.onComment = (number, id, comment) => {
    if (shareable(findItem(number))) announce({ t: 'comment', number, id, comment });
  };
  state.live = new Live({
    secret: `${member.repo}|${member.token}`,
    onMessage: onLive,
    onStatus: setLiveStatus,
  });
  state.live.start().catch(() => setLiveStatus('offline'));
  state.liveTimers = [
    setInterval(() => sayHello(false), PRESENCE.every),
    setInterval(() => {
      renderPresence();
      drawRemoteInk();
    }, 10000),
  ];
}

function stopLive() {
  (state.liveTimers || []).forEach(clearInterval);
  state.liveTimers = [];
  if (state.live) {
    state.live.send({ t: 'bye' });
    const live = state.live;
    setTimeout(() => live.stop(), 300);
  }
  state.live = null;
  state.peers.clear();
  state.remoteInk.clear();
  state.remoteMoves.clear();
  setLiveStatus('off');
}

function announce(message) {
  if (!state.live) return;
  state.live.send(message).then((sent) => {
    // Too big to relay (a very large drawing): ask everyone to fetch it instead.
    if (!sent && message.t === 'item' && state.liveStatus === 'live') state.live.send({ t: 'refresh' });
  });
}

function setLiveStatus(status) {
  const was = state.liveStatus;
  state.liveStatus = status;
  if (status === 'live' && was !== 'live') {
    // Ask who's here, and catch up on anything missed while disconnected.
    sayHello(true);
    if (state.loaded) refreshItems();
  }
  renderPresence();
}

function sayHello(ask) {
  // On a private board, people see you're here but not where.
  const where = isPrivateBoard(state.current) ? null : state.current;
  if (state.live && state.session) announce({ t: 'hello', name: state.session.name, tab: where, ask });
}

// After somebody else's change, check GitHub a little later: it confirms the
// change and picks up anything a relay message can't carry (comment counts).
function reconcileSoon(delay = 6000) {
  clearTimeout(state.reconcileTimer);
  state.reconcileTimer = setTimeout(() => {
    refreshItems();
    if (state.detail != null) loadComments();
  }, delay);
}

function applyStoreView() {
  state.serverItems = state.store.view();
  setItems(withLocal(state.serverItems));
  renderAll();
  if (state.detail != null) renderDetail();
}

function elementFor(number) {
  return document.querySelector(`#notes [data-number="${number}"], #texts [data-number="${number}"]`);
}

function onLive(message) {
  if (!state.session) return;
  const from = message.from;
  if (from) {
    const peer = state.peers.get(from);
    if (peer) peer.at = Date.now();
  }
  switch (message.t) {
    case 'item': {
      if (!Number.isInteger(message.number)) return;
      if (state.store.applyRemote(message.number, message.item || null)) {
        // If someone is dragging this right now, their live position wins over
        // a save that was already on its way (an earlier drop of the same note).
        const move = state.remoteMoves.get(message.number);
        if (!move || Date.now() - move.at > 1500) state.remoteMoves.delete(message.number);
        applyStoreView();
      }
      // A board that just became visible here (made public) has things on it
      // that were never relayed; fetch them now rather than at the next check.
      if (message.item && message.item.kind === 'board') reconcileSoon(600);
      break;
    }
    case 'move': {
      for (const { number, x, y, seq } of message.moves || []) {
        if (state.drag && (state.drag.number === number || (state.drag.members || []).some((m) => m.number === number))) continue;
        const last = state.remoteMoves.get(number);
        if (last && last.from === from && last.seq > seq) continue;
        state.remoteMoves.set(number, { x, y, seq, from, at: Date.now() });
        patchLocal(number, { x, y });
        const el = elementFor(number);
        if (el) {
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
        }
      }
      redrawOverlays();
      break;
    }
    case 'ink': {
      const ink = state.remoteInk.get(message.id) || { tab: message.tab, color: message.color, width: message.width, points: [] };
      const start = Math.min(message.start || 0, ink.points.length);
      ink.points = ink.points.slice(0, start).concat(message.points || []);
      ink.at = Date.now();
      state.remoteInk.set(message.id, ink);
      drawRemoteInk();
      break;
    }
    case 'ink-done': {
      const ink = state.remoteInk.get(message.id) || { tab: message.tab, color: message.color, width: message.width, points: [] };
      // Kept on screen until the drawing it belongs to arrives.
      ink.line = message.line;
      if (message.line) ink.points = message.line.split('|')[2].split(' ').map((pair) => {
        const [x, y] = pair.split(',');
        return { x: Number(x), y: Number(y) };
      });
      ink.at = Date.now();
      state.remoteInk.set(message.id, ink);
      drawRemoteInk();
      break;
    }
    case 'ink-cancel':
      state.remoteInk.delete(message.id);
      drawRemoteInk();
      break;
    case 'comment': {
      state.store.rememberComment(message.number, message.id, message.comment || null, { quiet: true });
      if (state.detail === message.number) {
        const list = state.store.cachedComments(message.number);
        if (list) {
          state.comments = list;
          state.commentsLoaded = true;
          renderComments();
        }
      }
      // The note's comment count comes from GitHub; pick it up shortly.
      reconcileSoon(10000);
      break;
    }
    case 'refresh':
      reconcileSoon(1500);
      break;
    case 'hello':
      if (!from) return;
      state.peers.set(from, { name: String(message.name || 'Someone').slice(0, 40), tab: message.tab, at: Date.now() });
      // Answer a newcomer, a little later than everybody else might.
      if (message.ask) setTimeout(() => sayHello(false), 200 + Math.random() * 1200);
      renderPresence();
      break;
    case 'bye':
      state.peers.delete(from);
      renderPresence();
      break;
    default:
      break;
  }
}

// Positions of things being dragged go out ~20 times a second, newest only.
function liveMoves(list) {
  if (!state.live || state.liveStatus !== 'live' || isPrivateBoard(state.current)) return;
  for (const { number, x, y } of list) state.outgoingMoves.set(number, { number, x, y });
  if (state.outgoingTimer) return;
  state.outgoingTimer = setTimeout(() => {
    state.outgoingTimer = null;
    const moves = [...state.outgoingMoves.values()].map((move) => ({ ...move, seq: ++state.sendSeq }));
    state.outgoingMoves.clear();
    if (moves.length) announce({ t: 'move', moves });
  }, 50);
}

function drawRemoteInk() {
  const now = Date.now();
  const paths = [];
  for (const [id, ink] of state.remoteInk) {
    const settled = ink.line && state.sketches.some((sketch) => sketch.strokes.includes(ink.line));
    if (settled || now - ink.at > 20000) {
      state.remoteInk.delete(id);
      continue;
    }
    if (ink.tab !== state.current || !ink.points.length) continue;
    paths.push(svg('path', { d: strokePath(ink.points), class: `ink-stroke pen--${ink.color}`, 'stroke-width': ink.width }));
  }
  $('ink-remote').replaceChildren(...paths);
}

function renderPresence() {
  const status = $('live-status');
  const labels = {
    live: ['Live', 'Changes appear for everyone as they happen.'],
    connecting: ['Connecting', 'Connecting for live updates.'],
    offline: ['Catching up', 'Live updates are unavailable right now, so the board checks for changes every few seconds.'],
    off: ['', ''],
  };
  const [label, title] = labels[state.liveStatus] || labels.off;
  status.className = `live-status live-status--${state.liveStatus}`;
  status.title = title;
  $('live-label').textContent = label;
  const now = Date.now();
  for (const [id, peer] of state.peers) if (now - peer.at > PRESENCE.expire) state.peers.delete(id);
  // One chip per person, however many tabs they have open.
  const people = new Map();
  for (const peer of state.peers.values()) {
    // Your own other windows aren't "somebody else".
    if (state.session && sameName(peer.name, state.session.name)) continue;
    const key = peer.name.toLowerCase();
    if (!people.has(key) || people.get(key).tab !== state.current) people.set(key, peer);
  }
  const everyone = [...people.values()].sort((a, b) => (b.tab === state.current) - (a.tab === state.current));
  const chips = everyone.slice(0, 6).map((peer) => {
    const tab = state.tabs.find((item) => item.id === peer.tab);
    const here = peer.tab === state.current;
    return h('span', {
      class: `peer${here ? '' : ' peer--elsewhere'}`,
      style: `--peer: hsl(${[...peer.name].reduce((sum, c) => sum + c.charCodeAt(0), 0) * 47 % 360} 55% 45%)`,
      title: `${peer.name}${tab ? ` is on ${tab.name}` : ''}`,
    }, peer.name.charAt(0).toUpperCase());
  });
  if (everyone.length > 6) {
    chips.push(h('span', { class: 'peer peer--more', title: everyone.slice(6).map((peer) => peer.name).join(', ') }, `+${everyone.length - 6}`));
  }
  $('peers').replaceChildren(...chips);
  $('peers').setAttribute('aria-label', people.size ? `Also here: ${[...people.values()].map((p) => p.name).join(', ')}` : 'Nobody else here right now');
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  if (!state.session) return;
  // The board on screen was deleted or made private by its owner: move on.
  if (state.loaded && state.tabs.length && !currentTab()) {
    state.current = initialTab();
    history.replaceState(null, '', `#${state.current}`);
    setTimeout(restoreView, 0);
  }
  renderWho();
  renderTabs();
  renderBoard();
}

function lockIcon() {
  const icon = svg('svg', { viewBox: '0 0 16 16', width: '12', height: '12', class: 'lock', 'aria-hidden': 'true' });
  icon.append(
    svg('rect', { x: '3', y: '7', width: '10', height: '7', rx: '1.5', fill: 'currentColor' }),
    svg('path', { d: 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }),
  );
  return icon;
}

function renderWho() {
  const { name } = state.session;
  $('who-name').textContent = name;
  $('who-initial').textContent = name.charAt(0).toUpperCase();
  $('who-role').textContent = state.admin ? 'Admin tools on' : 'Member';
  const toggle = $('admin-toggle');
  toggle.hidden = !isAdminName();
  toggle.textContent = state.admin ? 'Admin on' : 'Admin';
  toggle.setAttribute('aria-pressed', state.admin ? 'true' : 'false');
}

function renderTabs() {
  const list = $('tab-list');
  if (!state.tabs.length) {
    list.replaceChildren(h('p', { class: 'rail-empty' }, state.loaded ? 'No boards yet' : 'Loading...'));
  } else {
    list.replaceChildren(...state.tabs.map((tab) => h('button', {
      type: 'button',
      class: `tab${tab.visibility === 'private' ? ' tab--private' : ''}`,
      'aria-current': tab.id === state.current ? 'page' : null,
      title: tab.visibility === 'private' ? 'Private: only you can see this board' : null,
      onclick: () => chooseTab(tab.id),
    },
    tab.visibility === 'private' ? lockIcon() : null,
    h('span', { class: 'tab-name' }, tab.name),
    h('span', { class: 'tab-count' }, String(ideasIn(tab.id).length)))));
  }
}

function renderBoard() {
  const tab = currentTab();
  const ideas = tab ? ideasIn(tab.id) : [];
  $('tab-title').textContent = tab ? tab.name : 'FEDI Boards';
  $('tab-count').textContent = tab ? plural(ideas.length, 'idea') : '';
  $('board-badge').hidden = !(tab && tab.visibility === 'private');
  document.title = tab ? `${tab.name} - FEDI Boards` : 'FEDI Boards';
  $('new-idea').disabled = !tab;
  for (const button of document.querySelectorAll('.mode')) button.disabled = !tab;
  $('board-tools').hidden = !canManageBoard(tab);
  $('delete-board').hidden = !canDeleteBoard(tab);

  // Never rebuild the board under someone's finger; catch up when they let go.
  if (state.drag) {
    state.staleBoard = true;
  } else {
    drawNotes(ideas);
    drawTexts();
    drawInk();
    redrawOverlays();
  }

  const empty = $('empty');
  const nothingHere = tab && !ideas.length && !onTab(state.texts).length && !onTab(state.sketches).length;
  if (!state.loaded) {
    empty.replaceChildren(h('p', { class: 'empty-title' }, 'Loading the board...'));
    empty.hidden = false;
  } else if (!tab) {
    empty.replaceChildren(
      h('p', { class: 'empty-title' }, 'No boards yet'),
      h('p', {}, 'Make a board to start pinning ideas. You can share it with the team or keep it to yourself.'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openBoardDialog(null) }, 'New board'),
    );
    empty.hidden = false;
  } else if (nothingHere && state.mode === 'move') {
    empty.replaceChildren(
      h('p', { class: 'empty-title' }, `Nothing on ${tab.name} yet`),
      h('p', {}, tab.visibility === 'private'
        ? 'This board is private: nobody else sees it. Post an idea, or double-click anywhere to write or draw.'
        : 'Post the first idea, or double-click anywhere on the board to write or draw.'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openIdeaDialog(null) }, 'New idea'),
    );
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }
}

function clampBox(x, y, width, height) {
  return {
    x: Math.round(clamp(x, 0, BOARD.width - Math.min(width, BOARD.width))),
    y: Math.round(clamp(y, 0, BOARD.height - Math.max(Math.min(height, BOARD.height), 40))),
  };
}

function overlaps(a, b) {
  return Math.abs(a.x - b.x) < NOTE.width && Math.abs(a.y - b.y) < NOTE.height + 20;
}

// Notes with a saved position go there. Any without one are laid out in the
// first free grid slots, in the order they were posted, so everyone sees the
// same arrangement until somebody moves them.
function layout(ideas) {
  const spots = new Map();
  const taken = [];
  for (const idea of ideas) {
    if (idea.x == null || idea.y == null) continue;
    const spot = clampBox(idea.x, idea.y, NOTE.width, NOTE.height);
    spots.set(idea.number, spot);
    taken.push(spot);
  }
  const columns = Math.floor((BOARD.width - 80) / SLOT.width);
  const slots = columns * Math.floor((BOARD.height - 80) / SLOT.height);
  let slot = 0;
  for (const idea of [...ideas].sort((a, b) => a.number - b.number)) {
    if (spots.has(idea.number)) continue;
    let spot = null;
    while (slot < slots && !spot) {
      const candidate = { x: 40 + (slot % columns) * SLOT.width, y: 40 + Math.floor(slot / columns) * SLOT.height };
      slot++;
      if (!taken.some((other) => overlaps(other, candidate))) spot = candidate;
    }
    // A full board stacks the rest near the corner rather than off the edge.
    if (!spot) spot = clampBox(40 + (idea.number % 12) * 14, 40 + (idea.number % 12) * 14, NOTE.width, NOTE.height);
    spots.set(idea.number, spot);
    taken.push(spot);
  }
  return spots;
}

function drawNotes(ideas) {
  const active = document.activeElement;
  const focused = active && active.classList && active.classList.contains('note') ? active.dataset.number : null;
  state.spots = layout(ideas);
  // Most recently touched on top, so a note somebody just moved lands above its neighbours.
  const order = [...ideas].sort((a, b) => a.updated.localeCompare(b.updated));
  $('notes').replaceChildren(...order.map((idea) => noteElement(idea, state.spots.get(idea.number))));
  if (focused) {
    const again = $('notes').querySelector(`[data-number="${focused}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}

function noteElement(idea, spot) {
  const classes = ['note', `note--${idea.color}`];
  if (state.selected.has(idea.number)) classes.push('selected');
  if (state.lineStart === idea.number) classes.push('line-start');
  const el = h('button', {
    type: 'button',
    class: classes.join(' '),
    'data-number': String(idea.number),
    style: `left: ${spot.x}px; top: ${spot.y}px; --tilt: ${tilt(idea.number)}deg`,
    onclick: () => onNoteClick(idea.number, el),
    onpointerdown: (event) => {
      if (state.mode === 'move') startItemDrag(event, idea.number, el);
      else if (state.mode === 'line') startLinkDrag(event, idea.number, el);
    },
    onkeydown: (event) => { if (state.mode === 'move') nudge(event, idea.number, el); },
  },
  h('span', { class: 'pin', 'aria-hidden': 'true' }),
  h('span', { class: 'note-title' }, idea.title),
  idea.text ? h('span', { class: 'note-text' }, idea.text) : null,
  h('span', { class: 'note-meta' },
    h('span', { class: 'note-author' }, idea.author),
    h('span', {}, ago(idea.created)),
    h('span', { class: 'note-comments' }, idea.comments ? plural(idea.comments, 'comment') : 'No comments')));
  return el;
}

function onNoteClick(number, el) {
  if (state.suppressClick) {
    state.suppressClick = false;
    return;
  }
  if (state.mode === 'move') openDetail(number);
  else if (state.mode === 'group') toggleSelected(number, el);
}

function drawTexts() {
  $('texts').replaceChildren(...onTab(state.texts).map((item) => {
    const spot = clampBox(item.x, item.y, 40, 40);
    const el = h('div', {
      class: `text-item pen--${item.color} text--${item.size}`,
      'data-number': String(item.number),
      role: 'button',
      tabindex: '0',
      title: `Written by ${item.author}`,
      style: `left: ${spot.x}px; top: ${spot.y}px`,
      onpointerdown: (event) => { if (state.mode === 'move') startItemDrag(event, item.number, el); },
      onclick: () => onTextClick(item.number),
      onkeydown: (event) => {
        if (state.mode !== 'move') return;
        if (event.key === 'Enter') onTextClick(item.number);
        else nudge(event, item.number, el);
      },
    }, item.text);
    return el;
  }));
}

function onTextClick(number) {
  if (state.suppressClick) {
    state.suppressClick = false;
    return;
  }
  if (state.mode !== 'move') return;
  const item = findItem(number);
  if (!item) return;
  if (!canChange(item.author)) {
    toast(`${item.author} wrote this. You can move it; only they or the admin can change it.`);
    return;
  }
  openTextDialog(item, null);
}

// Groups and lines follow the notes, so they're redrawn from where the notes
// actually are on screen, including mid-drag.
function redrawOverlays() {
  drawGroups();
  drawStrings();
}

function noteElements() {
  return new Map([...$('notes').children].map((el) => [Number(el.dataset.number), el]));
}

function box(el) {
  return { left: el.offsetLeft, top: el.offsetTop, right: el.offsetLeft + el.offsetWidth, bottom: el.offsetTop + el.offsetHeight };
}

function drawGroups() {
  const layer = $('groups');
  const els = noteElements();
  const live = new Set(state.groups.map((group) => group.number));
  const members = new Map();
  for (const idea of ideasIn(state.current)) {
    if (idea.group == null || !live.has(idea.group) || !els.has(idea.number)) continue;
    if (!members.has(idea.group)) members.set(idea.group, []);
    members.get(idea.group).push(els.get(idea.number));
  }
  // Updated in place rather than rebuilt, so a group being dragged by its
  // name keeps hold of the pointer.
  const existing = new Map([...layer.children].map((el) => [el.dataset.group, el]));
  const keep = new Set();
  for (const group of onTab(state.groups)) {
    const list = members.get(group.number);
    if (!list) continue;
    const boxes = list.map(box);
    const left = Math.min(...boxes.map((b) => b.left)) - 24;
    const top = Math.min(...boxes.map((b) => b.top)) - 70;
    const right = Math.max(...boxes.map((b) => b.right)) + 24;
    const bottom = Math.max(...boxes.map((b) => b.bottom)) + 24;
    const key = String(group.number);
    let el = existing.get(key);
    if (!el) {
      el = h('div', { 'data-group': key },
        h('button', {
          type: 'button',
          class: 'group-tag',
          onpointerdown: (event) => startGroupDrag(event, group.number),
          onclick: () => openGroupDialog(group.number),
        }));
      layer.append(el);
    }
    el.className = `group group--${group.color}`;
    el.style.cssText = `left: ${left}px; top: ${top}px; width: ${right - left}px; height: ${bottom - top}px`;
    el.firstChild.textContent = group.name;
    keep.add(key);
  }
  for (const [key, el] of existing) if (!keep.has(key)) el.remove();
}

function pinPoint(el) {
  return { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + 1 };
}

// A line hangs between two pins like a piece of string, sagging a little.
function sagPath(a, b) {
  const sag = Math.min(70, Math.hypot(b.x - a.x, b.y - a.y) * 0.12);
  return `M${a.x} ${a.y} Q${(a.x + b.x) / 2} ${(a.y + b.y) / 2 + sag} ${b.x} ${b.y}`;
}

function drawStrings() {
  const els = noteElements();
  const seen = new Set();
  const lines = [];
  for (const idea of ideasIn(state.current)) {
    for (const { to, color } of idea.links || []) {
      const key = idea.number < to ? `${idea.number}-${to}` : `${to}-${idea.number}`;
      if (seen.has(key) || !els.has(idea.number) || !els.has(to)) continue;
      seen.add(key);
      const d = sagPath(pinPoint(els.get(idea.number)), pinPoint(els.get(to)));
      const hit = svg('path', { d, class: 'string-hit' });
      hit.addEventListener('click', () => openLineDialog(idea.number, to));
      const g = svg('g', { class: `string string--${color}` });
      g.append(svg('path', { d, class: 'string-line' }), hit);
      lines.push(g);
    }
  }
  $('string-lines').replaceChildren(...lines);
}

// ---------------------------------------------------------------- drawings

const strokeCache = new Map();
function parseStroke(line) {
  let stroke = strokeCache.get(line);
  if (stroke) return stroke;
  const [color, width, points] = line.split('|');
  stroke = {
    color,
    width: Number(width),
    points: points.split(' ').map((pair) => {
      const [x, y] = pair.split(',');
      return { x: Number(x), y: Number(y) };
    }),
  };
  if (strokeCache.size > 5000) strokeCache.clear();
  strokeCache.set(line, stroke);
  return stroke;
}

function strokePath(points) {
  if (!points.length) return '';
  const [first] = points;
  if (points.length === 1) return `M${first.x} ${first.y} l0.01 0`;
  let d = `M${first.x} ${first.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const q = points[i + 1];
    d += ` Q${p.x} ${p.y} ${(p.x + q.x) / 2} ${(p.y + q.y) / 2}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x} ${last.y}`;
}

function drawInk() {
  const paths = [];
  for (const sketch of onTab(state.sketches)) {
    for (const line of sketch.strokes) {
      const stroke = parseStroke(line);
      paths.push(svg('path', { d: strokePath(stroke.points), class: `ink-stroke pen--${stroke.color}`, 'stroke-width': stroke.width }));
    }
  }
  $('ink-strokes').replaceChildren(...paths);
  drawRemoteInk();
}

function toWorld(clientX, clientY) {
  const rect = viewportRect();
  const { zoom, x, y } = state.view;
  return {
    x: clamp((clientX - rect.left - x) / zoom, 0, BOARD.width),
    y: clamp((clientY - rect.top - y) / zoom, 0, BOARD.height),
  };
}

function segmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / length2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Ramer-Douglas-Peucker: drops points that don't change the line's shape, so
// a drawing stays small enough to save.
function simplify(points, epsilon) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0;
    let index = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(points[i], points[a], points[b]);
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (max > epsilon) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function newDraft() {
  return {
    number: null,
    tempId: -Date.now(),
    tab: state.current,
    strokes: [],
    saved: '',
    saving: false,
    timer: null,
    created: new Date().toISOString(),
  };
}

function draftItem(draft) {
  return {
    kind: 'sketch',
    number: draft.number ?? draft.tempId,
    tab: draft.tab,
    author: state.session.name,
    strokes: [...draft.strokes],
    created: draft.created,
    updated: draft.created,
  };
}

function startStroke(event) {
  const point = toWorld(event.clientX, event.clientY);
  if (state.eraser) {
    state.erasing = event.pointerId;
    eraseAt(point);
    return;
  }
  const color = state.pen.color;
  const width = PEN_WIDTHS[state.pen.size];
  state.liveStroke = {
    pointerId: event.pointerId,
    points: [point],
    color,
    width,
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    sent: 0,
    sentAt: 0,
  };
  const live = $('ink-live');
  live.setAttribute('class', `ink-stroke pen--${color}`);
  live.setAttribute('stroke-width', width);
  live.setAttribute('d', strokePath([point]));
  live.removeAttribute('hidden');
}

function extendStroke(event) {
  const stroke = state.liveStroke;
  const point = toWorld(event.clientX, event.clientY);
  const last = stroke.points[stroke.points.length - 1];
  if (Math.hypot(point.x - last.x, point.y - last.y) < 1.5) return;
  stroke.points.push(point);
  $('ink-live').setAttribute('d', strokePath(stroke.points));
  // Everyone else watches the line being drawn: new points, ~15 times a second.
  if (Date.now() - stroke.sentAt > 66) sendInk(stroke);
}

function sendInk(stroke) {
  if (!state.live || state.liveStatus !== 'live' || stroke.sent >= stroke.points.length) return;
  if (isPrivateBoard(state.current)) return;
  const points = stroke.points.slice(stroke.sent).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  announce({ t: 'ink', id: stroke.id, tab: state.current, color: stroke.color, width: stroke.width, start: stroke.sent, points });
  stroke.sent = stroke.points.length;
  stroke.sentAt = Date.now();
}

function cancelStroke() {
  const stroke = state.liveStroke;
  state.liveStroke = null;
  $('ink-live').setAttribute('hidden', '');
  if (stroke && stroke.sent) announce({ t: 'ink-cancel', id: stroke.id });
}

function finishStroke() {
  const stroke = state.liveStroke;
  state.liveStroke = null;
  $('ink-live').setAttribute('hidden', '');
  if (!stroke) return;
  const points = simplify(stroke.points, 0.8).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  const line = `${stroke.color}|${stroke.width}|${points.map((p) => `${p.x},${p.y}`).join(' ')}`;
  if (!isPrivateBoard(state.current)) {
    announce({ t: 'ink-done', id: stroke.id, tab: state.current, color: stroke.color, width: stroke.width, line });
  }
  addStroke(line);
}

function addStroke(line) {
  let draft = state.draft;
  if (draft && draft.tab !== state.current) {
    flushDraft();
    draft = null;
  }
  if (draft && draft.strokes.join('\n').length + line.length + 1 > SKETCH_LIMIT) {
    flushDraft();
    draft = null;
  }
  if (!draft) {
    draft = newDraft();
    state.draft = draft;
  }
  draft.strokes.push(line);
  upsertLocal(draftItem(draft));
  drawInk();
  scheduleDraftSave(draft);
  renderToolBar();
}

function scheduleDraftSave(draft, delay = 700) {
  clearTimeout(draft.timer);
  draft.timer = setTimeout(() => saveDraft(draft), delay);
}

function flushDraft() {
  if (state.draft) {
    clearTimeout(state.draft.timer);
    saveDraft(state.draft);
  }
}

// Each person's drawing session is one issue, rewritten as strokes are added
// or erased. One write at a time; anything drawn meanwhile goes in the next.
async function saveDraft(draft) {
  if (draft.saving) {
    scheduleDraftSave(draft, 400);
    return;
  }
  const strokes = [...draft.strokes];
  const body = strokes.join('\n');
  draft.saving = true;
  try {
    if (draft.number == null) {
      if (strokes.length) {
        const item = await state.store.createItem({ kind: 'sketch', tab: draft.tab, author: state.session.name, strokes });
        const temp = draft.tempId;
        draft.number = item.number;
        draft.saved = body;
        setItems(state.items.map((other) => (other.number === temp ? draftItem(draft) : other)));
      }
    } else if (body !== draft.saved && strokes.length) {
      await state.store.updateItem(draftItem(draft), { strokes });
      draft.saved = body;
    } else if (!strokes.length) {
      // Everything erased: close it, and let anything drawn next start a new one.
      await state.store.removeItem(draft.number);
      draft.number = null;
      draft.tempId = -Date.now();
      draft.saved = '';
    }
  } catch (error) {
    toast(`Your drawing wasn't saved. ${error.message}`, true);
  } finally {
    draft.saving = false;
  }
  const changed = strokes.length !== draft.strokes.length || strokes.some((line, i) => line !== draft.strokes[i]);
  if (changed) {
    scheduleDraftSave(draft, 300);
  } else if (state.draft === draft && state.mode !== 'draw') {
    // Saved and finished with: from now on the server's copy is the truth.
    state.draft = null;
    refreshItems();
  }
}

function eraseAt(point) {
  const reach = 10 / state.view.zoom;
  for (const sketch of onTab(state.sketches)) {
    if (!canChange(sketch.author)) continue;
    for (const line of sketch.strokes) {
      const stroke = parseStroke(line);
      const near = stroke.points.length === 1
        ? Math.hypot(point.x - stroke.points[0].x, point.y - stroke.points[0].y) < reach + stroke.width / 2
        : stroke.points.some((p, i) => i > 0 && segmentDistance(point, stroke.points[i - 1], p) < reach + stroke.width / 2);
      if (near) eraseStroke(sketch, line);
    }
  }
}

function eraseStroke(sketch, line) {
  const draft = state.draft;
  if (draft && (sketch.number === draft.number || sketch.number === draft.tempId)) {
    draft.strokes = draft.strokes.filter((s) => s !== line);
    upsertLocal(draftItem(draft));
    if (!draft.strokes.length) setItems(state.items.filter((item) => item.number !== sketch.number));
    scheduleDraftSave(draft);
  } else {
    // Read the current copy: an earlier stroke in the same sweep may already be gone.
    const current = findItem(sketch.number) || sketch;
    const rest = current.strokes.filter((s) => s !== line);
    if (rest.length) patchLocal(sketch.number, { strokes: rest });
    else setItems(state.items.filter((item) => item.number !== sketch.number));
    state.store.eraseStroke(sketch.number, line)
      .catch((error) => toast(`That couldn't be erased. ${error.message}`, true))
      .finally(refreshItems);
  }
  drawInk();
  renderToolBar();
}

function undoStroke() {
  const draft = state.draft;
  if (!draft || !draft.strokes.length) return;
  draft.strokes = draft.strokes.slice(0, -1);
  if (draft.strokes.length) upsertLocal(draftItem(draft));
  else setItems(state.items.filter((item) => item.number !== (draft.number ?? draft.tempId)));
  drawInk();
  scheduleDraftSave(draft);
  renderToolBar();
}

function setPen(changes) {
  state.pen = { ...state.pen, ...changes };
  state.eraser = false;
  writeStorage('localStorage', KEYS.pen, state.pen);
  renderToolBar();
}

// ---------------------------------------------------------------- moving things

function startItemDrag(event, number, el) {
  if (event.button !== 0 || state.drag || state.pointers.size) return;
  closeMenu();
  state.drag = {
    kind: 'item',
    number,
    el,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    from: { x: parseFloat(el.style.left), y: parseFloat(el.style.top) },
    moved: false,
    spot: null,
  };
  el.setPointerCapture(event.pointerId);
  el.addEventListener('pointermove', moveItemDrag);
  el.addEventListener('pointerup', endItemDrag);
  el.addEventListener('pointercancel', endItemDrag);
}

function moveItemDrag(event) {
  const drag = state.drag;
  if (!drag || drag.kind !== 'item' || event.pointerId !== drag.pointerId) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  // A few pixels of wobble is still a click.
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    drag.el.classList.add('dragging');
  }
  const { zoom } = state.view;
  drag.spot = clampBox(drag.from.x + dx / zoom, drag.from.y + dy / zoom, drag.el.offsetWidth, drag.el.offsetHeight);
  drag.el.style.left = `${drag.spot.x}px`;
  drag.el.style.top = `${drag.spot.y}px`;
  redrawOverlays();
  liveMoves([{ number: drag.number, ...drag.spot }]);
}

function endItemDrag(event) {
  const drag = state.drag;
  if (!drag || drag.kind !== 'item' || event.pointerId !== drag.pointerId) return;
  const { el } = drag;
  el.removeEventListener('pointermove', moveItemDrag);
  el.removeEventListener('pointerup', endItemDrag);
  el.removeEventListener('pointercancel', endItemDrag);
  el.classList.remove('dragging');
  state.drag = null;
  if (drag.moved && drag.spot) {
    // The click that follows a drag must not open the thing that was dragged.
    state.suppressClick = true;
    setTimeout(() => { state.suppressClick = false; }, 0);
    queueMove(drag.number, drag.spot);
  }
  if (state.staleBoard) {
    state.staleBoard = false;
    renderBoard();
  }
}

function nudge(event, number, el) {
  const steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const step = steps[event.key];
  if (!step) return;
  event.preventDefault();
  const distance = event.shiftKey ? 60 : 12;
  const spot = clampBox(
    parseFloat(el.style.left) + step[0] * distance,
    parseFloat(el.style.top) + step[1] * distance,
    el.offsetWidth,
    el.offsetHeight,
  );
  el.style.left = `${spot.x}px`;
  el.style.top = `${spot.y}px`;
  queueMove(number, spot);
  redrawOverlays();
  liveMoves([{ number, ...spot }]);
  revealElement(el);
}

// Saves a new spot once the thing has stopped moving, one write at a time
// per item, so a burst of drags or arrow presses becomes a single edit.
function queueMove(number, spot) {
  patchLocal(number, { x: spot.x, y: spot.y });
  const entry = state.moves.get(number) || { spot, timer: null, saving: false };
  entry.spot = spot;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => saveMove(number), 450);
  state.moves.set(number, entry);
}

async function saveMove(number) {
  const entry = state.moves.get(number);
  if (!entry) return;
  if (entry.saving) {
    entry.timer = setTimeout(() => saveMove(number), 300);
    return;
  }
  if (!findItem(number)) {
    state.moves.delete(number);
    return;
  }
  const { spot } = entry;
  entry.saving = true;
  try {
    await state.store.moveItem(number, spot.x, spot.y);
  } catch (error) {
    toast(`That new position wasn't saved. ${error.message}`, true);
  }
  entry.saving = false;
  if (entry.spot === spot) {
    state.moves.delete(number);
    refreshItems();
  }
}

// ---------------------------------------------------------------- connecting ideas

function startLinkDrag(event, number, el) {
  if (event.button !== 0 || state.drag || state.pointers.size) return;
  state.drag = { kind: 'link', number, el, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
  el.setPointerCapture(event.pointerId);
  el.addEventListener('pointermove', moveLinkDrag);
  el.addEventListener('pointerup', endLinkDrag);
  el.addEventListener('pointercancel', endLinkDrag);
}

function moveLinkDrag(event) {
  const drag = state.drag;
  if (!drag || drag.kind !== 'link' || event.pointerId !== drag.pointerId) return;
  if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
  drag.moved = true;
  const band = $('string-band');
  band.setAttribute('d', sagPath(pinPoint(drag.el), toWorld(event.clientX, event.clientY)));
  band.removeAttribute('hidden');
}

function endLinkDrag(event) {
  const drag = state.drag;
  if (!drag || drag.kind !== 'link' || event.pointerId !== drag.pointerId) return;
  const { el } = drag;
  el.removeEventListener('pointermove', moveLinkDrag);
  el.removeEventListener('pointerup', endLinkDrag);
  el.removeEventListener('pointercancel', endLinkDrag);
  $('string-band').setAttribute('hidden', '');
  state.drag = null;
  state.suppressClick = true;
  setTimeout(() => { state.suppressClick = false; }, 0);
  if (event.type === 'pointerup') {
    if (drag.moved) {
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const target = hit && hit.closest('.note');
      const to = target ? Number(target.dataset.number) : null;
      if (to != null && to !== drag.number) connect(drag.number, to);
    } else if (state.lineStart == null) {
      // Tap one idea, then another: the same thing without dragging.
      state.lineStart = drag.number;
      el.classList.add('line-start');
      renderToolBar();
    } else {
      const from = state.lineStart;
      state.lineStart = null;
      for (const note of $('notes').children) note.classList.remove('line-start');
      renderToolBar();
      if (from !== drag.number) connect(from, drag.number);
    }
  }
  if (state.staleBoard) {
    state.staleBoard = false;
    renderBoard();
  }
}

function linkBetween(a, b) {
  const one = findItem(a);
  const two = findItem(b);
  return (one && one.links.find((link) => link.to === b)) || (two && two.links.find((link) => link.to === a)) || null;
}

async function connect(from, to) {
  const a = findItem(from);
  if (!a || !findItem(to)) return;
  if (linkBetween(from, to)) {
    toast('Those two ideas are already connected.');
    return;
  }
  const color = state.stringColor;
  patchLocal(from, { links: [...a.links, { to, color }] });
  drawStrings();
  try {
    await state.store.addLink(from, to, color);
  } catch (error) {
    toast(`That line wasn't saved. ${error.message}`, true);
  }
  refreshItems();
}

function openLineDialog(a, b) {
  if (state.mode !== 'move' && state.mode !== 'line') return;
  const link = linkBetween(a, b);
  if (!link) return;
  const one = findItem(a);
  const two = findItem(b);
  state.editingLine = { a, b };
  $('line-between').textContent = one && two ? `Between "${one.title}" and "${two.title}".` : '';
  $(`line-color-${link.color}`).checked = true;
  $('line-dialog').showModal();
}

async function recolourLine(color) {
  const line = state.editingLine;
  if (!line) return;
  const { a, b } = line;
  for (const [from, to] of [[a, b], [b, a]]) {
    const idea = findItem(from);
    if (idea && idea.links.some((link) => link.to === to)) {
      patchLocal(from, { links: idea.links.map((link) => (link.to === to ? { ...link, color } : link)) });
    }
  }
  drawStrings();
  try {
    await state.store.setLinkColor(a, b, color);
  } catch (error) {
    toast(`The new colour wasn't saved. ${error.message}`, true);
  }
  refreshItems();
}

async function removeLine() {
  const line = state.editingLine;
  if (!line) return;
  const { a, b } = line;
  $('line-dialog').close();
  for (const [from, to] of [[a, b], [b, a]]) {
    const idea = findItem(from);
    if (idea) patchLocal(from, { links: idea.links.filter((link) => link.to !== to) });
  }
  drawStrings();
  toast('Line removed.');
  try {
    await state.store.removeLink(a, b);
  } catch (error) {
    toast(`That line wasn't removed. ${error.message}`, true);
  }
  refreshItems();
}

function setStringColor(color) {
  state.stringColor = color;
  writeStorage('localStorage', KEYS.string, color);
  renderToolBar();
}

// ---------------------------------------------------------------- downloads

function fileStamp() {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
}

function fileSlug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'board';
}

function saveFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function toggleDownloadMenu(open) {
  const menu = $('download-menu');
  const show = open ?? menu.hidden;
  menu.hidden = !show;
  $('download-btn').setAttribute('aria-expanded', show ? 'true' : 'false');
  if (show) $('download-png').focus({ preventScroll: true });
}

async function downloadPicture() {
  toggleDownloadMenu(false);
  const tab = currentTab();
  if (!tab) return;
  try {
    const canvas = await renderView({ viewport: $('viewport'), world: $('world'), view: state.view, board: BOARD });
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('The browser could not encode it.'))), 'image/png');
    });
    saveFile(blob, `fedi-boards-${fileSlug(tab.name)}-${fileStamp()}.png`);
    toast(`Saved a ${canvas.width} x ${canvas.height} picture of this view.`);
  } catch (error) {
    toast(`The picture couldn't be made. ${error.message}`, true);
  }
}

// jsPDF is ours, served from /vendor, and only fetched the first time
// somebody asks for a PDF.
let jsPdfLoading = null;
function loadJsPdf() {
  if (window.jspdf) return Promise.resolve(window.jspdf.jsPDF);
  jsPdfLoading = jsPdfLoading || new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/jspdf.umd.min.js';
    script.onload = () => (window.jspdf ? resolve(window.jspdf.jsPDF) : reject(new Error('The PDF maker did not start.')));
    script.onerror = () => {
      jsPdfLoading = null;
      script.remove();
      reject(new Error('The PDF maker could not be loaded. Check your connection.'));
    };
    document.head.append(script);
  });
  return jsPdfLoading;
}

async function downloadNotes() {
  toggleDownloadMenu(false);
  const button = $('download-btn');
  if (button.getAttribute('aria-busy') === 'true') return;
  const label = button.textContent;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Preparing...';
  try {
    const jsPDF = await loadJsPdf();
    // Every idea's thread, a few at a time.
    const ideas = [...state.ideas];
    const comments = new Map();
    const queue = [...ideas];
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        const idea = queue.shift();
        comments.set(idea.number, await state.store.listComments(idea.number));
        done++;
        button.textContent = `Comments ${done} of ${ideas.length}`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, ideas.length) }, worker));
    const doc = buildNotesPdf(jsPDF, {
      tabs: state.tabs,
      ideas,
      groups: state.groups,
      texts: state.texts,
      sketches: state.sketches,
      comments,
      tabOf,
      exportedBy: state.session.name,
    });
    saveFile(doc.output('blob'), `fedi-boards-notes-${fileStamp()}.pdf`);
    toast('Saved every note and comment as a PDF.');
  } catch (error) {
    toast(`The PDF couldn't be made. ${error.message}`, true);
  } finally {
    button.removeAttribute('aria-busy');
    button.textContent = label;
  }
}

// ---------------------------------------------------------------- groups

function toggleSelected(number, el) {
  if (state.selected.has(number)) state.selected.delete(number);
  else state.selected.add(number);
  el.classList.toggle('selected', state.selected.has(number));
  renderToolBar();
  if (state.selected.size === 1) $('group-name').focus({ preventScroll: true });
}

async function makeGroup(event) {
  event.preventDefault();
  const name = $('group-name').value.trim().replace(/\s+/g, ' ');
  const numbers = [...state.selected];
  if (!numbers.length) {
    toast('Click the ideas you want in the group first.', true);
    return;
  }
  if (!name) {
    toast('Give the group a name.', true);
    $('group-name').focus();
    return;
  }
  await busy($('group-create'), 'Grouping...', async () => {
    try {
      const color = GROUP_COLORS[onTab(state.groups).length % GROUP_COLORS.length];
      const group = await state.store.createItem({ kind: 'group', name, tab: state.current, color });
      upsertLocal(group);
      for (const number of numbers) patchLocal(number, { group: group.number });
      $('group-name').value = '';
      setMode('move');
      await Promise.all(numbers.map((number) => state.store.setGroup(number, group.number)));
      toast(`Grouped ${plural(numbers.length, 'idea')} as ${name}.`);
    } catch (error) {
      toast(`The group wasn't saved. ${error.message}`, true);
    }
    refreshItems();
  });
}

function startGroupDrag(event, number) {
  if (event.button !== 0 || state.mode !== 'move' || state.drag || state.pointers.size) return;
  const members = [...$('notes').children]
    .filter((el) => {
      const idea = findItem(Number(el.dataset.number));
      return idea && idea.group === number;
    })
    .map((el) => ({ el, number: Number(el.dataset.number), x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
  if (!members.length) return;
  closeMenu();
  const tag = event.currentTarget;
  state.drag = {
    kind: 'group',
    tag,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    members,
    dx: 0,
    dy: 0,
    // The whole group moves as one, and stops when any part of it reaches the edge.
    limits: {
      left: -Math.min(...members.map((m) => m.x)),
      top: -Math.min(...members.map((m) => m.y)),
      right: BOARD.width - Math.max(...members.map((m) => m.x + m.el.offsetWidth)),
      bottom: BOARD.height - Math.max(...members.map((m) => m.y + m.el.offsetHeight)),
    },
  };
  tag.setPointerCapture(event.pointerId);
  tag.addEventListener('pointermove', moveGroupDrag);
  tag.addEventListener('pointerup', endGroupDrag);
  tag.addEventListener('pointercancel', endGroupDrag);
}

function moveGroupDrag(event) {
  const drag = state.drag;
  if (!drag || drag.kind !== 'group' || event.pointerId !== drag.pointerId) return;
  const sx = event.clientX - drag.startX;
  const sy = event.clientY - drag.startY;
  if (!drag.moved) {
    if (Math.hypot(sx, sy) < 5) return;
    drag.moved = true;
  }
  const { zoom } = state.view;
  drag.dx = Math.round(clamp(sx / zoom, drag.limits.left, drag.limits.right));
  drag.dy = Math.round(clamp(sy / zoom, drag.limits.top, drag.limits.bottom));
  for (const member of drag.members) {
    member.el.style.left = `${member.x + drag.dx}px`;
    member.el.style.top = `${member.y + drag.dy}px`;
  }
  redrawOverlays();
  liveMoves(drag.members.map((member) => ({ number: member.number, x: member.x + drag.dx, y: member.y + drag.dy })));
}

function endGroupDrag(event) {
  const drag = state.drag;
  if (!drag || drag.kind !== 'group' || event.pointerId !== drag.pointerId) return;
  drag.tag.removeEventListener('pointermove', moveGroupDrag);
  drag.tag.removeEventListener('pointerup', endGroupDrag);
  drag.tag.removeEventListener('pointercancel', endGroupDrag);
  state.drag = null;
  if (drag.moved) {
    state.suppressClick = true;
    setTimeout(() => { state.suppressClick = false; }, 0);
    for (const member of drag.members) queueMove(member.number, { x: member.x + drag.dx, y: member.y + drag.dy });
  }
  if (state.staleBoard) {
    state.staleBoard = false;
    renderBoard();
  }
}

function openGroupDialog(number) {
  if (state.suppressClick) {
    state.suppressClick = false;
    return;
  }
  if (state.mode !== 'move') return;
  const group = findItem(number);
  if (!group) return;
  state.editingGroup = number;
  $('group-rename').value = group.name;
  $('group-error').hidden = true;
  $('group-dialog').showModal();
  $('group-rename').focus();
}

async function renameGroup(event) {
  event.preventDefault();
  const group = findItem(state.editingGroup);
  const name = $('group-rename').value.trim().replace(/\s+/g, ' ');
  if (!group) return;
  if (!name) {
    showError('group-error', 'Give the group a name.');
    return;
  }
  await busy($('group-save'), 'Saving...', async () => {
    try {
      upsertLocal(await state.store.patchItem(group.number, { name }));
    } catch (error) {
      showError('group-error', error.message);
      return;
    }
    $('group-dialog').close();
    drawGroups();
    toast('Group renamed.');
  });
}

async function ungroup() {
  const group = findItem(state.editingGroup);
  if (!group) return;
  const ok = await confirmAction({
    title: `Ungroup ${group.name}?`,
    body: 'The outline goes away. The ideas stay exactly where they are.',
    action: 'Ungroup',
  });
  if (!ok) return;
  try {
    await state.store.removeItem(group.number);
  } catch (error) {
    toast(error.message, true);
    return;
  }
  setItems(state.items.filter((item) => item.number !== group.number));
  $('group-dialog').close();
  drawGroups();
  toast('Ungrouped.');
  refreshItems();
}

async function changeGroup(number, group) {
  patchLocal(number, { group });
  redrawOverlays();
  try {
    await state.store.setGroup(number, group);
  } catch (error) {
    toast(`That wasn't saved. ${error.message}`, true);
  }
  refreshItems();
}

// ---------------------------------------------------------------- modes and the tool bar

function setMode(mode) {
  if (state.mode === 'draw' && mode !== 'draw') {
    cancelStroke();
    flushDraft();
  }
  state.mode = mode;
  state.selected.clear();
  state.lineStart = null;
  state.eraser = false;
  closeMenu();
  for (const button of document.querySelectorAll('.mode')) {
    button.setAttribute('aria-pressed', button.dataset.mode === mode ? 'true' : 'false');
  }
  const viewport = $('viewport');
  viewport.classList.remove('mode-move', 'mode-line', 'mode-group', 'mode-draw');
  viewport.classList.add(`mode-${mode}`);
  for (const note of $('notes').children) note.classList.remove('selected', 'line-start');
  renderToolBar();
  if (state.session) renderBoard();
}

function renderToolBar() {
  const { mode } = state;
  $('tool-bar').hidden = mode === 'move';
  $('group-form').hidden = mode !== 'group';
  $('pen-tools').hidden = mode !== 'draw';
  $('line-tools').hidden = mode !== 'line';
  for (const button of document.querySelectorAll('[data-string]')) {
    button.setAttribute('aria-pressed', button.dataset.string === state.stringColor ? 'true' : 'false');
  }
  let text = '';
  if (mode === 'line') {
    text = state.lineStart != null
      ? 'Now click the idea to connect it to.'
      : 'Drag from one idea to another to connect them. Click a line to remove it.';
  } else if (mode === 'group') {
    text = state.selected.size ? `${plural(state.selected.size, 'idea')} chosen. Name the group:` : 'Click the ideas you want to group.';
  } else if (mode === 'draw') {
    text = state.eraser ? 'Drag over your drawing to erase it.' : 'Draw anywhere. Everyone on the board sees it.';
  }
  $('tool-text').textContent = text;
  $('group-create').disabled = !state.selected.size;
  for (const button of document.querySelectorAll('.pen-swatch')) {
    button.setAttribute('aria-pressed', !state.eraser && button.dataset.pen === state.pen.color ? 'true' : 'false');
  }
  for (const button of document.querySelectorAll('.pen-size')) {
    button.setAttribute('aria-pressed', button.dataset.size === state.pen.size ? 'true' : 'false');
  }
  $('pen-eraser').setAttribute('aria-pressed', state.eraser ? 'true' : 'false');
  $('pen-undo').disabled = !(state.draft && state.draft.strokes.length);
}

// ---------------------------------------------------------------- the double-click menu

function openMenu(clientX, clientY) {
  if (!currentTab() || state.mode !== 'move') return;
  state.menuSpot = toWorld(clientX, clientY);
  const menu = $('board-menu');
  const rect = viewportRect();
  menu.hidden = false;
  const left = clamp(clientX - rect.left, 8, rect.width - menu.offsetWidth - 8);
  const top = clamp(clientY - rect.top, 8, rect.height - menu.offsetHeight - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  $('menu-idea').focus({ preventScroll: true });
}

function closeMenu() {
  $('board-menu').hidden = true;
}

function menuAction(action) {
  const spot = state.menuSpot;
  closeMenu();
  if (action === 'idea') {
    state.newSpot = clampBox(spot.x - NOTE.width / 2, spot.y - 24, NOTE.width, NOTE.height);
    openIdeaDialog(null);
  } else if (action === 'text') {
    openTextDialog(null, spot);
  } else if (action === 'draw') {
    setMode('draw');
  }
}

// ---------------------------------------------------------------- zoom and pan

function viewportRect() {
  return $('viewport').getBoundingClientRect();
}

// Keeps the board in view: on an axis where the whole board fits it is
// centred, otherwise its edges can only be pulled PAN_SLACK past the screen's.
function clampView(view) {
  const rect = viewportRect();
  if (!rect.width || !rect.height) return view;
  view.zoom = clamp(view.zoom, ZOOM.min, ZOOM.max);
  const fit = (offset, size, room) => (size + PAN_SLACK * 2 <= room
    ? (room - size) / 2
    : clamp(offset, room - size - PAN_SLACK, PAN_SLACK));
  view.x = fit(view.x, BOARD.width * view.zoom, rect.width);
  view.y = fit(view.y, BOARD.height * view.zoom, rect.height);
  return view;
}

let viewSaveTimer = null;
function applyView() {
  const { zoom, x, y } = clampView(state.view);
  $('world').style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  $('zoom-level').textContent = `${Math.round(zoom * 100)}%`;
  $('zoom-out').disabled = zoom <= ZOOM.min + 0.001;
  $('zoom-in').disabled = zoom >= ZOOM.max - 0.001;
  if (state.current) {
    state.views[state.current] = { zoom: Math.round(zoom * 1000) / 1000, x: Math.round(x), y: Math.round(y) };
    clearTimeout(viewSaveTimer);
    viewSaveTimer = setTimeout(() => writeStorage('localStorage', KEYS.views, state.views), 400);
  }
}

// Zooms by `factor` keeping the board point under (cx, cy) where it is.
function zoomAt(factor, cx, cy) {
  const view = state.view;
  const zoom = clamp(view.zoom * factor, ZOOM.min, ZOOM.max);
  if (zoom === view.zoom) return;
  view.x = cx - ((cx - view.x) / view.zoom) * zoom;
  view.y = cy - ((cy - view.y) / view.zoom) * zoom;
  view.zoom = zoom;
  applyView();
}

function zoomFromCentre(factor) {
  const rect = viewportRect();
  zoomAt(factor, rect.width / 2, rect.height / 2);
}

function frame(area, maxZoom) {
  const rect = viewportRect();
  if (!rect.width) return;
  const zoom = clamp(Math.min((rect.width - 48) / area.width, (rect.height - 48) / area.height), ZOOM.min, maxZoom);
  state.view = {
    zoom,
    x: rect.width / 2 - (area.x + area.width / 2) * zoom,
    y: rect.height / 2 - (area.y + area.height / 2) * zoom,
  };
  applyView();
}

function fitBoard() {
  frame({ x: 0, y: 0, width: BOARD.width, height: BOARD.height }, ZOOM.max);
}

function fitContent() {
  const spots = [...state.spots.values(), ...onTab(state.texts).map((t) => ({ x: t.x, y: t.y }))];
  if (!spots.length) {
    state.view = { zoom: 1, x: 32, y: 32 };
    applyView();
    return;
  }
  const left = Math.min(...spots.map((s) => s.x));
  const top = Math.min(...spots.map((s) => s.y));
  const right = Math.max(...spots.map((s) => s.x)) + NOTE.width;
  const bottom = Math.max(...spots.map((s) => s.y)) + NOTE.height + 40;
  frame({ x: left - 40, y: top - 80, width: right - left + 80, height: bottom - top + 120 }, 1);
}

// Each person's zoom and position is remembered per tab, in their browser.
function restoreView() {
  const saved = state.current ? state.views[state.current] : null;
  if (saved && [saved.zoom, saved.x, saved.y].every(Number.isFinite)) {
    state.view = { zoom: saved.zoom, x: saved.x, y: saved.y };
    applyView();
  } else {
    fitContent();
  }
}

// Where a new note should appear: the free spot nearest the middle of the
// screen. The search spirals out from a random angle, so several people
// posting at the same moment (who can't yet see each other's notes) spread
// out instead of landing in one pile.
function centreSpot() {
  const rect = viewportRect();
  const { zoom, x, y } = state.view;
  const cx = (rect.width / 2 - x) / zoom - NOTE.width / 2;
  const cy = (rect.height / 2 - y) / zoom - NOTE.height / 2;
  const taken = [...state.spots.values()];
  // Each person heads off in their own direction (from their name), so two
  // people posting in the same instant land apart.
  const own = [...state.session.name.toLowerCase()].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 3600, 7) / 3600;
  const turn = own * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
  for (let ring = 0; ring < 14; ring++) {
    const steps = ring === 0 ? 1 : ring * 8;
    for (let k = 0; k < steps; k++) {
      const angle = turn + (k / steps) * Math.PI * 2;
      const reach = ring === 0 ? 170 : 170 + ring * 80;
      const spot = clampBox(cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach * 0.8, NOTE.width, NOTE.height);
      if (!taken.some((other) => overlaps(other, spot))) return spot;
    }
  }
  return clampBox(cx + (Math.random() - 0.5) * 120, cy + (Math.random() - 0.5) * 120, NOTE.width, NOTE.height);
}

function revealElement(el) {
  const rect = viewportRect();
  const area = el.getBoundingClientRect();
  let dx = 0;
  let dy = 0;
  if (area.left < rect.left + 16) dx = rect.left + 16 - area.left;
  else if (area.right > rect.right - 16) dx = rect.right - 16 - area.right;
  if (area.top < rect.top + 16) dy = rect.top + 16 - area.top;
  else if (area.bottom > rect.bottom - 16) dy = rect.bottom - 16 - area.bottom;
  if (dx || dy) {
    state.view.x += dx;
    state.view.y += dy;
    applyView();
  }
}

function onWheel(event) {
  event.preventDefault();
  if (state.drag || state.liveStroke) return;
  closeMenu();
  const rect = viewportRect();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
  // A trackpad pinch arrives as ctrl+wheel with small deltas.
  const speed = event.ctrlKey ? 0.01 : 0.0015;
  zoomAt(Math.exp(-event.deltaY * unit * speed), event.clientX - rect.left, event.clientY - rect.top);
}

function gesture() {
  const points = [...state.pointers.values()];
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  const spread = points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
  return { cx, cy, spread, count: points.length };
}

const BOARD_THINGS = '.note, .empty, .text-item, .group-tag, .string-hit, .tool-bar, .board-menu';

function onBoardPointerDown(event) {
  // In draw mode the pen goes over everything on the board; otherwise the
  // things on it handle their own presses.
  const skip = state.mode === 'draw' ? '.empty, .tool-bar, .board-menu' : BOARD_THINGS;
  if (event.target.closest(skip)) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  closeMenu();
  $('viewport').setPointerCapture(event.pointerId);
  state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (state.mode === 'draw' && state.pointers.size === 1) {
    startStroke(event);
    return;
  }
  // A second finger turns a stroke into a pinch.
  if (state.liveStroke) cancelStroke();
  state.erasing = null;
  state.gesture = gesture();
  state.panStart = { x: event.clientX, y: event.clientY, moved: false };
  $('viewport').classList.add('panning');
}

function onBoardPointerMove(event) {
  if (!state.pointers.has(event.pointerId)) return;
  state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (state.liveStroke && state.liveStroke.pointerId === event.pointerId) {
    extendStroke(event);
    return;
  }
  if (state.erasing === event.pointerId) {
    eraseAt(toWorld(event.clientX, event.clientY));
    return;
  }
  const now = gesture();
  const before = state.gesture;
  state.gesture = now;
  if (state.panStart && Math.hypot(event.clientX - state.panStart.x, event.clientY - state.panStart.y) > 4) {
    state.panStart.moved = true;
  }
  if (!before || before.count !== now.count) return;
  state.view.x += now.cx - before.cx;
  state.view.y += now.cy - before.cy;
  if (now.count > 1 && before.spread > 0) {
    const rect = viewportRect();
    zoomAt(now.spread / before.spread, now.cx - rect.left, now.cy - rect.top);
  }
  applyView();
}

function onBoardPointerUp(event) {
  if (!state.pointers.delete(event.pointerId)) return;
  if (state.liveStroke && state.liveStroke.pointerId === event.pointerId) {
    if (event.type === 'pointerup') finishStroke();
    else cancelStroke();
    return;
  }
  if (state.erasing === event.pointerId) {
    state.erasing = null;
    return;
  }
  state.gesture = state.pointers.size ? gesture() : null;
  if (state.pointers.size) return;
  $('viewport').classList.remove('panning');
  const start = state.panStart;
  state.panStart = null;
  // Two quick taps on empty board (a double-click with a mouse) open the menu.
  if (event.type !== 'pointerup' || !start || start.moved || state.mode !== 'move') return;
  const now = Date.now();
  const last = state.lastTap;
  if (last && now - last.time < DOUBLE_TAP.ms && Math.hypot(event.clientX - last.x, event.clientY - last.y) < DOUBLE_TAP.px) {
    state.lastTap = null;
    openMenu(event.clientX, event.clientY);
  } else {
    state.lastTap = { time: now, x: event.clientX, y: event.clientY };
  }
}

// ---------------------------------------------------------------- ideas

function openIdeaDialog(idea) {
  state.editing = idea;
  $('idea-dialog-title').textContent = idea ? 'Edit idea' : 'New idea';
  $('idea-submit').textContent = idea ? 'Save changes' : 'Pin idea';
  $('idea-title').value = idea ? idea.title : '';
  $('idea-text').value = idea ? idea.text : '';
  const select = $('idea-tab');
  select.replaceChildren(...state.tabs.map((tab) => h('option', { value: tab.id }, tab.name)));
  select.value = idea ? tabOf(idea) : state.current;
  const color = idea ? idea.color : COLORS[Math.floor(Math.random() * COLORS.length)];
  $(`color-${color}`).checked = true;
  $('idea-error').hidden = true;
  $('idea-dialog').showModal();
  $('idea-title').focus();
}

async function saveIdea(event) {
  event.preventDefault();
  $('idea-error').hidden = true;
  const title = $('idea-title').value.trim();
  const text = $('idea-text').value.trim();
  const tab = $('idea-tab').value;
  const checked = document.querySelector('input[name="idea-color"]:checked');
  const color = checked ? checked.value : 'yellow';
  if (!title) {
    showError('idea-error', 'Give the idea a short title.');
    return;
  }
  const editing = state.editing;
  await busy($('idea-submit'), editing ? 'Saving...' : 'Pinning...', async () => {
    try {
      if (editing) {
        const changes = { title, text, tab, color };
        // An idea moved to another tab finds a free spot there and leaves its group behind.
        if (tab !== tabOf(editing)) Object.assign(changes, { x: null, y: null, group: null });
        upsertLocal(await state.store.updateIdea(editing, changes));
      } else {
        // A new note appears where it was asked for, or in the middle of the screen.
        const spot = tab === state.current ? (state.newSpot || centreSpot()) : { x: null, y: null };
        upsertLocal(await state.store.createIdea({ title, text, tab, color, author: state.session.name, ...spot }));
      }
    } catch (error) {
      showError('idea-error', error.message);
      return;
    }
    $('idea-dialog').close();
    if (tab !== state.current) chooseTab(tab);
    else renderAll();
    if (state.detail != null) renderDetail();
    toast(editing ? 'Idea updated.' : 'Idea pinned.');
    refreshItems();
  });
}

async function removeIdea(idea) {
  const ok = await confirmAction({
    title: 'Remove this idea?',
    body: `"${idea.title}" and its comments come off the board for everyone.`,
    action: 'Remove idea',
  });
  if (!ok) return;
  try {
    await state.store.removeIdea(idea.number);
  } catch (error) {
    toast(error.message, true);
    return;
  }
  setItems(state.items.filter((item) => item.number !== idea.number));
  $('detail').close();
  renderAll();
  toast('Idea removed.');
  refreshItems();
}

// ---------------------------------------------------------------- text on the board

function openTextDialog(item, spot) {
  state.editingText = item;
  state.textSpot = spot;
  $('text-dialog-title').textContent = item ? 'Change the text' : 'Write on the board';
  $('text-submit').textContent = item ? 'Save' : 'Write it';
  $('text-delete').hidden = !item;
  $('text-body').value = item ? item.text : '';
  const color = item ? item.color : state.pen.color;
  $(`text-color-${color}`).checked = true;
  $('text-size').value = item ? item.size : 'm';
  syncTextPreview();
  $('text-error').hidden = true;
  $('text-dialog').showModal();
  $('text-body').focus();
}

function syncTextPreview() {
  const checked = document.querySelector('input[name="text-color"]:checked');
  $('text-body').className = `handwriting-input pen--${checked ? checked.value : 'ink'}`;
}

async function saveText(event) {
  event.preventDefault();
  $('text-error').hidden = true;
  const text = $('text-body').value.trim();
  const checked = document.querySelector('input[name="text-color"]:checked');
  const color = checked ? checked.value : 'ink';
  const size = $('text-size').value;
  if (!text) {
    showError('text-error', 'Write something first.');
    return;
  }
  const item = state.editingText;
  await busy($('text-submit'), 'Saving...', async () => {
    try {
      if (item) {
        upsertLocal(await state.store.patchItem(item.number, { text, color, size }));
      } else {
        const spot = state.textSpot || centreSpot();
        const at = clampBox(spot.x - 10, spot.y - 30, 40, 40);
        upsertLocal(await state.store.createItem({ kind: 'text', tab: state.current, author: state.session.name, text, color, size, ...at }));
      }
    } catch (error) {
      showError('text-error', error.message);
      return;
    }
    $('text-dialog').close();
    drawTexts();
    renderBoard();
    refreshItems();
  });
}

async function eraseText() {
  const item = state.editingText;
  if (!item) return;
  const ok = await confirmAction({ title: 'Erase this text?', body: 'It comes off the board for everyone.', action: 'Erase' });
  if (!ok) return;
  try {
    await state.store.removeItem(item.number);
  } catch (error) {
    showError('text-error', error.message);
    return;
  }
  setItems(state.items.filter((other) => other.number !== item.number));
  $('text-dialog').close();
  renderBoard();
  refreshItems();
}

// ---------------------------------------------------------------- one idea

function openDetail(number) {
  state.detail = number;
  state.comments = [];
  state.commentsLoaded = false;
  $('comment-text').value = '';
  renderDetail();
  $('detail').showModal();
  loadComments();
  clearInterval(state.commentTimer);
  state.commentTimer = setInterval(() => { if (!document.hidden) loadComments(); }, POLL.comments);
}

function renderDetail() {
  const idea = state.ideas.find((item) => item.number === state.detail);
  if (!idea) {
    if ($('detail').open) {
      $('detail').close();
      toast('That idea was removed from the board.');
    }
    return;
  }
  $('detail-note').className = `detail-note note--${idea.color}`;
  const tab = state.tabs.find((item) => item.id === tabOf(idea));
  $('detail-tab').textContent = tab ? tab.name : '';
  $('detail-title').textContent = idea.title;
  $('detail-text').textContent = idea.text;
  $('detail-text').hidden = !idea.text;
  $('detail-by').textContent = `Pinned by ${idea.author}, ${ago(idea.created)}`;
  $('detail-actions').replaceChildren(...(canChange(idea.author)
    ? [
        h('button', { type: 'button', class: 'btn btn-quiet btn-on-note', onclick: () => openIdeaDialog(idea) }, 'Edit'),
        h('button', { type: 'button', class: 'btn btn-quiet btn-on-note', onclick: () => removeIdea(idea) }, 'Remove'),
      ]
    : []));
  const groups = onTab(state.groups, tabOf(idea));
  $('detail-group-row').hidden = !groups.length;
  const select = $('detail-group');
  select.replaceChildren(h('option', { value: '' }, 'No group'), ...groups.map((group) => h('option', { value: String(group.number) }, group.name)));
  select.value = groups.some((group) => group.number === idea.group) ? String(idea.group) : '';
  renderComments();
}

async function loadComments() {
  const number = state.detail;
  if (number == null || state.busy.comments) return;
  state.busy.comments = true;
  try {
    const comments = await state.store.listComments(number);
    if (state.detail !== number) return;
    if (comments !== state.comments || !state.commentsLoaded) {
      state.comments = comments;
      state.commentsLoaded = true;
      renderComments();
    }
  } catch (error) {
    if (state.detail === number && !state.commentsLoaded) {
      $('comment-list').replaceChildren(h('li', { class: 'comment-empty' }, error.message));
    }
  } finally {
    state.busy.comments = false;
  }
}

function renderComments() {
  const list = $('comment-list');
  $('comment-count').textContent = state.commentsLoaded && state.comments.length ? String(state.comments.length) : '';
  if (!state.commentsLoaded) {
    list.replaceChildren(h('li', { class: 'comment-empty' }, 'Loading comments...'));
    return;
  }
  if (!state.comments.length) {
    list.replaceChildren(h('li', { class: 'comment-empty' }, 'No comments yet. Start the conversation.'));
    return;
  }
  list.replaceChildren(...state.comments.map((comment) => h('li', { class: 'comment' },
    h('div', { class: 'comment-head' },
      h('strong', {}, comment.author),
      h('span', { class: 'comment-time' }, ago(comment.created)),
      canChange(comment.author)
        ? h('button', { type: 'button', class: 'link-btn', onclick: () => removeComment(comment) }, 'Delete')
        : null),
    h('p', { class: 'comment-text' }, comment.text))));
}

async function postComment(event) {
  event.preventDefault();
  const box = $('comment-text');
  const text = box.value.trim();
  const number = state.detail;
  if (!text || number == null) return;
  await busy($('comment-submit'), 'Posting...', async () => {
    try {
      const comment = await state.store.addComment(number, { author: state.session.name, text });
      box.value = '';
      if (state.detail === number) {
        state.comments = [...state.comments, comment];
        state.commentsLoaded = true;
        renderComments();
      }
      refreshItems();
    } catch (error) {
      toast(error.message, true);
    }
  });
}

async function removeComment(comment) {
  const ok = await confirmAction({
    title: 'Delete this comment?',
    body: 'It disappears for everyone. This cannot be undone.',
    action: 'Delete comment',
  });
  if (!ok || state.detail == null) return;
  try {
    await state.store.removeComment(state.detail, comment.id);
  } catch (error) {
    toast(error.message, true);
    return;
  }
  state.comments = state.comments.filter((item) => item.id !== comment.id);
  renderComments();
  refreshItems();
}

// ---------------------------------------------------------------- admin

function openAdminDialog() {
  if (state.admin) {
    state.admin = null;
    state.session.admin = null;
    saveSession();
    renderAll();
    if (state.detail != null) renderDetail();
    toast('Admin tools are off.');
    return;
  }
  $('admin-password').value = '';
  $('admin-error').hidden = true;
  $('admin-dialog').showModal();
  $('admin-password').focus();
}

async function unlockAdmin(event) {
  event.preventDefault();
  $('admin-error').hidden = true;
  await busy($('admin-submit'), 'Checking...', async () => {
    const payload = await openVault($('admin-password').value, state.vault.admin);
    if (!payload) {
      showError('admin-error', "That admin password isn't right.");
      return;
    }
    $('admin-password').value = '';
    state.session.admin = payload;
    state.admin = new Store(payload);
    saveSession();
    $('admin-dialog').close();
    renderAll();
    toast('Admin tools are on.');
  });
}

// ---------------------------------------------------------------- boards

function makeBoardId() {
  return `b-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function describeContents(items) {
  const count = (kind) => items.filter((item) => item.kind === kind).length;
  const parts = [
    [count('idea'), 'idea'],
    [count('text'), 'piece of text', 'pieces of text'],
    [count('sketch'), 'drawing'],
    [count('group'), 'group'],
  ].filter(([n]) => n).map(([n, one, many]) => `${n} ${n === 1 ? one : many || `${one}s`}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] || 'nothing';
}

// One dialog for a new board and for an existing board's settings. Only the
// person who owns a board decides whether it's private.
function openBoardDialog(board) {
  state.editingBoard = board;
  const ownsIt = !board || sameName(board.owner || '', state.session.name);
  $('tab-dialog-title').textContent = board ? 'Board settings' : 'New board';
  $('tab-submit').textContent = board ? 'Save' : 'Create board';
  $('tab-name').value = board ? board.name : '';
  $(`board-vis-${board ? board.visibility : 'public'}`).checked = true;
  $('board-visibility').disabled = !ownsIt;
  $('board-visibility-note').hidden = ownsIt;
  $('tab-error').hidden = true;
  $('tab-dialog').showModal();
  $('tab-name').focus();
}

async function saveBoard(event) {
  event.preventDefault();
  $('tab-error').hidden = true;
  const name = $('tab-name').value.trim().replace(/\s+/g, ' ');
  const checked = document.querySelector('input[name="board-visibility"]:checked');
  const visibility = checked && checked.value === 'private' ? 'private' : 'public';
  if (!name) {
    showError('tab-error', 'Give the board a name.');
    return;
  }
  const board = state.editingBoard;
  if (state.tabs.some((tab) => (!board || tab.id !== board.id) && sameName(tab.name, name))) {
    showError('tab-error', `There's already a board called ${name}.`);
    return;
  }
  const me = state.session.name;
  await busy($('tab-submit'), 'Saving...', async () => {
    let id;
    try {
      if (!board) {
        id = makeBoardId();
        upsertLocal(await state.store.createItem({ kind: 'board', id, name, owner: me, visibility, author: me }));
      } else if (board.legacy) {
        // A board from before boards were issues becomes one the first time it
        // changes, keeping its id so everything on it stays put.
        id = board.id;
        upsertLocal(await state.store.createItem({ kind: 'board', id, name, owner: board.owner, visibility, author: me }));
      } else {
        id = board.id;
        upsertLocal(await state.store.patchItem(board.number, { name, visibility }));
      }
    } catch (error) {
      showError('tab-error', error.message);
      return;
    }
    $('tab-dialog').close();
    if (!board) {
      chooseTab(id);
      toast(visibility === 'private' ? `Created ${name}. Only you can see it.` : `Created ${name}.`);
    } else {
      renderAll();
      const madePrivate = visibility === 'private' && board.visibility !== 'private';
      toast(madePrivate ? 'Saved. This board is private now, so only you can see it.' : 'Saved.');
    }
    refreshItems();
  });
}

// Deleting a board takes everything on it with it (closed, not destroyed:
// the issues can still be reopened on GitHub).
async function deleteBoard() {
  const board = currentTab();
  if (!canDeleteBoard(board)) {
    if (board) toast(`Only ${board.owner || 'the person who made it'} can delete ${board.name}.`, true);
    return;
  }
  const contents = state.items.filter((item) => item.kind !== 'board' && item.tab === board.id);
  const ok = await confirmAction({
    title: `Delete ${board.name}?`,
    body: contents.length
      ? `Everything on it goes too: ${describeContents(contents)}. This can't be undone from here.`
      : "It's empty, so nothing else is lost.",
    action: 'Delete board',
  });
  if (!ok) return;
  const button = $('delete-board');
  button.disabled = true;
  button.textContent = 'Deleting...';
  let failed = null;
  try {
    const queue = [...contents];
    const worker = async () => {
      while (queue.length) {
        const item = queue.shift();
        await state.store.removeItem(item.number);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    if (board.legacy) {
      upsertLocal(await state.store.createItem({
        kind: 'board', id: board.id, name: board.name, owner: board.owner, visibility: 'public', deleted: true, author: state.session.name,
      }));
    } else {
      await state.store.removeItem(board.number);
    }
  } catch (error) {
    failed = error;
  } finally {
    button.disabled = false;
    button.textContent = 'Delete board';
  }
  setItems(state.items.filter((item) => item.tab !== board.id && item.number !== board.number));
  chooseTab(initialTab());
  if (failed) toast(`${board.name} wasn't fully deleted. ${failed.message}`, true);
  else toast(`Deleted ${board.name}.`);
  refreshItems();
}

// ---------------------------------------------------------------- plumbing

function confirmAction({ title, body, action }) {
  return new Promise((resolve) => {
    const dialog = $('confirm-dialog');
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    $('confirm-ok').textContent = action;
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.showModal();
  });
}

function closeDialogs() {
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
}

function wire() {
  const world = $('world');
  world.style.width = `${BOARD.width}px`;
  world.style.height = `${BOARD.height}px`;
  for (const id of ['ink', 'strings']) {
    $(id).setAttribute('viewBox', `0 0 ${BOARD.width} ${BOARD.height}`);
    $(id).setAttribute('width', BOARD.width);
    $(id).setAttribute('height', BOARD.height);
  }

  const theme = $('theme');
  theme.value = savedTheme();
  theme.addEventListener('change', () => applyTheme(theme.value));
  $('rail-toggle').addEventListener('click', () => setRail(!$('app').classList.contains('rail-collapsed')));

  $('signin-form').addEventListener('submit', signIn);
  $('sign-out').addEventListener('click', signOut);
  $('admin-toggle').addEventListener('click', openAdminDialog);
  $('admin-form').addEventListener('submit', unlockAdmin);
  $('new-idea').addEventListener('click', () => {
    state.newSpot = null;
    openIdeaDialog(null);
  });
  $('idea-form').addEventListener('submit', saveIdea);
  $('idea-dialog').addEventListener('close', () => { state.newSpot = null; });
  $('comment-form').addEventListener('submit', postComment);
  $('comment-text').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $('comment-form').requestSubmit();
  });
  $('detail-group').addEventListener('change', (event) => {
    if (state.detail != null) changeGroup(state.detail, event.target.value ? Number(event.target.value) : null);
  });
  $('new-tab').addEventListener('click', () => openBoardDialog(null));
  $('board-settings').addEventListener('click', () => openBoardDialog(currentTab()));
  $('delete-board').addEventListener('click', deleteBoard);
  $('tab-form').addEventListener('submit', saveBoard);

  $('text-form').addEventListener('submit', saveText);
  $('text-delete').addEventListener('click', eraseText);
  for (const radio of document.querySelectorAll('input[name="text-color"]')) radio.addEventListener('change', syncTextPreview);
  $('group-form').addEventListener('submit', makeGroup);
  $('group-edit-form').addEventListener('submit', renameGroup);
  $('group-ungroup').addEventListener('click', ungroup);

  for (const button of document.querySelectorAll('.mode')) {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  }
  $('tool-done').addEventListener('click', () => setMode('move'));
  for (const button of document.querySelectorAll('.pen-swatch')) {
    button.addEventListener('click', () => setPen({ color: button.dataset.pen }));
  }
  for (const button of document.querySelectorAll('.pen-size')) {
    button.addEventListener('click', () => setPen({ size: button.dataset.size }));
  }
  $('pen-eraser').addEventListener('click', () => {
    state.eraser = !state.eraser;
    renderToolBar();
  });
  $('pen-undo').addEventListener('click', undoStroke);

  for (const button of document.querySelectorAll('[data-string]')) {
    button.addEventListener('click', () => setStringColor(button.dataset.string));
  }
  for (const radio of document.querySelectorAll('input[name="line-color"]')) {
    radio.addEventListener('change', () => recolourLine(radio.value));
  }
  $('line-remove').addEventListener('click', removeLine);
  $('download-btn').addEventListener('click', () => toggleDownloadMenu());
  $('download-png').addEventListener('click', downloadPicture);
  $('download-pdf').addEventListener('click', downloadNotes);

  $('menu-idea').addEventListener('click', () => menuAction('idea'));
  $('menu-text').addEventListener('click', () => menuAction('text'));
  $('menu-draw').addEventListener('click', () => menuAction('draw'));

  $('zoom-in').addEventListener('click', () => zoomFromCentre(ZOOM.step));
  $('zoom-out').addEventListener('click', () => zoomFromCentre(1 / ZOOM.step));
  $('zoom-level').addEventListener('click', () => zoomFromCentre(1 / state.view.zoom));
  $('zoom-fit').addEventListener('click', fitBoard);

  const viewport = $('viewport');
  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('pointerdown', onBoardPointerDown);
  viewport.addEventListener('pointermove', onBoardPointerMove);
  viewport.addEventListener('pointerup', onBoardPointerUp);
  viewport.addEventListener('pointercancel', onBoardPointerUp);
  viewport.addEventListener('contextmenu', (event) => {
    if (state.mode !== 'move' || event.target.closest(BOARD_THINGS)) return;
    event.preventDefault();
    openMenu(event.clientX, event.clientY);
  });
  // Focus can scroll even an overflow:hidden box, which would knock the
  // transform out of line with the pointer. Position is the transform's job.
  viewport.addEventListener('scroll', () => {
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  });
  viewport.addEventListener('focusin', (event) => {
    const thing = event.target.closest('.note, .text-item');
    if (thing && thing.matches(':focus-visible')) revealElement(thing);
  });
  // The viewport changes size when the window does and when the side panel
  // opens or closes; keep the board inside its limits either way.
  new ResizeObserver(() => { if (state.session) applyView(); }).observe(viewport);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (!$('download-menu').hidden) toggleDownloadMenu(false);
    else if (!$('board-menu').hidden) closeMenu();
    else if (state.mode !== 'move') setMode('move');
  });
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('#board-menu')) closeMenu();
    if (!event.target.closest('.download')) toggleDownloadMenu(false);
  }, true);

  $('detail').addEventListener('close', () => {
    clearInterval(state.commentTimer);
    state.commentTimer = null;
    state.detail = null;
  });

  for (const dialog of document.querySelectorAll('dialog')) {
    // A click whose target is the dialog element itself landed on the backdrop.
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  }
  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !state.store) return;
    refreshItems();
    refreshTabs();
    if (state.detail != null) loadComments();
  });
  window.addEventListener('pagehide', flushDraft);
  window.addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (state.tabs.some((tab) => tab.id === id) && id !== state.current) chooseTab(id);
  });
}

boot();
