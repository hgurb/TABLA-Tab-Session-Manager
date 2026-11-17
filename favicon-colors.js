import { COLORS, site } from './core.js';

const CACHE_AGE = 7 * 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 256;
const COLOR_ALGORITHM = 2;
const PALETTE = {
  red: [[234, 67, 53]], orange: [[250, 144, 62]], yellow: [[251, 188, 4]],
  green: [[52, 168, 83]], cyan: [[36, 193, 224]], blue: [[66, 133, 244]],
  purple: [[161, 66, 244]], pink: [[244, 143, 177], [255, 20, 147]]
};
const LINEAR_RGB = Array.from({length:256},(_,value)=>{
  const channel = value / 255;
  return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
});
// Linear sRGB -> OKLab; compare squared perceptual distances without a square root.
// Conversion: https://bottosson.github.io/posts/oklab/#converting-from-linear-srgb-to-oklab
function oklab(red, green, blue) {
  const r = LINEAR_RGB[red], g = LINEAR_RGB[green], b = LINEAR_RGB[blue];
  const l = Math.cbrt(.4122214708*r + .5363325363*g + .0514459929*b);
  const m = Math.cbrt(.2119034982*r + .6806995451*g + .1073969566*b);
  const s = Math.cbrt(.0883024619*r + .2817188376*g + .6299787005*b);
  return [.2104542553*l + .793617785*m - .0040720468*s,
    1.9779984951*l - 2.428592205*m + .4505937099*s,
    .0259040371*l + .7827717662*m - .808675766*s];
}
// Pale and vivid pink share one output family; a pale reference alone would
// incorrectly classify saturated pink as the darker red swatch.
const PERCEPTUAL_PALETTE = Object.entries(PALETTE).flatMap(([color,shades])=>shades.map(rgb=>[color,oklab(...rgb)]));
// Vote by saturated color area; ignore transparent, white, and black pixels so
// a bright logo's background/play glyph does not overwhelm its identifying hue.
export function dominantFaviconColor(pixels) {
  const votes = new Map();
  const matches = new Map();
  let neutral = 0, opaque = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    if (alpha < .25) continue;
    opaque += alpha;
    const r = pixels[i] / 255, g = pixels[i + 1] / 255, b = pixels[i + 2] / 255;
    const max = Math.max(r, g, b), delta = max - Math.min(r, g, b);
    const saturation = max ? delta / max : 0;
    if (delta < .12 || saturation < .2 || max < .18) {
      if (max < .85) neutral += alpha;
      continue;
    }
    const rgbKey = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    let nearest = matches.get(rgbKey);
    if (!nearest) {
      const lab = oklab(pixels[i],pixels[i + 1],pixels[i + 2]);
      let best = Infinity;
      for (const [color,reference] of PERCEPTUAL_PALETTE) {
        const distance = (lab[0]-reference[0]) ** 2 + (lab[1]-reference[1]) ** 2 + (lab[2]-reference[2]) ** 2;
        if (distance < best) { best = distance; nearest = color; }
      }
      matches.set(rgbKey,nearest);
    }
    const weight = alpha * saturation ** 1.5 * Math.sqrt(delta);
    votes.set(nearest, (votes.get(nearest) || 0) + weight);
  }
  const winner = [...votes].sort((a, b) => b[1] - a[1])[0];
  if (winner && winner[1] >= Math.max(1, opaque * .015)) return winner[0];
  return neutral >= Math.max(1, opaque * .05) ? 'grey' : null;
}
function identity(tab) {
  const url = tab.pendingUrl || tab.url;
  return !tab.incognito && site(url) ? { origin: new URL(url).origin, url } : null;
}
function signature(value = '') {
  let n = 2166136261;
  for (const c of value) n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0;
  return n.toString(16);
}
function validCache(entry, tab) {
  return entry && entry.algorithm === COLOR_ALGORITHM && COLORS.includes(entry.color) && Date.now() - entry.at < CACHE_AGE
    && (!tab.favIconUrl || entry.signature === signature(tab.favIconUrl));
}
export async function cachedFaviconColor(tab) {
  const key = identity(tab); if (!key) return null;
  const { faviconColors = {} } = await chrome.storage.local.get('faviconColors');
  return validCache(faviconColors[key.origin], tab) ? faviconColors[key.origin].color : null;
}
async function sampleFavicon(tab) {
  const key = identity(tab);
  // Unknown pages can return Chrome's generic placeholder. Wait for a real icon.
  if (!key || !tab.favIconUrl) return null;
  return navigator.locks.request(`tabsir-favicon:${key.origin}`, async () => {
    const cached = await cachedFaviconColor(tab);
    if (cached) return cached;
    const url = new URL(chrome.runtime.getURL('/_favicon/'));
    url.searchParams.set('pageUrl', key.url); url.searchParams.set('size', '32');
    let bitmap;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500), credentials: 'omit' });
      if (!response.ok) return null;
      const blob = await response.blob();
      if (!blob.size || blob.size > 262144) return null;
      bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(32, 32);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0, 32, 32);
      const color = dominantFaviconColor(context.getImageData(0, 0, 32, 32).data);
      if (!color) return null;
      await navigator.locks.request('tabsir-favicon-cache', async () => {
        const { faviconColors = {} } = await chrome.storage.local.get('faviconColors');
        faviconColors[key.origin] = { color, algorithm: COLOR_ALGORITHM, signature: signature(tab.favIconUrl), at: Date.now() };
        const bounded = Object.fromEntries(Object.entries(faviconColors).sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_LIMIT));
        await chrome.storage.local.set({ faviconColors: bounded });
      });
      return color;
    } catch { return null; }
    finally { bitmap?.close(); }
  });
}
const groupKey = id => `faviconGroup:${id}`;
export async function forgetAutoColorGroup(id) { await chrome.storage.session.remove(groupKey(id)); }
async function refineGroup(id, tab, token) {
  const color = await sampleFavicon(tab);
  if (!color) return;
  await navigator.locks.request('tabsir-engine', async () => {
    const key = groupKey(id), meta = (await chrome.storage.session.get(key))[key];
    if (!meta || meta.token !== token) return;
    let group;
    try { group = await chrome.tabGroups.get(id); } catch { await forgetAutoColorGroup(id); return; }
    // A manual rename/color change takes ownership away from Auto.
    if (group.color !== meta.color || (group.title || '') !== meta.title) { await forgetAutoColorGroup(id); return; }
    if (color === group.color) return;
    await chrome.storage.session.set({ [key]: { ...meta, color } });
    await chrome.tabGroups.update(id, { color });
  });
}
function launchRefinement(id, tab, token) {
  // Cosmetics run outside the grouping lock, never delaying tab placement.
  void refineGroup(id, tab, token).catch(() => {});
}
export async function trackAutoColorGroup(id, tab, title, color) {
  const key = identity(tab); if (!key) return;
  const meta = { origin: key.origin, title, color, token: crypto.randomUUID() };
  await chrome.storage.session.set({ [groupKey(id)]: meta });
  launchRefinement(id, tab, meta.token);
}
export async function refreshAutoColor(tab) {
  if (tab.groupId === -1 || tab.incognito) return;
  const key = identity(tab); if (!key) return;
  const meta = (await chrome.storage.session.get(groupKey(tab.groupId)))[groupKey(tab.groupId)];
  if (meta?.origin === key.origin) launchRefinement(tab.groupId, tab, meta.token);
}
