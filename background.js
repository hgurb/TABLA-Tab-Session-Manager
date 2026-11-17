import { DEFAULTS, settingsFrom, site, eligible, ruleFor, groupName, colorFor, colorForRule, planPreservedGroups, matchWindows } from './core.js';
import { cachedFaviconColor, trackAutoColorGroup, refreshAutoColor, forgetAutoColorGroup } from './favicon-colors.js';
import { listSavedSessions, getSavedSession, saveWindowSession, renameSavedSession, deleteSavedSession, deleteSavedTab, restoreSavedSession } from './saved-sessions.js';

// Only coordination lives in Web Locks. All browser-session state is in storage.session;
// layouts and recovery history live in storage.local, independently of worker lifetime.
const locked = task => navigator.locks.request('tabsir-engine', task);
const readSettings = async () => settingsFrom((await chrome.storage.local.get('settings')).settings);
const readState = async () => (await chrome.storage.session.get('engine')).engine;
const writeState = async state => chrome.storage.session.set({ engine: state });
const alarm = async (name, delay = 3000) => chrome.alarms.create(name, { when: Date.now() + delay });

function rememberGroupTab(state, tab) {
  if (tab?.groupId >= 0) { state.groupLastActive ??= {}; state.groupLastActive[tab.groupId] = tab.id; }
}
async function seedGroupFocus() {
  const state = await readState();
  state.groupCollapsed ??= {}; state.groupLastActive ??= {}; state.ignoreGroupExpand ??= {};
  for (const win of await normalWindows()) {
    for (const group of await chrome.tabGroups.query({windowId:win.id})) state.groupCollapsed[group.id] = group.collapsed;
    rememberGroupTab(state,win.tabs.find(tab=>tab.active));
  }
  await writeState(state);
}
async function updateGroup(groupId, properties) {
  // Record our own expansions before calling Chrome; their events are queued
  // behind the current engine task and must not select another tab later.
  let ignored = false;
  if (properties.collapsed === false && (await chrome.tabGroups.get(groupId)).collapsed) {
    const state = await readState(); state.ignoreGroupExpand ??= {};
    state.ignoreGroupExpand[groupId] = (state.ignoreGroupExpand[groupId] || 0) + 1;
    await writeState(state); ignored = true;
  }
  try { return await chrome.tabGroups.update(groupId,properties); }
  catch (error) {
    if (ignored) {
      const state = await readState();
      if (--state.ignoreGroupExpand[groupId] <= 0) delete state.ignoreGroupExpand[groupId];
      await writeState(state);
    }
    throw error;
  }
}
async function groupUpdated(group) {
  const state = await readState(), previous = state.groupCollapsed?.[group.id];
  state.groupCollapsed ??= {}; state.groupCollapsed[group.id] = group.collapsed;
  const expanded = previous === true && !group.collapsed;
  const ignored = expanded && state.ignoreGroupExpand?.[group.id] > 0;
  if (ignored && --state.ignoreGroupExpand[group.id] <= 0) delete state.ignoreGroupExpand[group.id];
  await writeState(state);
  if (expanded && !ignored && !state.recovering && (await readSettings()).focusExpandedGroup) {
    try {
      const win = await chrome.windows.get(group.windowId), live = await chrome.tabGroups.get(group.id);
      const [active] = await chrome.tabs.query({windowId:group.windowId,active:true});
      if (win.focused && !win.incognito && win.type === 'normal' && !live.collapsed && active?.groupId !== group.id) {
        const tabs = await chrome.tabs.query({windowId:group.windowId,groupId:group.id});
        const target = tabs.find(tab=>tab.id === state.groupLastActive?.[group.id]) || tabs[0];
        if (target) await chrome.tabs.update(target.id,{active:true});
      }
    } catch (error) {
      if (!/no (?:tab|window|group)|not found|does not exist/i.test(error.message || '')) throw error;
    }
  }
  await touch();
}

async function feedback(text, failed = false) {
  await chrome.storage.local.set({ activity: { text, failed, at: Date.now() } });
  await chrome.action.setBadgeBackgroundColor({ color: failed ? '#a44967' : '#8a587f' });
  await chrome.action.setBadgeText({ text: failed ? '!' : '✓' });
  await chrome.action.setTitle({ title: `TABLA - ${text} (right-click for settings)` });
  await alarm('clear-badge', 5000);
}
async function failure(error) {
  // Chrome rejects in-flight APIs during normal browser shutdown. There is no
  // live UI/storage left to report to, and the previous snapshot is already safe.
  if (/browser is shutting down/i.test(error.message || '')) return;
  console.error('TABLA:', error);
  try { await feedback(error.message || String(error), true); } catch (reportError) { console.error(reportError); }
}
function run(task, { reload = false } = {}) {
  void (async () => {
    try { await locked(async () => { await initialize(reload); await task(); }); }
    catch (error) { await failure(error); }
  })();
}
async function resumeAfterReload(state) {
  if (state.browserStartup) return; // A real profile startup keeps its recovery.
  const { layout } = await chrome.storage.local.get('layout');
  const saved = new Map((layout?.windows || []).flatMap(win => win.tabs.map(tab => [tab.id, { ...tab, windowId: win.windowId }])));
  for (const win of await normalWindows()) for (const tab of win.tabs) {
    const previous = saved.get(tab.id);
    const family = (previous?.windowId === win.id && previous.family) || state.records[tab.id]?.family || crypto.randomUUID();
    state.records[tab.id] = { family, opener: tab.openerTabId };
    if (tab.active) { state.activeTabs ??= {}; state.activeTabs[win.id] = tab.id; }
  }
  state.recovering = false;
  state.closing = [];
  await writeState(state);
  await chrome.alarms.clear('recover');
  await collapseFocusedWindow();
}
async function initialize(reload = false) {
  const existing = await readState();
  if (existing) {
    if (!existing.groupCollapsed) await seedGroupFocus();
    // Alarms may be delayed while Chrome is suspended. A later event/request
    // must also finish expired recovery rather than leaving controls locked.
    if (existing.recovering && Date.now() - existing.boot >= 120000) {
      try { await recover(); }
      finally {
        const latest = await readState();
        if (latest.recovering) {
          latest.recovering = false; await writeState(latest);
          await chrome.alarms.clear('recover');
        }
      }
    }
    if (reload) await resumeAfterReload(await readState());
    return;
  }
  const { layout, settings, closingBackup } = await chrome.storage.local.get(['layout', 'settings', 'closingBackup']);
  let baseline = layout;
  // During OS shutdown, windows disappear one at a time. Retain windows from the
  // start of that closing burst, while preferring newer data for surviving ones.
  // These entries only repair tabs Chrome actually restores; they never reopen tabs.
  if (layout && closingBackup && layout.at <= closingBackup.closedAt + 30000) {
    const byWindow = new Map(closingBackup.layout.windows.map(win => [win.windowId, win]));
    for (const win of layout.windows) byWindow.set(win.windowId, win);
    baseline = { ...layout, windows: [...byWindow.values()] };
  }
  const hasBaseline = Boolean(settingsFrom(settings).persist && baseline?.windows?.length);
  const recovery = !reload && hasBaseline;
  // Preserve this separately: a half-restored browser must never become its own baseline.
  if (hasBaseline) await chrome.storage.local.set({ recoveryBaseline: baseline });
  const state = { records: {}, pending: {}, activeTabs: {}, closing: [], recovering: recovery, browserStartup: false, boot: Date.now(), changedAt: Date.now() };
  await writeState(state);
  await seedGroupFocus();
  if (reload) await resumeAfterReload(await readState());
  if (recovery) await alarm('recover');
  await chrome.alarms.create('checkpoint', { periodInMinutes: 1 });
}
async function normalWindows() {
  return (await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })).filter(win => !win.incognito);
}
async function describeWindow(win, records) {
  const groups = await chrome.tabGroups.query({ windowId: win.id });
  return {
    windowId: win.id,
    tabs: win.tabs.map(tab => ({ id: tab.id, url: tab.pendingUrl || tab.url || '', title: tab.title || '', pinned: tab.pinned, group: tab.groupId, family: records[tab.id]?.family || null })),
    groups: groups.map(group => ({ id: group.id, title: group.title || '', color: group.color, collapsed: group.collapsed }))
  };
}
async function checkpoint(forceHistory = false) {
  const state = await readState();
  if (state.recovering || !(await readSettings()).persist) return;
  const windows = await normalWindows();
  // A closing window may still be returned while its tabs are disappearing. Preserve
  // its last complete layout until onRemoved confirms the whole window has closed.
  if (!windows.length || windows.some(win => state.closing.includes(win.id))) return;
  const snapshot = { schema: 1, at: Date.now(), windows: [] };
  for (const win of windows) snapshot.windows.push(await describeWindow(win, state.records));
  const { layout, history = [] } = await chrome.storage.local.get(['layout', 'history']);
  if (layout && JSON.stringify(layout.windows) === JSON.stringify(snapshot.windows)) return;
  if (layout && (forceHistory || !history.length || Date.now() - history[0].at >= 60000)) history.unshift(layout);
  await chrome.storage.local.set({ layout: snapshot, history: history.slice(0, 8) });
}
async function touch() {
  const state = await readState();
  if (state.recovering) { state.changedAt = Date.now(); await writeState(state); await alarm('recover'); }
  else await checkpoint();
}
async function registerTab(tab, canAutoGroup) {
  if (tab.incognito) return;
  const state = await readState();
  if (state.restoredTabs?.includes(tab.id)) {
    state.restoredTabs = state.restoredTabs.filter(id => id !== tab.id);
    state.records[tab.id] = { family: crypto.randomUUID() };
    await writeState(state); return;
  }
  const parent = state.records[tab.openerTabId];
  const family = parent?.family || crypto.randomUUID();
  if (tab.openerTabId && !parent) state.records[tab.openerTabId] = { family };
  state.records[tab.id] = { family, opener: tab.openerTabId };
  // Chrome can populate openerTabId after onCreated (notably tabs.create).
  // Keep new tabs pending until their destination/opener can be read together.
  if (canAutoGroup && !state.recovering) state.pending[tab.id] = { opener: tab.openerTabId ?? null, sourceHint: state.activeTabs?.[tab.windowId] };
  if (!canAutoGroup && tab.active) { state.activeTabs ??= {}; state.activeTabs[tab.windowId] = tab.id; }
  await writeState(state);
}
async function keepUngrouped(tab) {
  // Leave positioning to Chrome and the tab's creator. Chrome may choose a group
  // boundary when removing inherited membership, but TABLA adds no explicit move.
  if (tab.groupId !== -1) await chrome.tabs.ungroup(tab.id);
}
async function tryAuto(tabId) {
  const state = await readState();
  if (state.recovering || !state.pending[tabId]) return;
  const settings = await readSettings();
  let tab, opener;
  try {
    tab = await chrome.tabs.get(tabId);
    // Only infer a source from membership present when the tab first appeared.
    // Later grouping can be a manual action or a group TABLA just created for
    // this tab's children; neither makes an old tab a new inherited child.
    if (!Object.hasOwn(state.pending[tabId], 'creationGroupId')) {
      state.pending[tabId].creationGroupId = tab.groupId;
      await writeState(state);
    }
    let openerId = state.pending[tabId].opener ?? tab.openerTabId;
    if (settings.enabled && (openerId === undefined || openerId === null) && tab.groupId !== -1 && state.pending[tabId].creationGroupId === tab.groupId) {
      const members = (await chrome.tabs.query({ groupId: tab.groupId })).filter(member => member.id !== tab.id);
      const hinted = members.find(member => member.id === state.pending[tabId].sourceHint);
      const before = members.filter(member => member.index < tab.index).at(-1);
      openerId = (hinted || before || members[0])?.id;
    }
    if (openerId === undefined || openerId === null) {
      if (!settings.enabled || (tab.status === 'complete' && site(tab.url))) { delete state.pending[tabId]; await writeState(state); }
      return;
    }
    opener = await chrome.tabs.get(openerId);
    const family = state.records[openerId]?.family || crypto.randomUUID();
    if (!state.records[openerId]) state.records[openerId] = { family };
    state.records[tabId] = { family, opener: openerId };
    state.pending[tabId].opener = openerId;
    await writeState(state);
  } catch { delete state.pending[tabId]; await writeState(state); return; }
  // pendingUrl is available before the destination commits or returns a response.
  // Use it immediately; only about:blank/unknown destinations need to wait.
  if (!site(tab.pendingUrl || tab.url)) {
    if (tab.status === 'complete' && tab.url && tab.url !== 'about:blank') { delete state.pending[tabId]; await writeState(state); }
    return;
  }
  delete state.pending[tabId];
  await writeState(state); // Clear first so self-generated events cannot regroup it twice.
  if (!settings.enabled || !eligible(tab, settings) || !eligible(opener, settings) || opener.windowId !== tab.windowId) return;
  const rule = ruleFor(tab, settings);
  const openerRule = ruleFor(opener, settings);
  const sameRule = rule && openerRule && rule.name === openerRule.name && rule.color === openerRule.color;
  const sameDomain = site(tab.pendingUrl || tab.url).domain === site(opener.pendingUrl || opener.url).domain;
  const belongs = sameRule || settings.groupBy === 'source' || sameDomain || (settings.combineExisting && opener.groupId !== -1);
  if (!belongs) { await keepUngrouped(tab); return; }
  if (opener.groupId !== -1) {
    const members = await chrome.tabs.query({ groupId: opener.groupId });
    if (settings.maxTabs && members.filter(t => t.id !== tab.id).length >= settings.maxTabs) {
      await keepUngrouped(tab); return;
    }
    // Existing groups keep names and colors chosen by the user.
    await chrome.tabs.group({ tabIds: [tab.id], groupId: opener.groupId });
  } else {
    const id = await chrome.tabs.group({ tabIds: [opener.id, tab.id], createProperties: { windowId: tab.windowId } });
    const autoColor = !sameRule || rule.color === 'auto';
    const title = sameRule ? rule.name : groupName(opener, settings);
    const fallback = sameRule ? colorForRule(rule) : colorFor(site(opener.pendingUrl || opener.url).domain);
    const color = autoColor ? (await cachedFaviconColor(opener)) || fallback : fallback;
    await updateGroup(id, { title, color });
    if (autoColor) await trackAutoColorGroup(id, opener, title, color);
  }
}
async function snapshotForUndo(windowId) {
  const win = await chrome.windows.get(windowId, { populate: true });
  const state = await readState();
  const { undo = {} } = await chrome.storage.session.get('undo');
  undo[windowId] = await describeWindow(win, state.records);
  await chrome.storage.session.set({ undo });
}
async function regroup(windowId, mode) {
  const state = await readState();
  if (state.recovering) throw new Error('Chrome is restoring tabs. Try grouping again in a moment.');
  const settings = await readSettings();
  const tabs = await chrome.tabs.query({ windowId });
  if (tabs.some(tab => tab.incognito)) throw new Error('TABLA does not save or organize incognito windows.');
  const groups = await chrome.tabGroups.query({windowId});
  const plan = planPreservedGroups(tabs,groups,settings,mode || (settings.toolbarFollow ? settings.groupBy : settings.toolbarMode),state.records);
  const changed = plan.merges.length + plan.additions.length + plan.creations.length > 0;
  const canCollapse = settings.toolbarCollapse && groups.length > 0;
  if (!changed && !canCollapse) { await feedback('Groups are already organized'); return {groups:0}; }
  await snapshotForUndo(windowId); await checkpoint(true);
  for (const tab of tabs) delete state.pending[tab.id];
  await writeState(state);
  const touched = new Set();
  for (const operation of [...plan.merges,...plan.additions]) {
    await chrome.tabs.group({groupId:operation.targetId,tabIds:operation.tabs.map(tab=>tab.id)});
    touched.add(operation.targetId);
  }
  // Existing destinations keep their identity and user-selected metadata.
  for (const id of touched) {
    const original = groups.find(group=>group.id === id);
    await updateGroup(id,{title:original.title || '',color:original.color,collapsed:original.collapsed});
  }
  for (const group of plan.creations) {
    const id = await chrome.tabs.group({tabIds:group.tabs.map(tab=>tab.id),createProperties:{windowId}});
    const color = group.autoColor ? (await cachedFaviconColor(group.tabs[0])) || group.color : group.color;
    await updateGroup(id,{title:group.title,color});
    if (group.autoColor) await trackAutoColorGroup(id,group.tabs[0],group.title,color);
    touched.add(id);
  }
  const count = touched.size;
  let collapsed = 0;
  if (settings.toolbarCollapse) {
    for (const group of await chrome.tabGroups.query({ windowId })) {
      if (!group.collapsed) await updateGroup(group.id, { collapsed: true });
      collapsed++;
    }
  }
  await checkpoint();
  await feedback(!changed ? `Collapsed ${collapsed} groups in this window` : `Organized this window into ${count} group${count === 1 ? '' : 's'}${settings.toolbarCollapse ? '; collapsed all groups' : ''}`);
  return { groups: count, collapsed };
}
async function ungroupWindow(windowId) {
  if ((await readState()).recovering) throw new Error('Chrome is restoring tabs. Try again in a moment.');
  const win = await chrome.windows.get(windowId, {populate:true});
  if (win.incognito || win.type !== 'normal') throw new Error('Choose a regular browser window.');
  const ids = win.tabs.filter(tab => tab.groupId !== -1).map(tab => tab.id);
  if (!ids.length) return {tabs:0};
  await snapshotForUndo(windowId); await checkpoint(true);
  await chrome.tabs.ungroup(ids);
  await checkpoint(); await feedback(`Ungrouped ${ids.length} tab${ids.length === 1 ? '' : 's'} in this window`);
  return {tabs:ids.length};
}
async function moveWindowGroups(windowId, side, {automatic = false} = {}) {
  const win = await chrome.windows.get(windowId, {populate:true});
  if (win.incognito || win.type !== 'normal') throw new Error('Choose a regular browser window.');
  if (!automatic) {
    const state = await readState();
    if (state.recovering) {
      state.recoveryChoices ??= {}; state.recoveryChoices[windowId] ??= {};
      state.recoveryChoices[windowId].side = side; await writeState(state);
    }
  }
  const tabs = win.tabs.sort((a,b)=>a.index-b.index);
  const groups = [...new Set(tabs.filter(tab=>tab.groupId !== -1).map(tab=>tab.groupId))];
  const pinned = tabs.filter(tab=>tab.pinned);
  const grouped = tabs.filter(tab=>!tab.pinned && tab.groupId !== -1);
  const singles = tabs.filter(tab=>!tab.pinned && tab.groupId === -1);
  const desired = [...pinned,...(side === 'left' ? [...grouped,...singles] : [...singles,...grouped])];
  if (desired.every((tab,index)=>tab.id === tabs[index].id)) return {groups:groups.length,moved:false};
  if (!automatic) { await snapshotForUndo(windowId); await checkpoint(true); }
  // Moving whole groups preserves membership and metadata. Process toward the
  // chosen edge in an order that retains both groups' and ungrouped tabs' order.
  for (const groupId of side === 'left' ? groups.toReversed() : groups) {
    await chrome.tabGroups.move(groupId,{index:side === 'left' ? pinned.length : -1});
  }
  if (!automatic) { await checkpoint(); await feedback(`Moved ${groups.length} groups to the ${side}`); }
  return {groups:groups.length,moved:true};
}
async function setManualExpansion(windowId, expanded) {
  const state = await readState(); state.manualExpansion ??= {};
  if (state.recovering) {
    state.recoveryChoices ??= {}; state.recoveryChoices[windowId] ??= {};
    state.recoveryChoices[windowId].collapsed = !expanded;
  }
  const [active] = expanded && (await readSettings()).autoCollapse ? await chrome.tabs.query({windowId,active:true}) : [];
  if (active) state.manualExpansion[windowId] = active.id;
  else delete state.manualExpansion[windowId];
  await writeState(state);
}
async function mergeWindows(windowId) {
  if ((await readState()).recovering) throw new Error('Wait for browser group recovery to finish before merging windows.');
  const target = await chrome.windows.get(windowId,{populate:true});
  if (target.incognito || target.type !== 'normal') throw new Error('Choose a regular browser window.');
  const sources = (await normalWindows()).filter(win=>win.id !== windowId).sort((a,b)=>a.id-b.id);
  if (!sources.length) return {windows:0,tabs:0,errors:[]};
  const initial = await readState();
  for (const win of [target,...sources]) for (const tab of win.tabs) delete initial.pending[tab.id];
  await writeState(initial);
  await checkpoint(true);
  if ((await readSettings()).persist) {
    const {layout,history = []} = await chrome.storage.local.get(['layout','history']);
    if (layout) await chrome.storage.local.set({history:[layout,...history.filter(item=>item.at !== layout.at)].slice(0,8)});
  }
  let tabs = 0, windows = 0;
  const errors = [], movedWindows = new Set();
  const active = target.tabs.find(tab=>tab.active)?.id;
  for (const source of sources) {
    let moved = 0;
    try {
      const current = await chrome.tabs.query({windowId:source.id});
      // Pins from each source append to the destination's pinned section.
      for (const tab of current.filter(tab=>tab.pinned)) {
        const pins = (await chrome.tabs.query({windowId,pinned:true})).length;
        await chrome.tabs.move(tab.id,{windowId,index:pins});
        moved++; tabs++;
        await chrome.tabs.update(tab.id,{pinned:true});
      }
      const groups = new Set();
      for (const tab of current.filter(tab=>!tab.pinned).sort((a,b)=>a.index-b.index)) {
        let live;
        try { live = await chrome.tabs.get(tab.id); } catch { continue; }
        if (live.windowId !== source.id) continue;
        if (live.groupId !== -1) {
          if (groups.has(live.groupId)) continue;
          groups.add(live.groupId);
          const group = await chrome.tabGroups.get(live.groupId);
          const members = await chrome.tabs.query({groupId:live.groupId});
          const result = await chrome.tabGroups.move(group.id,{windowId,index:-1});
          moved += members.length; tabs += members.length;
          await updateGroup(result?.id ?? group.id,{title:group.title || '',color:group.color,collapsed:group.collapsed});
        } else {
          await chrome.tabs.move(live.id,{windowId,index:-1}); moved++; tabs++;
        }
      }
    } catch (error) {
      errors.push(error.message || String(error));
    }
    if (moved) { windows++; movedWindows.add(source.id); }
  }
  if (tabs) {
    const state = await readState();
    const {undo = {}} = await chrome.storage.session.get('undo');
    for (const id of [windowId,...movedWindows]) delete undo[id];
    await chrome.storage.session.set({undo});
    if (active) {
      const [selected] = await chrome.tabs.query({windowId,active:true});
      if (selected?.id !== active) {
        state.restoreActivations ??= {}; state.restoreActivations[active] = true; await writeState(state);
        await chrome.tabs.update(active,{active:true});
      }
    }
    // Keep the merged groups' expansion states until the next tab selection.
    await setManualExpansion(windowId,true);
    await checkpoint();
  }
  await feedback(`Merged ${tabs} tabs from ${windows} windows${errors.length ? '; some windows could not be fully merged' : ''}`,errors.length>0);
  return {windows,tabs,errors};
}
async function organizeAllWindows(action) {
  if ((await readState()).recovering && ['group-all','ungroup-all'].includes(action)) throw new Error('Wait for browser group recovery to finish.');
  const windows = await normalWindows();
  let completed = 0, groups = 0, tabs = 0;
  const errors = [];
  for (const win of windows) {
    try {
      if (action === 'group-all') groups += (await regroup(win.id)).groups;
      else if (action === 'ungroup-all') tabs += (await ungroupWindow(win.id)).tabs;
      else if (action === 'move-left-all' || action === 'move-right-all') groups += (await moveWindowGroups(win.id,action === 'move-left-all' ? 'left' : 'right')).groups;
      else {
        await setManualExpansion(win.id,action === 'expand-all');
        for (const group of await chrome.tabGroups.query({windowId:win.id})) {
          await updateGroup(group.id,{collapsed:action === 'collapse-all'}); groups++;
        }
      }
      completed++;
    } catch (error) {
      // A window closed during the operation is no longer a target.
      try { await chrome.windows.get(win.id); } catch { continue; }
      errors.push(error.message || String(error));
    }
  }
  await checkpoint();
  return {windows:completed,groups,tabs,errors};
}
async function undoRegroup(windowId) {
  if ((await readState()).recovering) throw new Error('Wait for browser group recovery to finish before using Undo.');
  const { undo = {} } = await chrome.storage.session.get('undo');
  const saved = undo[windowId];
  if (!saved) throw new Error('There is no grouping change to undo in this window.');
  const tabs = await chrome.tabs.query({ windowId });
  const live = new Map(tabs.map(tab => [tab.id, tab]));
  const surviving = saved.tabs.filter(tab => live.has(tab.id) && !live.get(tab.id).pinned);
  if (surviving.length) await chrome.tabs.ungroup(surviving.map(tab => tab.id));
  for (const tab of surviving) await chrome.tabs.move(tab.id, { index: saved.tabs.indexOf(tab) });
  for (const group of saved.groups) {
    const ids = surviving.filter(tab => tab.group === group.id).map(tab => tab.id);
    if (ids.length) {
      const id = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
      await updateGroup(id, { title: group.title, color: group.color, collapsed: group.collapsed });
    }
  }
  delete undo[windowId]; await chrome.storage.session.set({ undo });
  await checkpoint(); await feedback('Restored the layout before the last grouping change');
}
async function repair(snapshot, explicit = false) {
  const state = await readState();
  const windows = (await normalWindows()).filter(win=>explicit || !state.recoveryExcludedWindows?.includes(win.id));
  const matches = matchWindows(snapshot.windows, windows);
  let restored = 0, matched = 0;
  for (const match of matches) {
    matched += match.pairs.length;
    for (const pair of match.pairs) {
      if (pair.saved.family) state.records[pair.current.id] = { family: pair.saved.family };
    }
    for (const group of match.saved.groups) {
      const members = match.pairs.filter(pair => pair.saved.group === group.id && !pair.current.pinned);
      if (!members.length) continue;
      // Chrome may have restored the group itself. Leave those groups alone at startup.
      if (!explicit && members.every(pair => pair.current.groupId !== -1)) continue;
      const candidates = explicit ? members : members.filter(pair => pair.current.groupId === -1);
      if (!candidates.length) continue;
      const existing = explicit ? undefined : members.find(pair => pair.current.groupId !== -1)?.current.groupId;
      const ids = candidates.map(pair => pair.current.id);
      const id = await chrome.tabs.group(existing !== undefined ? { tabIds: ids, groupId: existing } : { tabIds: ids, createProperties: { windowId: match.current.id } });
      await updateGroup(id, { title: group.title, color: group.color, collapsed: !explicit && state.recoveryChoices?.[match.current.id]?.collapsed !== undefined ? state.recoveryChoices[match.current.id].collapsed : group.collapsed });
      restored++;
    }
    // Grouping moves scattered tabs; put matched tabs back into their saved sequence.
    // Keep already-restored groups intact: moving a whole group avoids splitting it.
    if (!explicit && state.recoveryChoices?.[match.current.id]?.side) continue;
    const currentTabs = await chrome.tabs.query({ windowId: match.current.id });
    const indexById = new Map(match.pairs.map(pair => [pair.current.id, match.saved.tabs.indexOf(pair.saved)]));
    const groupIds = new Set();
    for (const pair of match.pairs) {
      const tab = currentTabs.find(tab => tab.id === pair.current.id);
      if (!tab || tab.pinned) continue;
      if (tab.groupId !== -1) {
        if (groupIds.has(tab.groupId)) continue;
        groupIds.add(tab.groupId);
        const members = currentTabs.filter(t => t.groupId === tab.groupId);
        if (members.every(t => indexById.has(t.id))) await chrome.tabGroups.move(tab.groupId, { windowId: match.current.id, index: Math.min(...members.map(t => indexById.get(t.id))) });
      } else if (explicit) await chrome.tabs.move(tab.id, { index: indexById.get(tab.id) });
    }
  }
  const latest = await readState(); latest.records = state.records; await writeState(latest);
  if (!explicit) {
    for (const [windowId,choice] of Object.entries(latest.recoveryChoices || {})) {
      try {
        if (choice.side) await moveWindowGroups(Number(windowId),choice.side,{automatic:true});
        if (choice.collapsed !== undefined) for (const group of await chrome.tabGroups.query({windowId:Number(windowId)})) await updateGroup(group.id,{collapsed:choice.collapsed});
      } catch (error) {
        try { await chrome.windows.get(Number(windowId)); } catch { continue; }
        throw error;
      }
    }
  }
  return { restored, matched };
}
async function recover() {
  const state = await readState();
  if (!state.recovering) return;
  if (Date.now() - state.changedAt < 2500 && Date.now() - state.boot < 120000) { await alarm('recover'); return; }
  const { recoveryBaseline } = await chrome.storage.local.get('recoveryBaseline');
  const result = recoveryBaseline ? await repair(recoveryBaseline) : { restored: 0, matched: 0 };
  const expected = recoveryBaseline?.windows.reduce((n, win) => n + win.tabs.length, 0) || 0;
  const latest = await readState();
  // Retry late session restores, but keep the original baseline safe throughout.
  if (result.matched < expected && Date.now() - latest.boot < 120000) { await alarm('recover', 10000); return; }
  const skipWindows = [...(latest.recoveryExcludedWindows || []),...Object.keys(latest.recoveryChoices || {}).map(Number)];
  // Preserve explicit collapse/expand choices through recovery completion too.
  if ((await readSettings()).autoCollapse) for (const [windowId,choice] of Object.entries(latest.recoveryChoices || {})) {
    if (choice.collapsed === undefined) continue;
    const [active] = await chrome.tabs.query({windowId:Number(windowId),active:true});
    if (active) { latest.manualExpansion ??= {}; latest.manualExpansion[windowId] = active.id; }
  }
  latest.recovering = false; delete latest.recoveryChoices; delete latest.recoveryExcludedWindows; await writeState(latest);
  await collapseFocusedWindow({skipWindows});
  await checkpoint();
  await feedback(result.matched ? 'Restart recovery finished; previous layout remains in Recovery' : 'No restored tabs matched. Previous layout is available in Recovery');
}
async function collapseFocusedWindow({skipWindows = []} = {}) {
  let win;
  try { win = await chrome.windows.getLastFocused({windowTypes:['normal']}); } catch { return; }
  if (win.focused && !win.incognito && !skipWindows.includes(win.id)) await collapseInactive({windowId:win.id});
}
async function collapseInactive({ windowId }) {
  if ((await readState()).recovering || !(await readSettings()).autoCollapse) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const win = await chrome.windows.get(windowId);
      if (!win.focused || win.incognito || win.type !== 'normal') return;
      // Activation events can queue behind other work. Use the actual selected
      // tab, never an old event's tab ID or pre-grouping membership.
      const [active] = await chrome.tabs.query({windowId,active:true});
      const state = await readState();
      if (!active || state.restoreActivations?.[active.id]) return;
      if (state.manualExpansion?.[windowId] === active.id) return;
      if (state.manualExpansion?.[windowId] !== undefined) { delete state.manualExpansion[windowId]; await writeState(state); }
      let changed = false;
      for (const group of await chrome.tabGroups.query({windowId})) {
        const [current] = await chrome.tabs.query({windowId,active:true});
        if (!current || current.id !== active.id || current.groupId !== active.groupId) {changed = true; break;}
        const collapsed = group.id !== current.groupId;
        if (group.collapsed !== collapsed) await updateGroup(group.id,{collapsed});
      }
      if (!changed) return;
    } catch (error) {
      if (/no (?:window|tab group)|not found|does not exist/i.test(error.message || '')) return;
      if (!/cannot be edited|dragging|temporar|contains.*active tab|cannot collapse/i.test(error.message || '')) throw error;
    }
    // Short backoff handles the tab-strip edit lock during clicks/dragging.
    // The alarm is a durable fallback if that lock outlasts these retries.
    if (attempt < 3) await scheduler.postTask(()=>{}, {delay:100 * (attempt + 1)});
  }
  await alarm(`auto-collapse:${windowId}`,1000);
}
async function menus() {
  await chrome.contextMenus.removeAll();
  for (const [id, title] of [['settings', 'Settings'], ['group-domain', 'Group this window by domain'], ['group-source', 'Group this window by source tab'], ['undo', 'Undo last grouping change in this window'], ['pause', 'Pause / resume automatic grouping'], ['recovery', 'Recovery and backups'], ['whats-new', 'What’s new']]) {
    chrome.contextMenus.create({ id, title, contexts: ['action'] });
  }
}
async function status() {
  const data = await chrome.storage.local.get(['layout', 'history', 'recoveryBaseline', 'activity']);
  const state = await readState();
  const candidates = [data.layout, data.recoveryBaseline, ...(data.history || [])].filter(Boolean);
  const snapshots = [...new Map(candidates.map(snapshot => [snapshot.at, snapshot])).values()].sort((a, b) => b.at - a.at);
  return { recovering: state.recovering, activity: data.activity, snapshots: snapshots.map(snapshot => ({ at: snapshot.at, windows: snapshot.windows.length, tabs: snapshot.windows.reduce((n, win) => n + win.tabs.length, 0), groups: snapshot.windows.reduce((n, win) => n + win.groups.length, 0) })) };
}
async function popupCounts(windowId) {
  const windows = await normalWindows();
  const current = windows.find(win=>win.id === windowId);
  return {tabs:current ? current.tabs.length : (await chrome.tabs.query({windowId})).length,
    windows:windows.length,totalTabs:windows.reduce((total,win)=>total+win.tabs.length,0)};
}
async function handleMessage(message, sender) {
  if (message.type === 'popup-counts') return popupCounts(await messageWindow(message,sender));
  if (message.type === 'popup-init') {
    const windowId = await messageWindow(message, sender);
    const settings = await readSettings();
    return { ...(await listSavedSessions()), ...(await popupCounts(windowId)), enabled: settings.enabled, recovering: (await readState()).recovering, windowId };
  }
  if (message.type === 'sessions-list') return listSavedSessions(message.offset);
  if (message.type === 'session-get') return getSavedSession(message.id);
  if (message.type === 'session-rename') return renameSavedSession(message.id, message.name);
  if (message.type === 'session-delete') { await deleteSavedSession(message.id); return { deleted: true }; }
  if (message.type === 'session-tab-delete') return deleteSavedTab(message.id, message.tabIndex, message.revision);
  if (message.type === 'session-save') {
    if (typeof message.close !== 'boolean') throw new Error('Choose Save or Save & close.');
    return saveWindowSession(await messageWindow(message, sender), message.name, message.close);
  }
  if (message.type === 'session-restore') {
    if ((await readState()).recovering && message.here) throw new Error('Wait for browser recovery to finish before restoring into an existing window.');
    const result = await restoreSavedSession(message.id, message.here ? await messageWindow(message, sender) : undefined, message.tabIndex, async (id, activation) => {
      const state = await readState();
      if (activation === 'closing') { state.restoreClosures ??= {}; state.restoreClosures[id] = true; }
      else if (activation) { state.restoreActivations ??= {}; state.restoreActivations[id] = true; }
      else { state.restoredTabs ??= []; state.restoredTabs.push(id); }
      await writeState(state);
    }, message.revision);
    const state = await readState();
    if (state.recovering) { state.recoveryExcludedWindows ??= []; state.recoveryExcludedWindows.push(result.windowId); await writeState(state); }
    return result;
  }
  if (message.type === 'popup-action') {
    const windowId = await messageWindow(message, sender);
    if (message.action === 'merge-windows') return mergeWindows(windowId);
    if (['group-all','ungroup-all','collapse-all','expand-all','move-left-all','move-right-all'].includes(message.action)) return organizeAllWindows(message.action);
    if (message.action === 'group') return regroup(windowId);
    if (message.action === 'ungroup') return ungroupWindow(windowId);
    if (message.action === 'move-left' || message.action === 'move-right') return moveWindowGroups(windowId,message.action === 'move-left' ? 'left' : 'right');
    if (message.action === 'domain' || message.action === 'source') return regroup(windowId, message.action);
    if (message.action === 'undo') { await undoRegroup(windowId); return {}; }
    if (message.action === 'collapse' || message.action === 'expand') {
      await setManualExpansion(windowId,message.action === 'expand');
      const groups = await chrome.tabGroups.query({ windowId });
      for (const group of groups) await updateGroup(group.id, { collapsed: message.action === 'collapse' });
      await checkpoint(); return { groups: groups.length };
    }
    if (message.action === 'pause' || message.action === 'set-auto-group') {
      if (message.action === 'set-auto-group' && typeof message.enabled !== 'boolean') throw new Error('Choose whether automatic grouping is on or off.');
      const settings = await readSettings(); settings.enabled = message.action === 'pause' ? !settings.enabled : message.enabled;
      await chrome.storage.local.set({ settings }); return { enabled: settings.enabled };
    }
    if (['settings', 'recovery', 'whats-new'].includes(message.action)) {
      const hash = message.action === 'recovery' ? '#recovery' : message.action === 'whats-new' ? '#changelog' : '';
      await chrome.tabs.create({ windowId, url: chrome.runtime.getURL('options.html' + hash) }); return {};
    }
    throw new Error('Unknown popup action.');
  }
  if (message.type === 'status') return status();
  if (message.type === 'regroup' || message.type === 'undo') {
    if (!sender.tab) throw new Error('Open TABLA settings in the window you want to organize.');
    if (message.type === 'regroup') return regroup(sender.tab.windowId);
    await undoRegroup(sender.tab.windowId); return { undone: true };
  }
  if (message.type === 'save-settings') {
    const settings = settingsFrom(message.settings);
    if (settings.autoCollapse !== (await readSettings()).autoCollapse) {
      const state = await readState(); state.manualExpansion = {}; await writeState(state);
    }
    await chrome.storage.local.set({ settings });
    if (settings.focusExpandedGroup) await seedGroupFocus();
    if (settings.autoCollapse) await collapseFocusedWindow();
    await checkpoint();
    return { saved: true };
  }
  if (message.type === 'checkpoint') { await checkpoint(true); return status(); }
  if (message.type === 'repair') {
    if ((await readState()).recovering) throw new Error('Startup recovery is still running. Please try again shortly.');
    const { layout, history = [], recoveryBaseline } = await chrome.storage.local.get(['layout', 'history', 'recoveryBaseline']);
    const snapshot = [layout, recoveryBaseline, ...history].find(item => item?.at === message.at);
    if (!snapshot) throw new Error('That snapshot is no longer available. Refresh the recovery list.');
    await checkpoint(true);
    const result = await repair(snapshot, true);
    await checkpoint(); await feedback(`Recovered ${result.restored} groups on ${result.matched} matching tabs`);
    return result;
  }
  throw new Error('Unknown TABLA request.');
}
async function messageWindow(message, sender) {
  const id = sender.tab?.windowId ?? message.windowId;
  if (!Number.isInteger(id)) throw new Error('Open TABLA in a browser window.');
  const win = await chrome.windows.get(id);
  if (win.incognito || win.type !== 'normal') throw new Error('Choose a regular browser window.');
  return id;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  void (async () => {
    try { const result = await locked(async () => { await initialize(); return handleMessage(message, sender); }); sendResponse({ ok: true, result }); }
    catch (error) { sendResponse({ ok: false, error: error.message }); await failure(error); }
  })();
  return true;
});
chrome.runtime.onInstalled.addListener(details => run(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: settingsFrom(settings) });
  await menus();
  // Command-line/unpacked loads can report install again on a later launch.
  // Existing local settings identify an initialized profile: never overwrite its
  // protected layout or cancel recovery just because Chrome reports install.
  if (details.reason === 'install' && !settings) {
    const state = await readState(); state.recovering = false; await writeState(state);
    for (const win of await normalWindows()) for (const tab of win.tabs) await registerTab(tab, false);
    await checkpoint();
    await chrome.tabs.create({ url: chrome.runtime.getURL('options.html#welcome') });
  } else if (details.reason === 'update' && details.previousVersion !== chrome.runtime.getManifest().version) await chrome.tabs.create({ url: chrome.runtime.getURL('options.html#changelog') });
}, { reload: details.reason === 'update' }));
chrome.runtime.onStartup.addListener(() => run(async () => {
  const state = await readState();
  state.browserStartup = true;
  const { recoveryBaseline } = await chrome.storage.local.get('recoveryBaseline');
  // onInstalled can precede onStartup when an update happens during profile boot.
  // Re-arm genuine browser recovery even if the update path resumed first.
  if (!state.recovering && (await readSettings()).persist && recoveryBaseline?.windows?.length) {
    state.recovering = true; state.boot = Date.now(); state.changedAt = Date.now();
    await alarm('recover');
  }
  await writeState(state);
  await menus();
}));
chrome.commands.onCommand.addListener(command => run(async () => {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  if (command === 'group-window') await regroup(win.id);
  else if (command === 'undo-grouping') await undoRegroup(win.id);
}));
chrome.contextMenus.onClicked.addListener((info, tab) => run(async () => {
  const id = info.menuItemId;
  if (['settings', 'recovery', 'whats-new'].includes(id)) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html${id === 'recovery' ? '#recovery' : id === 'whats-new' ? '#changelog' : ''}`) }); return;
  }
  if (id === 'pause') {
    const settings = await readSettings(); settings.enabled = !settings.enabled;
    await chrome.storage.local.set({ settings }); await feedback(`Automatic grouping ${settings.enabled ? 'resumed' : 'paused'}`); return;
  }
  const windowId = tab?.windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
  if (id === 'undo') await undoRegroup(windowId);
  else await regroup(windowId, id === 'group-domain' ? 'domain' : 'source');
}));
chrome.tabs.onCreated.addListener(tab => run(async () => { await registerTab(tab, true); await tryAuto(tab.id); await touch(); }));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url || change.status || change.groupId !== undefined || change.pinned !== undefined || Object.hasOwn(change, 'favIconUrl')) run(async () => {
    await tryAuto(tabId);
    if (change.groupId !== undefined) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.active) { const state = await readState(); rememberGroupTab(state,tab); await writeState(state); await collapseInactive({windowId:tab.windowId}); }
      }
      catch (error) { if (!/no tab|not found/i.test(error.message || '')) throw error; }
    }
    if (Object.hasOwn(change, 'favIconUrl') || change.status === 'complete') {
      try { await refreshAutoColor(await chrome.tabs.get(tabId)); } catch { /* Tab may have closed. */ }
    }
    await touch();
  });
});
chrome.tabs.onMoved.addListener(() => run(touch));
chrome.tabs.onAttached.addListener(() => run(touch));
chrome.tabs.onDetached.addListener(() => run(touch));
chrome.tabs.onReplaced.addListener((addedId, removedId) => run(async () => {
  const state = await readState();
  for (const [windowId,id] of Object.entries(state.manualExpansion || {})) if (id === removedId) state.manualExpansion[windowId] = addedId;
  for (const [group,id] of Object.entries(state.groupLastActive || {})) if (id === removedId) state.groupLastActive[group] = addedId;
  if (state.records[removedId]) state.records[addedId] = state.records[removedId];
  if (state.pending[removedId]) state.pending[addedId] = state.pending[removedId];
  delete state.records[removedId]; delete state.pending[removedId]; await writeState(state); await touch();
}));
chrome.tabs.onRemoved.addListener((tabId, info) => run(async () => {
  const state = await readState(); delete state.pending[tabId]; delete state.records[tabId];
  for (const [group,id] of Object.entries(state.groupLastActive || {})) if (id === tabId) delete state.groupLastActive[group];
  const restoreCleanup = Boolean(state.restoreClosures?.[tabId]);
  if (state.restoreClosures) delete state.restoreClosures[tabId];
  if (state.restoreActivations) delete state.restoreActivations[tabId];
  if (state.restoredTabs) state.restoredTabs = state.restoredTabs.filter(id => id !== tabId);
  if (info.isWindowClosing) {
    const { layout, closingBackup } = await chrome.storage.local.get(['layout', 'closingBackup']);
    if (layout && (!closingBackup || Date.now() - closingBackup.closedAt > 30000)) {
      await chrome.storage.local.set({ closingBackup: { closedAt: Date.now(), layout } });
    }
    if (!state.closing.includes(info.windowId)) state.closing.push(info.windowId);
    await writeState(state); return;
  }
  await writeState(state);
  if (!restoreCleanup && !state.recovering && (await readSettings()).removeSingle) {
    for (const group of await chrome.tabGroups.query({ windowId: info.windowId })) {
      const tabs = await chrome.tabs.query({ groupId: group.id });
      if (tabs.length === 1) await chrome.tabs.ungroup(tabs[0].id);
    }
  }
  await touch();
}));
chrome.windows.onRemoved.addListener(windowId => run(async () => {
  const state = await readState(); state.closing = state.closing.filter(id => id !== windowId);
  if (state.manualExpansion) delete state.manualExpansion[windowId];
  if (state.recoveryChoices) delete state.recoveryChoices[windowId];
  if (state.recoveryExcludedWindows) state.recoveryExcludedWindows = state.recoveryExcludedWindows.filter(id=>id !== windowId);
  await writeState(state);
  // Leave the last full snapshot intact on close. A later live change checkpoints
  // the remaining windows; the history still contains the complete closed layout.
}));
chrome.tabs.onActivated.addListener(info => run(async () => {
  const state = await readState(); state.activeTabs ??= {}; state.activeTabs[info.windowId] = info.tabId;
  if (state.manualExpansion?.[info.windowId] !== undefined) {
    const [selected] = await chrome.tabs.query({windowId:info.windowId,active:true});
    if (selected && state.manualExpansion[info.windowId] !== selected.id) delete state.manualExpansion[info.windowId];
  }
  try { rememberGroupTab(state,await chrome.tabs.get(info.tabId)); } catch { /* The selected tab may already be closed. */ }
  await writeState(state);
  if (state.restoreActivations?.[info.tabId]) { delete state.restoreActivations[info.tabId]; await writeState(state); return; }
  await collapseInactive(info);
}));
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) run(()=>collapseInactive({windowId}));
});
chrome.tabGroups.onCreated.addListener(group => run(async()=>{
  const state = await readState(); state.groupCollapsed ??= {}; state.groupCollapsed[group.id] = group.collapsed;
  const [active] = await chrome.tabs.query({windowId:group.windowId,active:true}); rememberGroupTab(state,active);
  await writeState(state); await touch();
}));
chrome.tabGroups.onUpdated.addListener(group => run(()=>groupUpdated(group)));
chrome.tabGroups.onMoved.addListener(()=>run(touch));
chrome.tabGroups.onRemoved.addListener(group => run(async () => {
  const state = await readState();
  for (const key of ['groupCollapsed','groupLastActive','ignoreGroupExpand']) if (state[key]) delete state[key][group.id];
  await writeState(state); await forgetAutoColorGroup(group.id); await touch();
}));
chrome.alarms.onAlarm.addListener(event => run(async () => {
  if (event.name.startsWith('auto-collapse:')) {
    await collapseInactive({windowId:Number(event.name.slice('auto-collapse:'.length))}); return;
  }
  if (event.name === 'recover') {
    try { await recover(); }
    catch (error) {
      const state = await readState();
      if (Date.now() - state.boot < 120000) await alarm('recover', 10000);
      else { state.recovering = false; await writeState(state); }
      throw error;
    }
  }
  else if (event.name === 'checkpoint') await checkpoint();
  else if (event.name === 'clear-badge') {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: chrome.runtime.getManifest().name });
  }
}));
