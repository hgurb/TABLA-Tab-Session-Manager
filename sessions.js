import { sessionDate, sessionLabel } from './session-format.js';
const $ = selector => document.querySelector(selector);
let summaries = [], selected, busy = false, loaded = 0, shown = 0, windowId, pendingRefresh = false;
const tabMenu = document.createElement('div'); tabMenu.id = 'link-actions'; tabMenu.popover = 'auto'; tabMenu.setAttribute('role','menu'); tabMenu.setAttribute('aria-label','Saved link actions'); document.body.append(tabMenu);
let menuTrigger, menuTab, menuFocusReturn, confirmLinkDelete = false;
function closeTabMenu(focus = false) {
  if (focus && menuTrigger?.isConnected) {if(busy) menuFocusReturn = menuTrigger; else menuTrigger.focus({preventScroll:true});}
  if (tabMenu.matches(':popover-open')) tabMenu.hidePopover();
  menuTrigger?.setAttribute('aria-expanded','false');
}
function positionTabMenu() {
  const rect = menuTrigger.getBoundingClientRect(), size = tabMenu.getBoundingClientRect();
  tabMenu.style.left = `${Math.max(8,Math.min(rect.left,innerWidth-size.width-8))}px`;
  tabMenu.style.top = `${Math.max(8,rect.bottom+size.height+8<=innerHeight ? rect.bottom+4 : rect.top-size.height-4)}px`;
}
function openTabMenu(trigger, tabIndex, keyboard) {
  if (busy) return;
  if (menuTrigger === trigger && tabMenu.matches(':popover-open')) {closeTabMenu(true);return;}
  closeTabMenu(); menuTrigger = trigger; menuTab = {id:selected.id, index:tabIndex, revision:selected.revision || 0};
  confirmLinkDelete = false; deleteLink.textContent = 'Delete from session'; cancelLink.hidden = true;
  tabMenu.showPopover(); positionTabMenu(); trigger.setAttribute('aria-expanded','true');
  if (keyboard) tabMenu.querySelector('button').focus();
}
function menuButton(text, action, className = '') {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.className = className; button.setAttribute('role','menuitem'); button.tabIndex = -1;
  button.addEventListener('click', () => {void act(action);}); tabMenu.append(button); return button;
}
for (const [text, here] of [['Restore in new window',false],['Restore here',true]]) menuButton(text, async () => {
  const target = menuTab; closeTabMenu(true);
  const result = await send('session-restore',{id:target.id,here,tabIndex:target.index,revision:target.revision}); status(`Restored ${result.tabs} tab. Saved session kept.`);
});
const deleteLink = menuButton('Delete from session', async () => {
  if (!confirmLinkDelete) {confirmLinkDelete = true; deleteLink.textContent = 'Delete this link?'; cancelLink.hidden = false; positionTabMenu(); return;}
  const target = menuTab; closeTabMenu(true);
  await send('session-tab-delete',{id:target.id,tabIndex:target.index,revision:target.revision});
  await load(); await choose(); status('Link deleted from saved session.');
},'delete');
const cancelLink = menuButton('Cancel', async () => closeTabMenu(true)); cancelLink.hidden = true;
tabMenu.addEventListener('toggle', event => {if(event.newState === 'closed') menuTrigger?.setAttribute('aria-expanded','false');});
tabMenu.addEventListener('keydown', event => {
  if (event.key === 'Escape' || event.key === 'Tab') {if(event.key === 'Escape'){event.preventDefault();event.stopPropagation();}closeTabMenu(true);return;}
  if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
  event.preventDefault(); const items = [...tabMenu.querySelectorAll('button')].filter(b=>!b.hidden&&!b.disabled), index = items.indexOf(document.activeElement);
  items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length-1 : (index+(event.key==='ArrowUp'?-1:1)+items.length)%items.length]?.focus();
});
window.addEventListener('resize', () => closeTabMenu());
document.addEventListener('scroll', event => {if(!tabMenu.contains(event.target)) closeTabMenu();},true);
document.addEventListener('focusin', event => {if(tabMenu.matches(':popover-open') && event.target !== menuTrigger && !tabMenu.contains(event.target)) closeTabMenu();});
function status(text, error = false) { $('#status').textContent = text; $('#status').classList.toggle('error', error); }
async function send(type, data = {}) { const reply = await chrome.runtime.sendMessage({type, windowId, ...data}); if (!reply?.ok) throw new Error(reply?.error || 'TABLA did not respond.'); return reply.result; }
async function act(task) { if (busy) return; busy = true; document.querySelectorAll('button:not(#theme-toggle)').forEach(b => b.disabled = true); try { await task(); } catch (e) { status(e.message, true); } finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); if (menuFocusReturn?.isConnected) menuFocusReturn.focus({preventScroll:true}); menuFocusReturn = undefined; if (pendingRefresh) { pendingRefresh = false; void act(async () => {await load(); await choose();});} } }
function renderSidebar() {
  const query = $('#session-search').value.toLocaleLowerCase(); $('#session-list').replaceChildren();
  for (const item of summaries.filter(s => sessionLabel(s).toLocaleLowerCase().includes(query))) {
    const row = document.createElement('div'); row.className = 'session-nav-row';
    const link = document.createElement('a'); link.href = `#${encodeURIComponent(item.id)}`; link.className = 'session-nav';
    if (item.id === selected?.id) link.setAttribute('aria-current','page');
    const name = document.createElement('span'); name.textContent = sessionLabel(item);
    const meta = document.createElement('small'); meta.textContent = `${item.tabs} tabs · ${sessionDate(item.at)}`; link.append(name, meta);
    const actions = document.createElement('div'); actions.className = 'sidebar-session-actions';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'sidebar-delete delete'; remove.textContent = 'Delete'; remove.setAttribute('aria-label', `Delete ${item.name}`);
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'sidebar-cancel'; cancel.textContent = 'Cancel'; cancel.hidden = true;
    let confirming = false;
    remove.addEventListener('click', () => act(async () => {
      if (!confirming) { confirming = true; remove.textContent = 'Delete?'; remove.setAttribute('aria-label', `Confirm deletion of ${item.name}`); cancel.hidden = false; return; }
      await send('session-delete', {id:item.id});
      if (selected?.id === item.id) history.replaceState(null,'',location.pathname);
      await load(); await choose(); status('Saved session deleted.');
    }));
    cancel.addEventListener('click', () => {confirming = false; remove.textContent = 'Delete'; remove.setAttribute('aria-label', `Delete ${item.name}`); cancel.hidden = true; remove.focus();});
    actions.append(remove, cancel); row.append(link, actions); $('#session-list').append(row);
  }
}
async function load(append = false) {
  const data = await send('sessions-list', {offset: append ? loaded : 0});
  summaries = append ? [...summaries, ...data.sessions] : data.sessions; loaded = summaries.length;
  $('#total').textContent = data.total; $('#load-more').hidden = !data.hasMore; renderSidebar();
}
function renderTabs(append = false) {
  if (!append) { closeTabMenu(); shown = 0; $('#tab-list').replaceChildren(); }
  const query = $('#tab-search').value.toLocaleLowerCase();
  const tabs = selected.tabs.map((tab,index) => ({...tab,index})).filter(t => `${t.title} ${t.url}`.toLocaleLowerCase().includes(query));
  const end = Math.min(shown + 100,tabs.length);
  for (; shown < end; shown++) {
    const tab = tabs[shown], item = document.createElement('li'), button = document.createElement('a'); button.className = 'tab-link'; button.href = tab.url; button.target = '_blank'; button.rel = 'noopener';
    const more = document.createElement('button'); more.type = 'button'; more.className = 'tab-more'; more.textContent = '⋮'; more.setAttribute('aria-label', `Actions for ${tab.title || tab.url}`); more.setAttribute('aria-haspopup','menu'); more.setAttribute('aria-expanded','false'); more.setAttribute('aria-controls',tabMenu.id);
    more.addEventListener('click', event => openTabMenu(more,tab.index,event.detail===0));
    more.addEventListener('keydown', event => {if(event.key==='ArrowDown'){event.preventDefault();openTabMenu(more,tab.index,true);}});
    const icon = document.createElement('span'); icon.className = 'site-icon'; icon.textContent = new URL(tab.url).hostname.slice(0,1).toUpperCase(); icon.setAttribute('aria-hidden','true');
    const text = document.createElement('span'), title = document.createElement('span'), url = document.createElement('small'); title.textContent = tab.title || tab.url; url.textContent = tab.url; text.append(title,url);
    const group = selected.groups.find(g => g.id === tab.group), tag = document.createElement('span'); tag.className = 'tab-tag'; tag.textContent = tab.pinned ? 'Pinned' : group ? group.title || 'Unnamed group' : '';
    button.append(icon,text,tag);
    button.addEventListener('click', event => {event.preventDefault();void act(() => restore(true,tab.index));});
    button.addEventListener('mousedown', event => {if(event.button===1)event.preventDefault();});
    button.addEventListener('auxclick', event => {if(event.button===1){event.preventDefault();void act(() => restore(true,tab.index));}});
    item.append(more,button); $('#tab-list').append(item);
  }
  $('#more-tabs').hidden = shown >= tabs.length;
}
async function choose() {
  const id = decodeURIComponent(location.hash.slice(1)) || (summaries.some(item => item.id === selected?.id) ? selected.id : summaries[0]?.id);
  if (!id) { selected = undefined; $('#detail').hidden = true; $('#empty').hidden = false; renderSidebar(); return; }
  const session = await send('session-get',{id}); selected = session;
  $('#detail').hidden = false; $('#empty').hidden = true; $('#confirm').hidden = true;
  $('#detail-title').textContent = sessionLabel(session); $('#rename-name').value = sessionLabel(session);
  $('#detail-meta').textContent = `${session.tabs.length} tabs · ${session.groups.length} groups · ${sessionDate(session.at)}`;
  $('#tab-search').value = ''; document.title = `${sessionLabel(session)} | TABLA`; renderSidebar(); renderTabs();
}
async function restore(here, tabIndex) { const result = await send('session-restore',{id:selected.id,here,...(tabIndex === undefined ? {} : {tabIndex,revision:selected.revision || 0})}); status(`Restored ${result.tabs} tab${result.tabs === 1 ? '' : 's'}. Saved session kept.`); }
$('#restore-new').addEventListener('click', () => act(() => restore(false)));
$('#restore-here').addEventListener('click', () => act(() => restore(true)));
$('#rename-form').addEventListener('submit', e => {e.preventDefault(); void act(async () => {const name = await send('session-rename',{id:selected.id,name:$('#rename-name').value}); selected.name = name; $('#detail-title').textContent = name; const summary = summaries.find(s => s.id === selected.id); if (summary) summary.name = name; renderSidebar(); status('Session renamed.');});});
$('#delete-session').addEventListener('click', () => {$('#confirm').hidden = false; $('#cancel-delete').focus();});
$('#cancel-delete').addEventListener('click', () => {$('#confirm').hidden = true; $('#delete-session').focus();});
$('#confirm-delete').addEventListener('click', () => act(async () => {await send('session-delete',{id:selected.id}); history.replaceState(null,'',location.pathname); await load(); await choose(); status('Saved session deleted.');}));
$('#load-more').addEventListener('click', () => act(() => load(true)));
$('#more-tabs').addEventListener('click', () => renderTabs(true));
$('#session-search').addEventListener('input', renderSidebar); $('#tab-search').addEventListener('input', () => {if (selected) renderTabs();});
window.addEventListener('hashchange', () => {if (busy) pendingRefresh = true; else void act(choose);});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.savedSessionIndex) return;
  const id = decodeURIComponent(location.hash.slice(1));
  if (id && !changes.savedSessionIndex.newValue?.some(item => item.id === id)) history.replaceState(null,'',location.pathname);
  if (busy) pendingRefresh = true;
  else void act(async () => {await load(); await choose();});
});
try { windowId = (await chrome.windows.getCurrent()).id; await load(); await choose(); } catch (e) { status(e.message,true); }
