import { DEFAULTS, settingsFrom, parseImport } from './core.js';

export const SECTIONS = {
  automaticGrouping: { label: 'Automatic grouping', keys: ['enabled', 'groupBy', 'naming', 'combineExisting', 'maxTabs', 'removeSingle', 'removeSingleOnMove', 'autoCollapse', 'focusExpandedGroup'] },
  toolbarIcon: { label: 'Menu grouping action', keys: ['toolbarFollow', 'toolbarMode', 'toolbarCollapse'] },
  persistence: { label: 'Persistence', keys: ['persist'] },
  customRules: { label: 'Custom rules', keys: ['rules'] },
  excludedWebsites: { label: 'Excluded websites', keys: ['exclusions'] }
};
const PREFIX = 'TABLA:v1:';
const LEGACY_PREFIX = 'TABSIR:v1:';
function checkSections(sections) {
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) throw new Error('The export must contain settings sections.');
  const names = Object.keys(sections);
  if (!names.length) throw new Error('Select at least one section to export.');
  if (names.some(name => !Object.hasOwn(SECTIONS, name))) throw new Error('This export contains an unsupported settings section. Update TABLA before importing it.');
  const result = {};
  for (const name of names) {
    const section = sections[name], definition = SECTIONS[name];
    if (!section || typeof section !== 'object' || Array.isArray(section)) throw new Error(`Invalid ${definition.label} settings.`);
    // Older exports contained the now-retired ungrouped-tab positioning option.
    const legacyKeys = name === 'automaticGrouping' ? ['crossDomainSide'] : [];
    if (Object.keys(section).some(key => !definition.keys.includes(key) && !legacyKeys.includes(key))) throw new Error(`Unsupported setting in ${definition.label}. Update TABLA before importing it.`);
    if (definition.keys.some(key => !Object.hasOwn(section, key) && !['toolbarCollapse','focusExpandedGroup','removeSingleOnMove'].includes(key))) throw new Error(`Incomplete ${definition.label} settings.`);
    const compatible = {...section};
    // Missing options in older exports retain their historical off behavior.
    for (const key of ['toolbarCollapse','focusExpandedGroup']) if (definition.keys.includes(key) && !Object.hasOwn(section,key)) compatible[key] = false;
    const validated = settingsFrom(compatible);
    result[name] = Object.fromEntries(definition.keys.map(key => [key, validated[key]]));
  }
  return result;
}
export function exportSettings(settings, selected = Object.keys(SECTIONS)) {
  const sections = {};
  for (const name of selected) {
    if (!Object.hasOwn(SECTIONS, name)) throw new Error('Unknown settings section.');
    sections[name] = Object.fromEntries(SECTIONS[name].keys.map(key => [key, settings[key]]));
  }
  return PREFIX + JSON.stringify({ sections: checkSections(sections) });
}
export function importSettings(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value.length > 2_000_000) throw new Error('The import is too large (maximum 2 MB).');
  const prefix = [PREFIX,LEGACY_PREFIX].find(prefix=>value.startsWith(prefix));
  if (!prefix) {
    // Keep exports made by the original JSON-based TABLA release usable.
    if (value.startsWith('{')) {
      const validated = parseImport(value, DEFAULTS);
      const original = JSON.parse(value).settings;
      const patch = Object.fromEntries(Object.keys(original).filter(key => Object.hasOwn(DEFAULTS, key)).map(key => [key, validated[key]]));
      if (!Object.keys(patch).length) throw new Error('This export does not include any settings.');
      return { patch, names: Object.keys(SECTIONS).filter(name => SECTIONS[name].keys.some(key => Object.hasOwn(patch, key))) };
    }
    throw new Error('Unsupported or incomplete TABLA export. Use an export from a supported version.');
  }
  let data;
  try { data = JSON.parse(value.slice(prefix.length)); }
  catch { throw new Error('The export string is incomplete or invalid. Copy it again and retry.'); }
  const sections = checkSections(data?.sections);
  return { patch: Object.assign({}, ...Object.values(sections)), names: Object.keys(sections) };
}
