// Random outbreaks: homebrew, not from Darker Dungeons (the book has no rules for diseases breaking out on their own).
// Rolled once per in-game week for every location, with seeded dice so every device rolls the same outbreaks.
import { DAY } from './calendar.js';
import { normals, climateById } from './weather.js';

export const WEEK = 7 * DAY;
export const weekOf = t => Math.floor(t / WEEK);

// How crowded a place is. Cities breed disease; the empty wilds hardly ever do.
export const POP = { city: { label: 'City', chance: 0.10 }, town: { label: 'Town or village', chance: 0.05 }, wild: { label: 'Wilderness', chance: 0.012 } };
export function popOf(loc) {
  return loc.pop || 'town'; // set per place in the World tab
}

// Which diseases like which conditions (homebrew).
const WATER = ['dis-cholera', 'dis-dysentery', 'dis-typhoid-fever'];
const COLD = ['dis-influenza', 'dis-whooping-cough', 'dis-diphtheria', 'dis-chickenpox', 'dis-smallpox'];
const RARITY_WEIGHT = { Common: 10, Rare: 2, Mythic: 0 };

export const SEVERITY = {
  few: { label: 'A few cases', daily: 0.10, weeks: [2, 3] },
  spreading: { label: 'Spreading', daily: 0.25, weeks: [3, 4] },
  epidemic: { label: 'Epidemic', daily: 0.5, weeks: [4, 6] },
};
export const FREQ = { rare: { label: 'Rarely', mult: 0.5 }, normal: { label: 'Sometimes', mult: 1 }, often: { label: 'Often', mult: 2 } };

function hashStr(s) { let h = 1779033703 ^ s.length; for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); } return h >>> 0; }
function rng(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function diseaseWeight(d, loc, epoch, pop) {
  let w = RARITY_WEIGHT[d.rarity] ?? 0;
  if (!w) return 0;
  const n = normals(loc, epoch), climate = climateById(loc.climate).id;
  const cold = n.high < 40, hot = n.high > 75, wet = ['humidsub', 'rainforest', 'tempcoast', 'coldcoast'].includes(climate);
  if (WATER.includes(d.id)) { if (hot) w *= 2.5; if (wet) w *= 1.5; if (cold) w *= 0.4; }
  if (COLD.includes(d.id)) { if (cold) w *= 2.5; if (hot) w *= 0.4; }
  if (d.id === 'dis-bubonic-plague' && pop === 'city') w *= 2;
  if (d.id === 'dis-syphilis' && pop !== 'city') w *= 0.3;
  return w;
}

// Roll one location for one week. Returns an outbreak record (without timestamps) or null.
export function rollWeek(campaignId, loc, week, diseases, freq = 'normal') {
  const r = rng(hashStr(`${campaignId}|${loc.id}|${week}|outbreak`));
  const pop = popOf(loc);
  if (r() >= POP[pop].chance * (FREQ[freq]?.mult ?? 1)) return null;
  const start = week * WEEK + Math.floor(r() * 7) * DAY;
  const pool = diseases.filter(d => !d.deleted).map(d => [d, diseaseWeight(d, loc, Math.floor(start / DAY), pop)]).filter(x => x[1] > 0);
  const total = pool.reduce((a, x) => a + x[1], 0);
  if (!total) return null;
  let pick = r() * total, disease = pool[0][0];
  for (const [d, w] of pool) { pick -= w; if (pick <= 0) { disease = d; break; } }
  const s = r(), severity = s < 0.6 ? 'few' : s < 0.9 ? 'spreading' : 'epidemic';
  const [lo, hi] = SEVERITY[severity].weeks;
  const weeks = lo + Math.floor(r() * (hi - lo + 1));
  return { id: `ob-${campaignId}-${loc.id}-${week}`, campaignId, locationId: loc.id, diseaseId: disease.id, startAt: start, endAt: start + weeks * WEEK, severity, random: true };
}

export const isActive = (o, now) => !o.deleted && !o.endedAt && o.startAt <= now && (!o.endAt || now < o.endAt);
// Chance one PC is exposed over a number of days there.
export const exposureChance = (severity, days) => 1 - Math.pow(1 - (SEVERITY[severity]?.daily ?? 0.25), Math.max(1, days));
