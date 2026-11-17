import { COLORS } from './core.js';
import { sessionDate } from './session-format.js';

const INDEX = 'savedSessionIndex';
const keyFor = id => `savedSession:${id}`;
export function restorableUrl(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:', 'chrome-extension:'].includes(url.protocol)) return true;
    if (url.protocol === 'about:') return url.pathname === 'blank';
    // Browser UI pages can be reopened, unlike diagnostic commands such as quit/crash.
    return url.protocol === 'chrome:' && ['newtab', 'new-tab-page', 'extensions', 'settings', 'history', 'bookmarks', 'downloads', 'version', 'flags', 'apps', 'management', 'password-manager', 'inspect', 'discards', 'gpu', 'tab-search', 'reading-list'].includes(url.hostname);
  } catch { return false; }
}
export function sessionName(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new Error('Use a session name between 1 and 100 characters.');
  return value.trim();
}
export async function listSavedSessions(offset = 0) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid session list position.');
  const { [INDEX]: index = [] } = await chrome.storage.local.get(INDEX);
  return { sessions: index.slice(offset, offset + 20), hasMore: index.length > offset + 20, total: index.length };
}
export async function getSavedSession(id) {
  if (typeof id !== 'string' || id.length > 80) throw new Error('Invalid saved session.');
  const session = (await chrome.storage.local.get(keyFor(id)))[keyFor(id)];
  if (!session) throw new Error('This saved session no longer exists.');
  return session;
}
export async function saveWindowSession(windowId, name, close) {
  const win = await chrome.windows.get(windowId, { populate: true });
  if (win.incognito || win.type !== 'normal') throw new Error('Choose a regular browser window.');
  const tabs = win.tabs.filter(tab => restorableUrl(tab.pendingUrl || tab.url));
  if (!tabs.length) throw new Error('There are no supported tabs to save in this window.');
  const groups = await chrome.tabGroups.query({ windowId });
  const at = Date.now(), id = crypto.randomUUID();
  const session = {
    id, schema: 1, at, name: sessionName(name, sessionDate(at)),
    tabs: tabs.map(tab => ({ url: tab.pendingUrl || tab.url, title: tab.title || tab.pendingUrl || tab.url, pinned: tab.pinned, active: tab.active, group: tab.groupId })),
    groups: groups.filter(group => tabs.some(tab => tab.groupId === group.id)).map(group => ({ id: group.id, title: group.title || '', color: group.color, collapsed: group.collapsed }))
  };
  const { [INDEX]: index = [] } = await chrome.storage.local.get(INDEX);
  const summary = { id, name: session.name, at, tabs: session.tabs.length, groups: session.groups.length };
  // Persist both records together before closing anything. Quota/write failure
  // leaves the live tabs open; old saved sessions are never automatically evicted.
  await chrome.storage.local.set({ [keyFor(id)]: session, [INDEX]: [summary, ...index] });
  let closed = 0;
  if (close) {
    try {
      const live = await chrome.tabs.query({ windowId });
      const originals = new Map(tabs.map(tab => [tab.id, tab.pendingUrl || tab.url]));
      const ids = live.filter(tab => originals.has(tab.id) && originals.get(tab.id) === (tab.pendingUrl || tab.url)).map(tab => tab.id);
      // Closing the final captured tab closes its window naturally.
      if (ids.length) { await chrome.tabs.remove(ids); closed = ids.length; }
    } catch { return { ...summary, closed, closeError: 'Session saved, but some tabs could not be closed.' }; }
  }
  return { ...summary, closed };
}
export async function renameSavedSession(id, name) {
  const session = await getSavedSession(id);
  session.name = sessionName(name, session.name);
  const { [INDEX]: index = [] } = await chrome.storage.local.get(INDEX);
  await chrome.storage.local.set({ [keyFor(id)]: session, [INDEX]: index.map(item => item.id === id ? { ...item, name: session.name } : item) });
  return session.name;
}
export async function deleteSavedSession(id) {
  await getSavedSession(id);
  const { [INDEX]: index = [] } = await chrome.storage.local.get(INDEX);
  await chrome.storage.local.set({ [INDEX]: index.filter(item => item.id !== id) });
  await chrome.storage.local.remove(keyFor(id));
}
export async function deleteSavedTab(id, tabIndex, revision) {
  const session = await getSavedSession(id);
  if (!Number.isInteger(tabIndex) || tabIndex < 0 || tabIndex >= session.tabs.length) throw new Error('Invalid saved tab.');
  if (revision !== (session.revision || 0)) throw new Error('This session changed. Refresh it before deleting a link.');
  session.tabs.splice(tabIndex, 1);
  session.groups = session.groups.filter(group => session.tabs.some(tab => tab.group === group.id));
  session.revision = (session.revision || 0) + 1;
  const { [INDEX]: index = [] } = await chrome.storage.local.get(INDEX);
  await chrome.storage.local.set({ [keyFor(id)]: session, [INDEX]: index.map(item => item.id === id ? {...item, tabs: session.tabs.length, groups: session.groups.length} : item) });
  return {tabs: session.tabs.length};
}
export async function restoreSavedSession(id, windowId, tabIndex, markRestored, revision) {
  const session = await getSavedSession(id);
  if (revision !== undefined && revision !== (session.revision || 0)) throw new Error('This session changed. Refresh it before restoring a link.');
  if (tabIndex !== undefined && (!Number.isInteger(tabIndex) || tabIndex < 0 || tabIndex >= session.tabs.length)) throw new Error('Invalid saved tab.');
  const selected = tabIndex === undefined ? session.tabs : [session.tabs[tabIndex]];
  if (!selected.length) throw new Error('This saved session has no tabs left.');
  if (selected.some(tab => !tab || !restorableUrl(tab.url))) throw new Error('The saved tabs contain an unsupported URL.');
  const made = []; let newWindow, seed;
  try {
    if (windowId === undefined) {
      newWindow = await chrome.windows.create({ url: 'about:blank', focused: false });
      windowId = newWindow.id; seed = newWindow.tabs[0].id;
    } else {
      const win = await chrome.windows.get(windowId);
      if (win.incognito || win.type !== 'normal') throw new Error('Choose a regular browser window.');
    }
    for (const saved of selected) {
      // Reopen Chrome's entry point so the current new-tab override is honored.
      const url = /^chrome:\/\/new-tab-page\/?(?:[?#].*)?$/.test(saved.url) ? 'chrome://newtab/' : saved.url;
      const tab = await chrome.tabs.create({ windowId, url, pinned: Boolean(saved.pinned), active: false });
      made.push({ id: tab.id, saved });
      await markRestored(tab.id);
    }
    const restoredGroups = [];
    for (const group of session.groups) {
      const ids = made.filter(item => item.saved.group === group.id && !item.saved.pinned).map(item => item.id);
      if (!ids.length) continue;
      const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: group.title, color: COLORS.includes(group.color) ? group.color : 'grey', collapsed: Boolean(group.collapsed) });
      restoredGroups.push({ id: groupId, collapsed: Boolean(group.collapsed) });
    }
    if (seed) { await markRestored(seed, 'closing'); await chrome.tabs.remove(seed); }
    const active = made.find(item => item.saved.active) || made[0];
    await markRestored(active.id, true);
    await chrome.tabs.update(active.id, { active: true });
    for (const group of restoredGroups) await chrome.tabGroups.update(group.id, { collapsed: group.collapsed });
    if (newWindow) await chrome.windows.update(windowId, { focused: true });
    return { tabs: made.length, windowId };
  } catch (error) {
    try {
      if (newWindow) await chrome.windows.remove(newWindow.id);
      else if (made.length) await chrome.tabs.remove(made.map(item => item.id));
    } catch { /* The user may already have closed the new tabs/window. */ }
    throw error;
  }
}
