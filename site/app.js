// The board's screens: sign in, tabs, a zoomable board of notes per tab, one
// idea with its comments, and the admin tools for managing tabs.
//
// All user-written text reaches the page through textContent (the h() helper
// appends strings as text nodes). Nothing here ever assigns innerHTML.

import { open as openVault } from './vault.js';
import { Store, COLORS } from './store.js';

const SESSION_KEY = 'idea-board:session';
const TAB_KEY = 'idea-board:tab';
const THEME_KEY = 'idea-board:theme';
const VIEW_KEY = 'idea-board:views';
const RAIL_KEY = 'idea-board:rail';
const POLL = { ideas: 20000, tabs: 60000, comments: 10000 };

// Every tab's board is this big, in board pixels, and notes can't leave it.
const BOARD = { width: 3200, height: 2000 };
// How far people can zoom out and in.
const ZOOM = { min: 0.25, max: 2, step: 1.25 };
// A note's width is fixed; its height is nominal, for layout and clamping.
const NOTE = { width: 220, height: 170 };
const SLOT = { width: 250, height: 230 };
// How far past the board's edge someone can pan, in screen pixels.
const PAN_SLACK = 80;
const THEMES = ['auto', 'cork', 'whiteboard', 'chalk', 'night'];

const state = {
  vault: null,
  session: null, // { name, member, admin, vaultId }
  store: null,
  admin: null, // a Store holding the admin key, once unlocked
  loaded: false,
  tabs: [],
  serverIdeas: null,
  ideas: [],
  current: null,
  detail: null,
  comments: [],
  commentsLoaded: false,
  editing: null,
  tabMode: 'create',
  timers: [],
  commentTimer: null,
  busy: { ideas: false, tabs: false, comments: false },
  view: { zoom: 1, x: 32, y: 32 },
  views: {},
  spots: new Map(),
  drag: null,
  staleBoard: false,
  suppressClick: false,
  pointers: new Map(),
  gesture: null,
  moves: new Map(), // idea number -> { spot, timer, saving }
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
  return a.toLowerCase() === b.toLowerCase();
}

function isAdminName() {
  return Boolean(state.session && state.session.member.admin && sameName(state.session.name, state.session.member.admin));
}

function canChange(author) {
  return Boolean(state.admin) || sameName(author, state.session.name);
}

function currentTab() {
  return state.tabs.find((tab) => tab.id === state.current) || null;
}

// An idea whose tab no longer exists shows on the first tab, so nothing is
// ever stranded out of sight.
function tabOf(idea) {
  if (state.tabs.some((tab) => tab.id === idea.tab)) return idea.tab;
  return state.tabs.length ? state.tabs[0].id : null;
}

function ideasIn(tabId) {
  return state.ideas.filter((idea) => tabOf(idea) === tabId);
}

// ---------------------------------------------------------------- theme and panel

function savedTheme() {
  try {
    const theme = localStorage.getItem(THEME_KEY);
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
    localStorage.setItem(THEME_KEY, value);
  } catch {
    // Not remembered, but applied for this visit.
  }
}

function setRail(collapsed) {
  $('app').classList.toggle('rail-collapsed', collapsed);
  $('rail-toggle').setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  $('rail-toggle-label').textContent = collapsed ? 'Show the side panel' : 'Hide the side panel';
  $('rail-toggle').title = collapsed ? 'Show the side panel' : 'Hide the side panel';
  writeStorage('localStorage', RAIL_KEY, collapsed ? 'collapsed' : 'open');
}

// ---------------------------------------------------------------- sign in

async function boot() {
  state.views = readStorage('localStorage', VIEW_KEY) || {};
  if (typeof state.views !== 'object' || Array.isArray(state.views)) state.views = {};
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
  const saved = readStorage('sessionStorage', SESSION_KEY);
  if (saved && saved.member && saved.vaultId === state.vault.member.salt) {
    startBoard(saved);
    return;
  }
  writeStorage('sessionStorage', SESSION_KEY, null);
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
    writeStorage('sessionStorage', SESSION_KEY, session);
    startBoard(session);
  });
}

function signOut() {
  stopPolling();
  closeDialogs();
  writeStorage('sessionStorage', SESSION_KEY, null);
  Object.assign(state, {
    session: null, store: null, admin: null, loaded: false, tabs: [], ideas: [], serverIdeas: null, current: null,
  });
  history.replaceState(null, '', location.pathname);
  showSignin('ready');
}

function saveSession() {
  writeStorage('sessionStorage', SESSION_KEY, state.session);
}

// ---------------------------------------------------------------- data

async function startBoard(session) {
  state.session = session;
  state.store = new Store(session.member);
  state.admin = session.admin ? new Store(session.admin) : null;
  $('signin').hidden = true;
  $('app').hidden = false;
  setRail(readStorage('localStorage', RAIL_KEY) === 'collapsed');
  renderAll();
  await Promise.all([refreshTabs(), refreshIdeas()]);
  state.loaded = true;
  chooseTab(initialTab());
  startPolling();
}

function initialTab() {
  const ids = state.tabs.map((tab) => tab.id);
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (ids.includes(fromHash)) return fromHash;
  const remembered = readStorage('localStorage', TAB_KEY);
  if (ids.includes(remembered)) return remembered;
  return ids[0] || null;
}

function chooseTab(id) {
  state.current = id;
  if (id) {
    history.replaceState(null, '', `#${id}`);
    writeStorage('localStorage', TAB_KEY, id);
  }
  renderAll();
  restoreView();
}

async function refreshTabs() {
  if (state.busy.tabs || !state.store) return;
  state.busy.tabs = true;
  try {
    // The admin's store remembers its own recent tab writes, which GitHub may
    // not be serving yet; reading through it keeps an edit from flickering back.
    const { tabs } = await (state.admin || state.store).getTabs();
    if (tabs !== state.tabs) {
      state.tabs = tabs;
      if (state.loaded && !tabs.some((tab) => tab.id === state.current)) {
        chooseTab(tabs.length ? tabs[0].id : null);
      } else {
        renderAll();
      }
    }
    $('banner').hidden = true;
  } catch (error) {
    showBanner(error);
  } finally {
    state.busy.tabs = false;
  }
}

// Moves not yet saved win over whatever the server says, so a note doesn't
// jump back while its new position is on its way.
function withLocalMoves(ideas) {
  if (!state.moves.size) return ideas;
  return ideas.map((idea) => {
    const move = state.moves.get(idea.number);
    return move ? { ...idea, x: move.spot.x, y: move.spot.y } : idea;
  });
}

async function refreshIdeas() {
  if (state.busy.ideas || !state.store) return;
  state.busy.ideas = true;
  try {
    const ideas = await state.store.listIdeas();
    if (ideas !== state.serverIdeas) {
      state.serverIdeas = ideas;
      state.ideas = withLocalMoves(ideas);
      renderAll();
      if (state.detail != null) renderDetail();
    }
    $('banner').hidden = true;
  } catch (error) {
    showBanner(error);
  } finally {
    state.busy.ideas = false;
  }
}

function showBanner(error) {
  const banner = $('banner');
  banner.textContent = error.message;
  banner.hidden = false;
}

function startPolling() {
  stopPolling();
  state.timers.push(setInterval(() => { if (!document.hidden) refreshIdeas(); }, POLL.ideas));
  state.timers.push(setInterval(() => { if (!document.hidden) refreshTabs(); }, POLL.tabs));
}

function stopPolling() {
  state.timers.forEach(clearInterval);
  state.timers = [];
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  if (!state.session) return;
  renderWho();
  renderTabs();
  renderBoard();
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
    list.replaceChildren(h('p', { class: 'rail-empty' }, state.loaded ? 'No tabs yet' : 'Loading...'));
  } else {
    list.replaceChildren(...state.tabs.map((tab) => h('button', {
      type: 'button',
      class: 'tab',
      'aria-current': tab.id === state.current ? 'page' : null,
      onclick: () => chooseTab(tab.id),
    }, h('span', { class: 'tab-name' }, tab.name), h('span', { class: 'tab-count' }, String(ideasIn(tab.id).length)))));
  }
  $('new-tab').hidden = !state.admin;
}

function renderBoard() {
  const tab = currentTab();
  const ideas = tab ? ideasIn(tab.id) : [];
  $('tab-title').textContent = tab ? tab.name : 'Idea Board';
  $('tab-count').textContent = tab ? plural(ideas.length, 'idea') : '';
  document.title = tab ? `${tab.name} - Idea Board` : 'Idea Board';
  $('new-idea').disabled = !tab;

  $('admin-tools').hidden = !(state.admin && tab);
  if (tab) {
    const index = state.tabs.indexOf(tab);
    $('move-up').disabled = index <= 0;
    $('move-down').disabled = index >= state.tabs.length - 1;
  }

  // Never rebuild the notes under someone's finger; catch up when they let go.
  if (state.drag) state.staleBoard = true;
  else drawNotes(ideas);

  const empty = $('empty');
  if (!state.loaded) {
    empty.replaceChildren(h('p', { class: 'empty-title' }, 'Loading the board...'));
    empty.hidden = false;
  } else if (!tab) {
    empty.replaceChildren(...(state.admin
      ? [
          h('p', { class: 'empty-title' }, 'Create the first tab'),
          h('p', {}, 'Tabs group ideas by theme. Only you can create them.'),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openTabDialog('create') }, 'New tab'),
        ]
      : [
          h('p', { class: 'empty-title' }, 'No tabs yet'),
          h('p', {}, isAdminName()
            ? 'Turn on admin tools at the bottom of the side panel to create the first tab.'
            : "Whoever runs the board hasn't created any tabs yet, so there's nowhere to pin ideas."),
        ]));
    empty.hidden = false;
  } else if (!ideas.length) {
    empty.replaceChildren(
      h('p', { class: 'empty-title' }, `Nothing pinned in ${tab.name} yet`),
      h('p', {}, 'Post the first idea. Anyone on the team can read it, comment, and move it around the board.'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openIdeaDialog(null) }, 'New idea'),
    );
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }
}

function clampSpot(x, y, height = NOTE.height) {
  return {
    x: Math.round(clamp(x, 0, BOARD.width - NOTE.width)),
    y: Math.round(clamp(y, 0, BOARD.height - Math.max(height, 60))),
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
    const spot = clampSpot(idea.x, idea.y);
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
    if (!spot) spot = clampSpot(40 + (idea.number % 12) * 14, 40 + (idea.number % 12) * 14);
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
  const el = h('button', {
    type: 'button',
    class: `note note--${idea.color}`,
    'data-number': String(idea.number),
    style: `left: ${spot.x}px; top: ${spot.y}px; --tilt: ${tilt(idea.number)}deg`,
    onclick: () => {
      if (state.suppressClick) {
        state.suppressClick = false;
        return;
      }
      openDetail(idea.number);
    },
    onpointerdown: (event) => startNoteDrag(event, idea, el),
    onkeydown: (event) => nudgeNote(event, idea, el),
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

// ---------------------------------------------------------------- moving notes

function startNoteDrag(event, idea, el) {
  if (event.button !== 0 || state.drag || state.pointers.size) return;
  state.drag = {
    idea,
    el,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    from: { x: parseFloat(el.style.left), y: parseFloat(el.style.top) },
    moved: false,
    spot: null,
  };
  el.setPointerCapture(event.pointerId);
  el.addEventListener('pointermove', moveNoteDrag);
  el.addEventListener('pointerup', endNoteDrag);
  el.addEventListener('pointercancel', endNoteDrag);
}

function moveNoteDrag(event) {
  const drag = state.drag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  // A few pixels of wobble is still a click, which opens the note.
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    drag.el.classList.add('dragging');
  }
  const { zoom } = state.view;
  drag.spot = clampSpot(drag.from.x + dx / zoom, drag.from.y + dy / zoom, drag.el.offsetHeight);
  drag.el.style.left = `${drag.spot.x}px`;
  drag.el.style.top = `${drag.spot.y}px`;
}

function endNoteDrag(event) {
  const drag = state.drag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  const { el } = drag;
  el.removeEventListener('pointermove', moveNoteDrag);
  el.removeEventListener('pointerup', endNoteDrag);
  el.removeEventListener('pointercancel', endNoteDrag);
  el.classList.remove('dragging');
  state.drag = null;
  if (drag.moved && drag.spot) {
    // The click that follows a drag must not open the note.
    state.suppressClick = true;
    setTimeout(() => { state.suppressClick = false; }, 0);
    queueMove(drag.idea.number, drag.spot);
  }
  if (state.staleBoard) {
    state.staleBoard = false;
    renderBoard();
  }
}

function nudgeNote(event, idea, el) {
  const steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const step = steps[event.key];
  if (!step) return;
  event.preventDefault();
  const distance = event.shiftKey ? 60 : 12;
  const spot = clampSpot(
    parseFloat(el.style.left) + step[0] * distance,
    parseFloat(el.style.top) + step[1] * distance,
    el.offsetHeight,
  );
  el.style.left = `${spot.x}px`;
  el.style.top = `${spot.y}px`;
  queueMove(idea.number, spot);
  revealNote(el);
}

// Saves a note's new spot once it has stopped moving, one write at a time
// per note, so a burst of drags or arrow presses becomes a single edit.
function queueMove(number, spot) {
  state.ideas = state.ideas.map((idea) => (idea.number === number ? { ...idea, x: spot.x, y: spot.y } : idea));
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
  if (!state.ideas.some((item) => item.number === number)) {
    state.moves.delete(number);
    return;
  }
  const { spot } = entry;
  entry.saving = true;
  try {
    await state.store.moveIdea(number, spot.x, spot.y);
  } catch (error) {
    toast(`That note's new position wasn't saved. ${error.message}`, true);
  }
  entry.saving = false;
  if (entry.spot === spot) {
    state.moves.delete(number);
    refreshIdeas();
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
    viewSaveTimer = setTimeout(() => writeStorage('localStorage', VIEW_KEY, state.views), 400);
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

function frame(box, maxZoom) {
  const rect = viewportRect();
  if (!rect.width) return;
  const zoom = clamp(Math.min((rect.width - 48) / box.width, (rect.height - 48) / box.height), ZOOM.min, maxZoom);
  state.view = {
    zoom,
    x: rect.width / 2 - (box.x + box.width / 2) * zoom,
    y: rect.height / 2 - (box.y + box.height / 2) * zoom,
  };
  applyView();
}

function fitBoard() {
  frame({ x: 0, y: 0, width: BOARD.width, height: BOARD.height }, ZOOM.max);
}

function fitNotes() {
  const spots = [...state.spots.values()];
  if (!spots.length) {
    state.view = { zoom: 1, x: 32, y: 32 };
    applyView();
    return;
  }
  const left = Math.min(...spots.map((s) => s.x));
  const top = Math.min(...spots.map((s) => s.y));
  const right = Math.max(...spots.map((s) => s.x)) + NOTE.width;
  const bottom = Math.max(...spots.map((s) => s.y)) + NOTE.height + 40;
  frame({ x: left - 40, y: top - 40, width: right - left + 80, height: bottom - top + 80 }, 1);
}

// Each person's zoom and position is remembered per tab, in their browser.
function restoreView() {
  const saved = state.current ? state.views[state.current] : null;
  if (saved && [saved.zoom, saved.x, saved.y].every(Number.isFinite)) {
    state.view = { zoom: saved.zoom, x: saved.x, y: saved.y };
    applyView();
  } else {
    fitNotes();
  }
}

// The spot at the middle of the screen, where a new note should appear.
function centreSpot() {
  const rect = viewportRect();
  const { zoom, x, y } = state.view;
  const jitter = () => (Math.random() - 0.5) * 60;
  return clampSpot(
    (rect.width / 2 - x) / zoom - NOTE.width / 2 + jitter(),
    (rect.height / 2 - y) / zoom - NOTE.height / 2 + jitter(),
  );
}

function revealNote(note) {
  const rect = viewportRect();
  const box = note.getBoundingClientRect();
  let dx = 0;
  let dy = 0;
  if (box.left < rect.left + 16) dx = rect.left + 16 - box.left;
  else if (box.right > rect.right - 16) dx = rect.right - 16 - box.right;
  if (box.top < rect.top + 16) dy = rect.top + 16 - box.top;
  else if (box.bottom > rect.bottom - 16) dy = rect.bottom - 16 - box.bottom;
  if (dx || dy) {
    state.view.x += dx;
    state.view.y += dy;
    applyView();
  }
}

function onWheel(event) {
  event.preventDefault();
  if (state.drag) return;
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

function onPanStart(event) {
  if (event.target.closest('.note, .empty')) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  $('viewport').setPointerCapture(event.pointerId);
  state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  state.gesture = gesture();
  $('viewport').classList.add('panning');
}

function onPanMove(event) {
  if (!state.pointers.has(event.pointerId)) return;
  state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const now = gesture();
  const before = state.gesture;
  state.gesture = now;
  if (!before || before.count !== now.count) return;
  state.view.x += now.cx - before.cx;
  state.view.y += now.cy - before.cy;
  if (now.count > 1 && before.spread > 0) {
    const rect = viewportRect();
    zoomAt(now.spread / before.spread, now.cx - rect.left, now.cy - rect.top);
  }
  applyView();
}

function onPanEnd(event) {
  if (!state.pointers.delete(event.pointerId)) return;
  state.gesture = state.pointers.size ? gesture() : null;
  if (!state.pointers.size) $('viewport').classList.remove('panning');
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
        // A note moved to another tab finds a free spot on that board.
        if (tab !== tabOf(editing)) Object.assign(changes, { x: null, y: null });
        const updated = await state.store.updateIdea(editing, changes);
        state.ideas = state.ideas.map((idea) => (idea.number === updated.number ? updated : idea));
      } else {
        // A new note appears in the middle of whatever part of the board is on screen.
        const spot = tab === state.current ? centreSpot() : { x: null, y: null };
        const idea = await state.store.createIdea({ title, text, tab, color, author: state.session.name, ...spot });
        state.ideas = [idea, ...state.ideas];
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
    refreshIdeas();
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
  state.ideas = state.ideas.filter((item) => item.number !== idea.number);
  $('detail').close();
  renderAll();
  toast('Idea removed.');
  refreshIdeas();
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
      refreshIdeas();
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
  refreshIdeas();
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

// Reads the latest tabs.json, applies the change and writes it back. GitHub
// refuses a write against a stale sha, so a clash with another tab of
// yours is retried once from fresh.
async function changeTabs(message, mutate) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { tabs, sha } = await state.admin.getTabs(true);
    const next = mutate(tabs.map((tab) => ({ ...tab })));
    if (!next) return;
    try {
      const saved = await state.admin.saveTabs(next, sha, message);
      state.tabs = saved.tabs;
      return;
    } catch (error) {
      if (attempt === 0 && (error.status === 409 || error.status === 422)) continue;
      throw error;
    }
  }
}

function makeTabId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'tab';
  return `${slug}-${Date.now().toString(36).slice(-5)}`;
}

function openTabDialog(mode) {
  const tab = currentTab();
  if (mode === 'rename' && !tab) return;
  state.tabMode = mode;
  $('tab-dialog-title').textContent = mode === 'create' ? 'New tab' : 'Rename tab';
  $('tab-submit').textContent = mode === 'create' ? 'Create tab' : 'Save name';
  $('tab-name').value = mode === 'rename' ? tab.name : '';
  $('tab-error').hidden = true;
  $('tab-dialog').showModal();
  $('tab-name').focus();
}

async function saveTab(event) {
  event.preventDefault();
  $('tab-error').hidden = true;
  const name = $('tab-name').value.trim().replace(/\s+/g, ' ');
  if (!name) {
    showError('tab-error', 'Give the tab a name.');
    return;
  }
  const mode = state.tabMode;
  const targetId = state.current;
  await busy($('tab-submit'), 'Saving...', async () => {
    const id = makeTabId(name);
    let duplicate = false;
    try {
      await changeTabs(mode === 'create' ? `Add tab: ${name}` : `Rename tab: ${name}`, (tabs) => {
        if (tabs.some((tab) => tab.id !== targetId && sameName(tab.name, name)) ||
            (mode === 'create' && tabs.some((tab) => sameName(tab.name, name)))) {
          duplicate = true;
          return null;
        }
        return mode === 'create'
          ? [...tabs, { id, name }]
          : tabs.map((tab) => (tab.id === targetId ? { ...tab, name } : tab));
      });
    } catch (error) {
      showError('tab-error', error.message);
      return;
    }
    if (duplicate) {
      showError('tab-error', `There's already a tab called ${name}.`);
      return;
    }
    $('tab-dialog').close();
    if (mode === 'create') {
      chooseTab(id);
      toast(`Created ${name}.`);
    } else {
      renderAll();
      toast('Tab renamed.');
    }
  });
}

async function moveTab(delta) {
  const id = state.current;
  try {
    await changeTabs('Reorder tabs', (tabs) => {
      const from = tabs.findIndex((tab) => tab.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= tabs.length) return null;
      [tabs[from], tabs[to]] = [tabs[to], tabs[from]];
      return tabs;
    });
  } catch (error) {
    toast(error.message, true);
    return;
  }
  renderAll();
}

async function deleteTab() {
  const tab = currentTab();
  if (!tab) return;
  const count = ideasIn(tab.id).length;
  if (count) {
    toast(`${tab.name} still has ${plural(count, 'idea')}. Move them first: open an idea, choose Edit, and pick another tab.`, true);
    return;
  }
  const ok = await confirmAction({
    title: `Delete ${tab.name}?`,
    body: 'The tab is empty, so no ideas are lost.',
    action: 'Delete tab',
  });
  if (!ok) return;
  try {
    await changeTabs(`Delete tab: ${tab.name}`, (tabs) => tabs.filter((item) => item.id !== tab.id));
  } catch (error) {
    toast(error.message, true);
    return;
  }
  chooseTab(state.tabs.length ? state.tabs[0].id : null);
  toast('Tab deleted.');
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

  const theme = $('theme');
  theme.value = savedTheme();
  theme.addEventListener('change', () => applyTheme(theme.value));
  $('rail-toggle').addEventListener('click', () => setRail(!$('app').classList.contains('rail-collapsed')));

  $('signin-form').addEventListener('submit', signIn);
  $('sign-out').addEventListener('click', signOut);
  $('admin-toggle').addEventListener('click', openAdminDialog);
  $('admin-form').addEventListener('submit', unlockAdmin);
  $('new-idea').addEventListener('click', () => openIdeaDialog(null));
  $('idea-form').addEventListener('submit', saveIdea);
  $('comment-form').addEventListener('submit', postComment);
  $('comment-text').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $('comment-form').requestSubmit();
  });
  $('new-tab').addEventListener('click', () => openTabDialog('create'));
  $('rename-tab').addEventListener('click', () => openTabDialog('rename'));
  $('move-up').addEventListener('click', () => moveTab(-1));
  $('move-down').addEventListener('click', () => moveTab(1));
  $('delete-tab').addEventListener('click', deleteTab);
  $('tab-form').addEventListener('submit', saveTab);

  $('zoom-in').addEventListener('click', () => zoomFromCentre(ZOOM.step));
  $('zoom-out').addEventListener('click', () => zoomFromCentre(1 / ZOOM.step));
  $('zoom-level').addEventListener('click', () => zoomFromCentre(1 / state.view.zoom));
  $('zoom-fit').addEventListener('click', fitBoard);

  const viewport = $('viewport');
  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('pointerdown', onPanStart);
  viewport.addEventListener('pointermove', onPanMove);
  viewport.addEventListener('pointerup', onPanEnd);
  viewport.addEventListener('pointercancel', onPanEnd);
  // Focus can scroll even an overflow:hidden box, which would knock the
  // transform out of line with the pointer. Position is the transform's job.
  viewport.addEventListener('scroll', () => {
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  });
  viewport.addEventListener('focusin', (event) => {
    const note = event.target.closest('.note');
    if (note && note.matches(':focus-visible')) revealNote(note);
  });
  // The viewport changes size when the window does and when the side panel
  // opens or closes; keep the board inside its limits either way.
  new ResizeObserver(() => { if (state.session) applyView(); }).observe(viewport);

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
    refreshIdeas();
    refreshTabs();
    if (state.detail != null) loadComments();
  });
  window.addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (state.tabs.some((tab) => tab.id === id) && id !== state.current) chooseTab(id);
  });
}

boot();
