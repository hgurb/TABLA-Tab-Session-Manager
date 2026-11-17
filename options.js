import { DEFAULTS, settingsFrom } from './core.js';
import { SECTIONS, exportSettings, importSettings } from './transfer.js';

const $ = selector => document.querySelector(selector);
const form = $('#settings');
let saved = structuredClone(DEFAULTS);
let dirty = false;
let editRevision = 0;
let saving = false;
let importReady = false;
let selectedSnapshot;
const booleanKeys = Object.keys(DEFAULTS).filter(key => typeof DEFAULTS[key] === 'boolean');
async function send(type, data = {}) {
  const reply = await chrome.runtime.sendMessage({ type, ...data });
  if (!reply?.ok) throw new Error(reply?.error || 'TABLA did not respond. Reload the extension and try again.');
  return reply.result;
}
function status(text, error = false) { $('#status').textContent = text; $('#status').classList.toggle('error', error); }
function notice(text, error = false) { dirty = true; editRevision++; invalidateExport(); status(text || 'Unsaved changes', error); }
function setImportReady(ready) { importReady = ready; $('#import-save').disabled = saving || !ready; }
function refreshControls() {
  $('#toolbar-override').disabled = $('#toolbarFollow').checked;
  $('#combineExisting').disabled = $('#groupBy').value !== 'domain';
  $('#grouping-summary').textContent = !$('#enabled').checked ? 'Paused' : $('#groupBy').value === 'domain' ? 'Same domain' : 'Same opening tab';
  $('#rule-count').textContent = `${$('#rules').children.length} rules`;
  $('#rules-empty').hidden = Boolean($('#rules').children.length);
  const count = $('#exclusions').value.split(/\r?\n/).filter(line => line.trim()).length;
  $('#exclusion-count').textContent = `${count} websites`;
}
function addRule(rule = { host: '', name: '', color: 'auto' }) {
  const row = $('#rule-template').content.firstElementChild.cloneNode(true);
  row.querySelector('.rule-host').value = rule.host;
  row.querySelector('.rule-name').value = rule.name;
  row.querySelector('.rule-color').value = rule.color;
  const id = crypto.randomUUID();
  for (const [index, label] of [...row.querySelectorAll('label')].entries()) {
    const control = label.querySelector('input,select'); control.id = `rule-${id}-${index}`; label.htmlFor = control.id;
  }
  row.querySelector('.remove-rule').addEventListener('click', () => {
    row.remove(); refreshControls(); notice(); $('#add-rule').focus();
  });
  $('#rules').append(row); refreshControls();
  return row;
}
function fill(settings) {
  for (const key of booleanKeys) $(`#${key}`).checked = settings[key];
  for (const key of ['groupBy', 'naming', 'maxTabs']) $(`#${key}`).value = settings[key];
  $(`input[name="toolbarMode"][value="${settings.toolbarMode}"]`).checked = true;
  $('#rules').replaceChildren();
  for (const rule of settings.rules) addRule(rule);
  $('#exclusions').value = settings.exclusions.join('\n');
  refreshControls();
}
function readRaw() {
  const settings = {};
  for (const key of booleanKeys) settings[key] = $(`#${key}`).checked;
  for (const key of ['groupBy', 'naming']) settings[key] = $(`#${key}`).value;
  settings.maxTabs = Number($('#maxTabs').value);
  settings.toolbarMode = $('input[name="toolbarMode"]:checked').value;
  settings.rules = [...$('#rules').children].map(row => ({ host: row.querySelector('.rule-host').value, name: row.querySelector('.rule-name').value, color: row.querySelector('.rule-color').value }));
  settings.exclusions = $('#exclusions').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return settings;
}
const read = () => settingsFrom(readRaw());
form.addEventListener('input', () => { refreshControls(); notice(); });
form.addEventListener('change', () => { refreshControls(); notice(); });
form.addEventListener('submit', async event => {
  event.preventDefault(); saving = true; $('#save').disabled = true; setImportReady(importReady);
  const revision = editRevision;
  try {
    const settings = read(); await send('save-settings', { settings }); saved = settings;
    if (revision === editRevision) {
      fill(saved); dirty = false; status('Settings saved');
      if (!$('#import-notice').hidden) $('#transfer-status').textContent = 'Imported settings saved.';
      setImportReady(false); $('#import-notice').hidden = true;
    } else status('Saved. Your newer changes are still unsaved.');
  }
  catch (error) { status(error.message, true); }
  finally { saving = false; $('#save').disabled = false; setImportReady(importReady); }
});
$('#discard').addEventListener('click', () => { fill(saved); dirty = false; editRevision++; invalidateExport(); setImportReady(false); $('#import-notice').hidden = true; $('#transfer-status').textContent = ''; status('Changes discarded'); });
$('#reset').addEventListener('click', () => { fill(structuredClone(DEFAULTS)); setImportReady(false); $('#import-notice').hidden = true; notice('Defaults loaded. Click Save to apply.'); });
$('#add-rule').addEventListener('click', () => { const row = addRule(); row.querySelector('input').focus(); notice(); });
for (const [id, type] of [['group-now', 'regroup'], ['undo-now', 'undo']]) $( `#${id}`).addEventListener('click', async () => {
  try { await send(type); status(type === 'regroup' ? 'Current window organized' : 'Last grouping change undone'); }
  catch (error) { status(error.message, true); }
});
window.addEventListener('beforeunload', event => { if (dirty) event.preventDefault(); });

const transferText = $('#transfer-text');
const transferStatus = $('#transfer-status');
const exportButton = $('#export');
const copyButton = $('#copy-transfer');
const exportBoxes = [...document.querySelectorAll('[data-export-section]')];
let copying = false, exporting = false, exportFresh = false, exportRevision = 0, copyFeedback;
function updateCopyButton() { copyButton.disabled = copying || !transferText.value; }
function updateExportButton() { exportButton.disabled = exporting || exportFresh || !exportBoxes.some(box => box.checked); }
function invalidateExport() { exportRevision++; exportFresh = false; updateExportButton(); }
exportBoxes.forEach(box => box.addEventListener('change', invalidateExport));
transferText.addEventListener('input', () => { setImportReady(false); invalidateExport(); updateCopyButton(); });
updateExportButton();
copyButton.addEventListener('click', async () => {
  const text = transferText.value; if (!text) return;
  copying = true; updateCopyButton();
  try {
    await navigator.clipboard.writeText(text); transferStatus.textContent = 'Copied to clipboard.';
    copyFeedback?.cancel();
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    copyFeedback = transferStatus.animate([
      { color: 'var(--copy-confirmation-color)', textShadow: reducedMotion ? 'none' : '0 0 8px var(--copy-confirmation-color)' },
      { color: getComputedStyle(transferStatus).color, textShadow: 'none' }
    ], { duration: 800, easing: 'ease-out' });
  } catch {
    if (transferText.value === text) { transferText.focus(); transferText.select(); }
    transferStatus.textContent = 'Clipboard access failed. Copy the text manually or try again.';
  } finally { copying = false; updateCopyButton(); }
});
$('#export').addEventListener('click', async () => {
  let exported;
  try {
    exported = exportSettings(readRaw(), exportBoxes.filter(box => box.checked).map(box => box.dataset.exportSection));
    transferText.value = exported; updateCopyButton(); setImportReady(false);
  } catch (error) { transferStatus.textContent = error.message; return; }
  const revision = exportRevision; exporting = true; updateExportButton();
  try {
    await navigator.clipboard.writeText(exported);
    exportFresh = exportRevision === revision && transferText.value === exported;
    transferStatus.textContent = 'Export generated and copied to the clipboard.';
  } catch {
    exportFresh = false;
    if (transferText.value === exported) { transferText.focus(); transferText.select(); }
    transferStatus.textContent = 'Export generated. Clipboard access failed; copy the selected string manually or try Export again.';
  } finally { exporting = false; updateExportButton(); }
});
$('#import').addEventListener('click', () => {
  setImportReady(false);
  try {
    const { patch, names } = importSettings(transferText.value);
    fill({ ...readRaw(), ...patch }); notice('Import loaded. Review and click Save.');
    setImportReady(true); $('#import-notice').hidden = false;
    transferStatus.textContent = 'Loaded ' + names.map(name => SECTIONS[name].label).join(', ') + ' for review.';
  } catch (error) { transferStatus.textContent = error.message; }
});
async function refreshRecovery() {
  try {
    const data = await send('status'); $('#snapshots').replaceChildren();
    $('#recovery-status').textContent = data.recovering ? 'Startup recovery is running. Waiting for Chrome to finish restoring your tabs (up to two minutes).' : data.activity?.text || 'Snapshots are saved locally as your tabs change.';
    if (!data.snapshots.length) $('#recovery-status').textContent += ' No snapshots yet.';
    for (const snapshot of data.snapshots) {
      const row = document.createElement('div'); row.className = 'snapshot';
      const info = document.createElement('div');
      const date = document.createElement('p'); date.textContent = new Date(snapshot.at).toLocaleString();
      const details = document.createElement('p'); details.className = 'note'; details.textContent = `${snapshot.windows} windows · ${snapshot.tabs} tabs · ${snapshot.groups} groups`;
      info.append(date, details);
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Repair groups'; button.disabled = data.recovering;
      button.setAttribute('aria-label', `Repair groups from ${date.textContent}`);
      button.addEventListener('click', () => {
        selectedSnapshot = snapshot.at; $('#repair-description').textContent = `${date.textContent} — ${details.textContent}`; $('#repair-dialog').showModal();
      });
      row.append(info, button); $('#snapshots').append(row);
    }
  } catch (error) { $('#recovery-status').textContent = error.message; }
}
$('#refresh-recovery').addEventListener('click', refreshRecovery);
$('#checkpoint').addEventListener('click', async () => {
  try { await send('checkpoint'); await refreshRecovery(); } catch (error) { $('#recovery-status').textContent = error.message; }
});
$('#cancel-repair').addEventListener('click', () => $('#repair-dialog').close());
$('#confirm-repair').addEventListener('click', async () => {
  $('#confirm-repair').disabled = true;
  try {
    const result = await send('repair', { at: selectedSnapshot }); $('#repair-dialog').close();
    await refreshRecovery(); $('#recovery-status').textContent = `Repaired ${result.restored} groups on ${result.matched} matching tabs. No tabs were opened or closed.`;
  } catch (error) { $('#repair-dialog').close(); $('#recovery-status').textContent = error.message; }
  finally { $('#confirm-repair').disabled = false; }
});
function openHash() {
  const id = location.hash.slice(1);
  if (!['changelog', 'recovery', 'welcome'].includes(id)) return;
  const target = document.getElementById(id);
  if (target.tagName === 'DETAILS') target.open = true;
  requestAnimationFrame(() => target.scrollIntoView());
  if (id === 'recovery') void refreshRecovery();
}
window.addEventListener('hashchange', openHash);
$('#recovery').addEventListener('toggle', () => { if ($('#recovery').open) void refreshRecovery(); });
new ResizeObserver(entries => document.documentElement.style.setProperty('--toolbar-height', `${entries[0].borderBoxSize[0].blockSize}px`)).observe($('.settings-toolbar'));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) {
    if (saving) { saved = settingsFrom(changes.settings.newValue); return; }
    if (dirty) { status('Saved settings changed elsewhere. Save to replace them, or Discard to reload.'); saved = settingsFrom(changes.settings.newValue); }
    else { saved = settingsFrom(changes.settings.newValue); fill(saved); }
  }
});
try {
  saved = settingsFrom((await chrome.storage.local.get('settings')).settings); fill(saved); status('All changes saved'); openHash();
} catch (error) { status(error.message, true); }
