import { sessionDate, sessionLabel } from './session-format.js';
const $ = selector => document.querySelector(selector);
let windowId, busy = false, recovering = false, autoGroupReady = false, autoGroupEnabled = true;
let statusTimer, statusClearTimer;
let countsTimer;
const recoveryNotice = 'Browser group recovery is running.';
function status(text, error = false, persistent = false) {
  clearTimeout(statusTimer); clearTimeout(statusClearTimer);
  const element = $('#status'); element.textContent = text; element.title = text;
  element.classList.toggle('error', error); element.classList.remove('status-faded');
  if (persistent) return;
  statusTimer = setTimeout(() => {
    element.classList.add('status-faded');
    statusClearTimer = setTimeout(() => {
      if (recovering) status(recoveryNotice, false, true);
      else { element.textContent = ''; element.removeAttribute('title'); }
    }, 250);
  }, 3000);
}
async function send(type, data = {}) {
  const reply = await chrome.runtime.sendMessage({ type, windowId, ...data });
  if (!reply?.ok) throw new Error(reply?.error || 'TABLA did not respond. Reopen the menu and try again.');
  return reply.result;
}
function syncAutoGrouping(enabled) {
  autoGroupEnabled = enabled; $('#auto-group-toggle').checked = enabled;
  $('#pause').textContent = `${enabled ? 'Pause' : 'Resume'} automatic grouping`;
}
function controls() {
  for (const button of document.querySelectorAll('button:not(#theme-toggle)')) button.disabled = busy || (recovering && ['group','ungroup','domain','source','undo','group-all','ungroup-all','merge-windows'].includes(button.dataset.action));
  $('#auto-group-toggle').disabled = busy || !autoGroupReady;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings?.newValue) syncAutoGrouping(changes.settings.newValue.enabled !== false);
  if (area !== 'session' || !changes.engine?.newValue) return;
  const next = Boolean(changes.engine.newValue.recovering);
  if (next === recovering) return;
  recovering = next; controls();
  status(next ? recoveryNotice : 'Browser group recovery finished.', false, next);
});
async function act(task) { if (busy) return; busy = true; controls(); try { await task(); } catch (error) { status(error.message, true); } finally { busy = false; controls(); } }
function showCounts(data) {
  const label = (count,noun)=>`${count} ${noun}${count === 1 ? '' : 's'}`;
  $('#window-info').textContent = label(data.tabs,'tab');
  $('#all-windows-info').textContent = `${label(data.windows,'window')} ・ ${label(data.totalTabs,'tab')}`;
}
function scheduleCounts() {
  if (!Number.isInteger(windowId)) return;
  clearTimeout(countsTimer);
  countsTimer = setTimeout(async()=>{try { showCounts(await send('popup-counts')); } catch { /* Keep the last counts if the browser is closing. */ }},80);
}
for (const event of [chrome.tabs.onCreated,chrome.tabs.onRemoved,chrome.tabs.onAttached,chrome.tabs.onDetached,chrome.windows.onCreated,chrome.windows.onRemoved]) event.addListener(scheduleCounts);
async function refresh() {
  const data = await send('popup-init'); recovering = data.recovering;
  showCounts(data); $('#session-count').textContent = data.total;
  syncAutoGrouping(data.enabled); autoGroupReady = true;
  $('#more-sessions').hidden = data.total <= 3;
  $('#empty').hidden = data.total > 0; $('#sessions').replaceChildren();
  for (const session of data.sessions.slice(0, 3)) {
    const row = document.createElement('div'); row.className = 'session';
    const link = document.createElement('a'); link.className = 'session-open'; link.href = `sessions.html#${encodeURIComponent(session.id)}`; link.target = '_blank';
    const name = document.createElement('span'); name.className = 'session-name'; name.textContent = sessionLabel(session);
    const meta = document.createElement('small'); meta.textContent = `${session.tabs} tabs · ${sessionDate(session.at)}`;
    link.append(name, meta);
    const actions = document.createElement('div'); actions.className = 'session-actions';
    const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'session-restore'; restore.textContent = 'Restore';
    restore.title = 'Restore in a new window'; restore.setAttribute('aria-label', `Restore ${session.name} in a new window`);
    restore.addEventListener('click', () => act(async () => {
      const result = await send('session-restore', {id: session.id, here: false});
      status(`Restored ${result.tabs} tabs in a new window. Saved session kept.`);
    }));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'session-delete delete'; remove.textContent = 'Delete'; remove.setAttribute('aria-label', `Delete ${session.name}`);
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'session-cancel'; cancel.textContent = 'Cancel'; cancel.hidden = true;
    let confirming = false;
    remove.addEventListener('click', () => act(async () => {
      if (!confirming) { confirming = true; remove.textContent = 'Delete?'; remove.setAttribute('aria-label', `Confirm deletion of ${session.name}`); cancel.hidden = false; return; }
      await send('session-delete', {id: session.id}); await refresh(); status('Saved session deleted.');
    }));
    cancel.addEventListener('click', () => { confirming = false; remove.textContent = 'Delete'; remove.setAttribute('aria-label', `Delete ${session.name}`); cancel.hidden = true; remove.focus(); });
    actions.append(restore, remove, cancel); row.append(link, actions); $('#sessions').append(row);
  }
  controls();
}
for (const control of document.querySelectorAll('[data-action]')) control.addEventListener('click', () => act(async () => {
  const action = control.dataset.action, result = await send('popup-action', { action });
  if (['settings','recovery','whats-new'].includes(action)) { window.close(); return; }
  if (action === 'merge-windows') {
    await refresh();
    status(`${result.tabs ? `Merged ${result.tabs} tabs from ${result.windows} windows.` : result.errors.length ? 'No windows merged.' : 'No other windows to merge.'}${result.errors.length ? ` Merge incomplete: ${result.errors[0]}` : ''}`,result.errors.length>0);
  }
  else if (action.endsWith('-all')) {
    const verb = {'group-all':'Grouped','ungroup-all':'Ungrouped','collapse-all':'Collapsed','expand-all':'Expanded','move-left-all':'Moved','move-right-all':'Moved'}[action];
    const count = action === 'ungroup-all' ? `${result.tabs} tabs` : `${result.groups} groups`;
    const side = action === 'move-left-all' ? ' left' : action === 'move-right-all' ? ' right' : '';
    status(`${verb} ${count}${side} in ${result.windows} windows.${result.errors.length ? ` ${result.errors.length} windows failed: ${result.errors[0]}` : ''}`, result.errors.length > 0);
  }
  else if (action === 'pause') { syncAutoGrouping(result.enabled); status(`Automatic grouping ${result.enabled ? 'resumed' : 'paused'}.`); }
  else if (action === 'collapse' || action === 'expand') status(`${result.groups} groups ${action === 'collapse' ? 'collapsed' : 'expanded'}.`);
  else if (action === 'move-left' || action === 'move-right') status(!result.groups ? 'No groups to move.' : result.moved ? `Moved ${result.groups} groups ${action === 'move-left' ? 'left' : 'right'}.` : 'Groups are already on that side.');
  else if (action === 'ungroup') status(result.tabs ? `Ungrouped ${result.tabs} tab${result.tabs === 1 ? '' : 's'} in this window.` : 'No groups to ungroup.');
  else status(action === 'undo' ? 'Last grouping change undone.' : 'Window grouped.');
}));
$('#auto-group-toggle').addEventListener('change', () => {
  const toggle = $('#auto-group-toggle'), enabled = toggle.checked;
  if (busy) { $('#auto-group-toggle').checked = autoGroupEnabled; return; }
  const restoreFocus = document.activeElement === toggle;
  void (async () => {
    await act(async () => {
      try {
        const result = await send('popup-action',{action:'set-auto-group',enabled}); syncAutoGrouping(result.enabled);
        status(`Automatic grouping ${result.enabled ? 'resumed' : 'paused'}.`);
      } finally { toggle.checked = autoGroupEnabled; }
    });
    if (restoreFocus) toggle.focus({preventScroll:true});
  })();
});
for (const [id, close] of [['save-session',false],['save-close-session',true]]) $(`#${id}`).addEventListener('click', () => act(async () => {
  const result = await send('session-save', { name: $('#session-name').value, close });
  $('#session-name').value = ''; await refresh(); status(result.closeError || `Saved ${result.tabs} tabs${close ? `; closed ${result.closed}` : ''}.`, Boolean(result.closeError));
}));
try { windowId = (await chrome.windows.getCurrent()).id; await refresh(); if (recovering) status(recoveryNotice, false, true); } catch (error) { status(error.message, true); }
