import { parse } from './vendor/tldts.js';

export const COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'];
export const DEFAULTS = Object.freeze({
  enabled: true, groupBy: 'domain', naming: 'domain', combineExisting: false,
  maxTabs: 0, removeSingle: true, removeSingleOnMove: true, autoCollapse: true, focusExpandedGroup: true,
  toolbarFollow: true, toolbarMode: 'domain', toolbarCollapse: true, persist: true,
  rules: [], exclusions: []
});
const choices = { groupBy: ['domain', 'source'], naming: ['domain', 'host', 'full', 'opener', 'none'], toolbarMode: ['domain', 'source'] };
export function settingsFrom(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Settings must be an object.');
  const out = structuredClone(DEFAULTS);
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULTS)) continue;
    if (typeof DEFAULTS[key] === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`Invalid ${key} setting.`);
      out[key] = value;
    } else if (choices[key]) {
      if (!choices[key].includes(value)) throw new Error(`Invalid ${key} setting.`);
      out[key] = value;
    }
  }
  if ('maxTabs' in raw) {
    if (!Number.isInteger(raw.maxTabs) || raw.maxTabs < 0 || raw.maxTabs > 999 || raw.maxTabs === 1) throw new Error('Maximum tabs must be 0 (unlimited) or 2–999.');
    out.maxTabs = raw.maxTabs;
  }
  for (const key of ['rules', 'exclusions']) {
    if (!(key in raw)) continue;
    if (!Array.isArray(raw[key]) || raw[key].length > 500) throw new Error(`Invalid ${key} list (maximum 500).`);
    out[key] = raw[key].map(item => {
      if (key === 'exclusions') return validateHost(item);
      if (!item || typeof item !== 'object') throw new Error('Invalid custom rule.');
      const host = validateHost(item.host);
      if (typeof item.name !== 'string' || item.name.length > 100 || !item.name.trim()) throw new Error('Each rule needs a group name (up to 100 characters).');
      if (item.color !== 'auto' && !COLORS.includes(item.color)) throw new Error('Invalid rule color.');
      return { host, name: item.name.trim(), color: item.color };
    });
  }
  return out;
}
export function validateHost(value) {
  if (typeof value !== 'string' || value.length > 253) throw new Error('Enter a hostname, such as github.com.');
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (!host || /[\s/:?#*]/.test(host) || !/^[a-z\d.-]+$/.test(host) || host.split('.').some(part => !part || part.startsWith('-') || part.endsWith('-'))) throw new Error(`Invalid hostname: ${value}`);
  return host;
}
export function site(url) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    const info = parse(u.hostname, { allowPrivateDomains: true });
    return { host: u.hostname, domain: info.domain || u.hostname, label: info.domainWithoutSuffix || u.hostname, suffix: info.publicSuffix || '' };
  } catch { return null; }
}
export function hostMatches(host, pattern) { return host === pattern || host.endsWith(`.${pattern}`); }
export function ruleFor(tab, settings) {
  const info = site(tab.pendingUrl || tab.url);
  return info && settings.rules.find(rule => hostMatches(info.host, rule.host));
}
export function eligible(tab, settings) {
  const info = site(tab.pendingUrl || tab.url);
  return Boolean(info && !tab.pinned && !tab.incognito && !settings.exclusions.some(host => hostMatches(info.host, host)));
}
export function groupName(tab, settings, opener = tab) {
  const info = site(tab.pendingUrl || tab.url);
  if (!info || settings.naming === 'none') return '';
  if (settings.naming === 'opener') return (opener.title || info.label).slice(0, 100);
  if (settings.naming === 'full') return info.host;
  if (settings.naming === 'host') return info.suffix ? info.host.slice(0, -(info.suffix.length + 1)) : info.host;
  return info.label;
}
export function colorFor(key) {
  let n = 0;
  for (const c of key) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[n % (COLORS.length - 1)];
}
export function colorForRule(rule) {
  return rule.color === 'auto' ? colorFor(`rule:${rule.name}:auto`) : rule.color;
}
// Relationships are independent of domains. Stored families survive a closed opener.
export function sourceFamilies(tabs, records = {}) {
  const parent = new Map(tabs.map(tab => [tab.id, tab.id]));
  function root(id) {
    const seen = new Set();
    while (parent.get(id) !== id && !seen.has(id)) { seen.add(id); id = parent.get(id); }
    return id;
  }
  const families = new Map();
  for (const tab of tabs) {
    const opener = records[tab.id]?.opener ?? tab.openerTabId;
    if (parent.has(opener)) parent.set(root(tab.id), root(opener));
    const family = records[tab.id]?.family;
    if (family && families.has(family)) parent.set(root(tab.id), root(families.get(family)));
    else if (family) families.set(family, tab.id);
  }
  return new Map(tabs.map(tab => [tab.id, root(tab.id)]));
}
export function planGroups(tabs, settings, mode, records = {}) {
  const eligibleTabs = tabs.filter(tab => eligible(tab, settings));
  const roots = sourceFamilies(eligibleTabs, records);
  const buckets = new Map();
  for (const tab of eligibleTabs) {
    const rule = ruleFor(tab, settings);
    const key = rule ? `rule:${rule.name}:${rule.color}` : mode === 'domain' ? `domain:${site(tab.pendingUrl || tab.url).domain}` : `source:${roots.get(tab.id)}`;
    if (!buckets.has(key)) buckets.set(key, { key, tabs: [], rule });
    buckets.get(key).tabs.push(tab);
  }
  return [...buckets.values()].flatMap(bucket => {
    const chunks = [];
    const limit = settings.maxTabs || Math.max(1, bucket.tabs.length);
    for (let i = 0; i < bucket.tabs.length; i += limit) {
      const chunk = bucket.tabs.slice(i, i + limit);
      // Never manufacture source relationships for a lone tab.
      if (chunk.length === 1 && (settings.removeSingle || mode === 'source')) continue;
      const opener = tabs.find(tab => tab.id === roots.get(chunk[0].id)) || chunk[0];
      chunks.push({ tabs: chunk, title: bucket.rule?.name ?? groupName(chunk[0], settings, opener), color: bucket.rule ? colorForRule(bucket.rule) : colorFor(bucket.key), autoColor: !bucket.rule || bucket.rule.color === 'auto' });
    }
    return chunks;
  });
}
// Keep existing groups as units; only ungrouped tabs are classified by rules.
export function planPreservedGroups(tabs, groups, settings, mode, records = {}) {
  const ordered = [...tabs].sort((a,b)=>a.index-b.index);
  const metadata = new Map(groups.map(group=>[group.id,group]));
  const members = new Map();
  for (const tab of ordered) if (tab.groupId !== -1) {
    if (!members.has(tab.groupId)) members.set(tab.groupId,[]);
    members.get(tab.groupId).push(tab);
  }
  const destinations = [], merges = [], additions = [], creations = [], canonical = new Map();
  const capacity = target=>settings.maxTabs ? Math.max(0,settings.maxTabs-target.size) : Infinity;
  for (const [id,items] of members) {
    const group = metadata.get(id);
    // Existing browser/extension tabs can move with their whole group. Only
    // pinned/incognito members and explicitly excluded websites protect a unit.
    if (!group || items.some(tab=>{
      const info = site(tab.pendingUrl || tab.url);
      return tab.pinned || tab.incognito || (info && settings.exclusions.some(host=>hostMatches(info.host,host)));
    })) continue;
    const target = group.title && destinations.find(target=>target.title === group.title && capacity(target)>=items.length);
    if (target) {
      merges.push({targetId:target.id,sourceId:id,tabs:items}); target.size += items.length; canonical.set(id,target.id);
    } else { destinations.push({...group,size:items.length}); canonical.set(id,id); }
  }
  const ungrouped = ordered.filter(tab=>tab.groupId === -1);
  const plan = planGroups(mode === 'source' ? ordered : ungrouped,{...settings,removeSingle:false},mode,records);
  for (const group of plan) {
    const remaining = group.tabs.filter(tab=>tab.groupId === -1);
    const related = mode === 'source' && !ruleFor(group.tabs[0],settings)
      ? new Set(group.tabs.filter(tab=>tab.groupId !== -1).map(tab=>canonical.get(tab.groupId)).filter(id=>id !== undefined)) : new Set();
    while (remaining.length) {
      const target = destinations.find(target=>related.has(target.id) && capacity(target)>0)
        || (group.title && destinations.find(target=>target.title === group.title && capacity(target)>0));
      if (target) {
        const items = remaining.splice(0,Math.min(remaining.length,capacity(target)));
        if (target.creation) target.creation.tabs.push(...items);
        else additions.push({targetId:target.id,tabs:items});
        target.size += items.length;
      } else {
        if (remaining.length === 1 && (settings.removeSingle || mode === 'source')) break;
        const creation = {...group,tabs:remaining.splice(0,settings.maxTabs || remaining.length)};
        creations.push(creation);
        if (creation.title) destinations.push({title:creation.title,size:creation.tabs.length,creation});
      }
    }
  }
  return {merges,additions,creations};
}
// Match URL occurrences within each window, including duplicate URLs. Never use old IDs.
export function matchTabs(saved, current) {
  const pools = new Map();
  for (const tab of current) {
    const key = `${Boolean(tab.pinned)}:${tab.pendingUrl || tab.url}`;
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push(tab);
  }
  return saved.flatMap(tab => {
    const match = pools.get(`${Boolean(tab.pinned)}:${tab.url}`)?.shift();
    return match ? [{ saved: tab, current: match }] : [];
  });
}
export function matchWindows(saved, current) {
  const candidates = [];
  for (let s = 0; s < saved.length; s++) for (let c = 0; c < current.length; c++) {
    const pairs = matchTabs(saved[s].tabs, current[c].tabs);
    const score = pairs.length;
    if (score) candidates.push({ s, c, pairs, score, ratio: score / Math.max(saved[s].tabs.length, current[c].tabs.length) });
  }
  candidates.sort((a, b) => b.score - a.score || b.ratio - a.ratio);
  const usedS = new Set(), usedC = new Set();
  return candidates.filter(item => {
    if (usedS.has(item.s) || usedC.has(item.c)) return false;
    usedS.add(item.s); usedC.add(item.c); return true;
  }).map(item => ({ saved: saved[item.s], current: current[item.c], pairs: item.pairs }));
}
export function parseImport(text, current = DEFAULTS) {
  if (text.length > 2_000_000) throw new Error('The import is too large (maximum 2 MB).');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('This is not valid JSON.'); }
  if (!['TABLA','Tabsir'].includes(data.app) || data.schema !== 1 || !data.settings) throw new Error('Choose a TABLA settings export (schema 1).');
  return settingsFrom({ ...current, ...data.settings });
}
