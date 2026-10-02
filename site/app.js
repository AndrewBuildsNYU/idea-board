// The board's screens: sign in, tabs, notes, one idea with its comments, and
// the admin tools for managing tabs.
//
// All user-written text reaches the page through textContent (the h() helper
// appends strings as text nodes). Nothing here ever assigns innerHTML.

import { open as openVault } from './vault.js';
import { Store, COLORS } from './store.js';

const SESSION_KEY = 'idea-board:session';
const TAB_KEY = 'idea-board:tab';
const SORT_KEY = 'idea-board:sort';
const POLL = { ideas: 20000, tabs: 60000, comments: 10000 };

const state = {
  vault: null,
  session: null, // { name, member, admin, vaultId }
  store: null,
  admin: null, // a Store holding the admin key, once unlocked
  loaded: false,
  tabs: [],
  ideas: [],
  current: null,
  sort: 'new',
  detail: null,
  comments: [],
  commentsLoaded: false,
  editing: null,
  tabMode: 'create',
  timers: [],
  commentTimer: null,
  busy: { ideas: false, tabs: false, comments: false },
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

function sorted(list) {
  const orders = {
    new: (a, b) => b.created.localeCompare(a.created),
    active: (a, b) => b.updated.localeCompare(a.updated),
    discussed: (a, b) => (b.comments - a.comments) || b.updated.localeCompare(a.updated),
  };
  return [...list].sort(orders[state.sort] || orders.new);
}

// ---------------------------------------------------------------- sign in

async function boot() {
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
    note.textContent = "This board is almost ready. Its access keys haven't been added yet, so nobody can sign in. If you're setting it up, the README lists the steps.";
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
  Object.assign(state, { session: null, store: null, admin: null, loaded: false, tabs: [], ideas: [], current: null });
  history.replaceState(null, '', location.pathname);
  showSignin('ready');
}

function saveSession() {
  writeStorage('sessionStorage', SESSION_KEY, state.session);
}

// ---------------------------------------------------------------- the board

async function startBoard(session) {
  state.session = session;
  state.store = new Store(session.member);
  state.admin = session.admin ? new Store(session.admin) : null;
  state.sort = readStorage('localStorage', SORT_KEY) || 'new';
  $('sort').value = state.sort;
  $('signin').hidden = true;
  $('app').hidden = false;
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
      if (state.loaded && !tabs.some((tab) => tab.id === state.current)) state.current = tabs.length ? tabs[0].id : null;
      renderAll();
    }
    $('banner').hidden = true;
  } catch (error) {
    showBanner(error);
  } finally {
    state.busy.tabs = false;
  }
}

async function refreshIdeas() {
  if (state.busy.ideas || !state.store) return;
  state.busy.ideas = true;
  try {
    const ideas = await state.store.listIdeas();
    if (ideas !== state.ideas) {
      state.ideas = ideas;
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
  const ideas = tab ? sorted(ideasIn(tab.id)) : [];
  $('tab-title').textContent = tab ? tab.name : 'Idea Board';
  $('tab-count').textContent = tab ? plural(ideas.length, 'idea') : '';
  document.title = tab ? `${tab.name} - Idea Board` : 'Idea Board';
  $('new-idea').disabled = !tab;

  const tools = $('admin-tools');
  tools.hidden = !(state.admin && tab);
  if (tab) {
    const index = state.tabs.indexOf(tab);
    $('move-up').disabled = index <= 0;
    $('move-down').disabled = index >= state.tabs.length - 1;
  }

  const notes = $('notes');
  const empty = $('empty');
  if (!state.loaded) {
    notes.replaceChildren();
    empty.replaceChildren(h('p', { class: 'empty-title' }, 'Loading the board...'));
    empty.hidden = false;
    return;
  }
  if (!tab) {
    notes.replaceChildren();
    empty.replaceChildren(...(state.admin
      ? [
          h('p', { class: 'empty-title' }, 'Create the first tab'),
          h('p', {}, 'Tabs group ideas by theme. Only you can create them.'),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openTabDialog('create') }, 'New tab'),
        ]
      : [
          h('p', { class: 'empty-title' }, 'No tabs yet'),
          h('p', {}, isAdminName()
            ? 'Turn on admin tools at the bottom of the sidebar to create the first tab.'
            : "Whoever runs the board hasn't created any tabs yet, so there's nowhere to pin ideas."),
        ]));
    empty.hidden = false;
    return;
  }
  if (!ideas.length) {
    notes.replaceChildren();
    empty.replaceChildren(
      h('p', { class: 'empty-title' }, `Nothing pinned in ${tab.name} yet`),
      h('p', {}, 'Post the first idea. Anyone on the team can read it and comment.'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openIdeaDialog(null) }, 'New idea'),
    );
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  notes.replaceChildren(...ideas.map(noteElement));
}

function noteElement(idea) {
  return h('button', {
    type: 'button',
    class: `note note--${idea.color}`,
    style: `--tilt: ${tilt(idea.number)}deg`,
    onclick: () => openDetail(idea.number),
  },
  h('span', { class: 'pin', 'aria-hidden': 'true' }),
  h('span', { class: 'note-title' }, idea.title),
  idea.text ? h('span', { class: 'note-text' }, idea.text) : null,
  h('span', { class: 'note-meta' },
    h('span', { class: 'note-author' }, idea.author),
    h('span', {}, ago(idea.created)),
    h('span', { class: 'note-comments' }, idea.comments ? plural(idea.comments, 'comment') : 'No comments')));
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
        const updated = await state.store.updateIdea(editing, { title, text, tab, color });
        state.ideas = state.ideas.map((idea) => (idea.number === updated.number ? updated : idea));
      } else {
        const idea = await state.store.createIdea({ title, text, tab, color, author: state.session.name });
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
  $('sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    writeStorage('localStorage', SORT_KEY, state.sort);
    renderBoard();
  });

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
