// Disease tracking with stages, and survival conditions: optional systems in the style of Giffyglyph's Darker Dungeons
// (a third-party book). Each campaign switches them on in Settings. No disease text is built in.
import { DAY } from './calendar.js';


// No diseases come built in: add the ones your table uses in the disease library (or import a library file).
export const SEED_DISEASES = [];

export const RARITY_DC = { Common: 10, Rare: 20, Mythic: 30 }; // diagnosis DC
export const CONTAGIOUS = [null, 0.25, 0.5, 0.75, 1]; // below this share of max HP, by stage (stage 4: always)
// Magic Strength: highest disease DC a spell of this level can push into decline.
export const magicMaxDC = level => (level <= 5 ? 15 : level <= 8 ? 25 : 30);
// Magical Immunity: class feature level -> immune up to this DC.
export const immunityDC = level => (level <= 0 ? 0 : level <= 5 ? 15 : level <= 10 ? 20 : level <= 15 ? 25 : 99);

export const incubationMins = d => Math.max(1, +d.incubation || 1) * DAY;
export function fmtIncubation(days) {
  days = +days || 1;
  if (days % 7 === 0) { const w = days / 7; return `${w} week${w > 1 ? 's' : ''}`; }
  return `${days} day${days > 1 ? 's' : ''}`;
}

// Effects are cumulative: stage 3 has the effects of stages 1, 2 and 3.
export function activeEffects(disease, stage) { return (disease?.stages || []).slice(0, Math.max(0, stage)); }

// "gain thirst at twice the normal rate" and the like, from the stages in effect.
export function rateDoubling(disease, stage) {
  const txt = activeEffects(disease, stage).join(' ').toLowerCase();
  const out = { hunger: false, thirst: false, fatigue: false };
  for (const m of txt.matchAll(/gain ([a-z ,and]+?) at twice/g)) {
    for (const k of Object.keys(out)) if (m[1].includes(k)) out[k] = true;
  }
  return out;
}

// ---------- survival conditions
export const CONDITIONS = [
  { id: 'hunger', name: 'Hunger', stages: ['Stuffed', 'Well-fed', 'Ok', 'Peckish', 'Hungry', 'Ravenous', 'Starving'] },
  { id: 'thirst', name: 'Thirst', stages: ['Quenched', 'Refreshed', 'Ok', 'Parched', 'Thirsty', 'Dry', 'Dehydrated'] },
  { id: 'fatigue', name: 'Fatigue', stages: ['Energized', 'Well-rested', 'Ok', 'Tired', 'Sleepy', 'Very sleepy', 'Barely awake'] },
  { id: 'temp', name: 'Temperature', stages: ['Perfect', 'Comfortable', 'Ok', 'Noticeable', 'Uncomfortable', 'Overwhelming', 'Unbearable'] },
];
export const STAMINA_DC = [null, 5, 10, 15, 20, 25, 30];

export function defaultSurvival() {
  return { hunger: 2, thirst: 2, fatigue: 2, exhausting: { hunger: false, thirst: false, fatigue: false, temp: false }, food: 0, water: 0,
    gear: { coldGear: false, coldRes: false, heatRes: false, coldAdapted: false, heatAdapted: false } };
}

// Air temperature at a time of day: coldest around sunrise (5 AM), warmest mid-afternoon (3 PM).
export function tempAt(w, minuteOfDay) {
  const h = minuteOfDay / 60;
  let f;
  if (h >= 5 && h <= 15) f = (1 - Math.cos(Math.PI * (h - 5) / 10)) / 2;
  else { const x = h > 15 ? h - 15 : h + 9; f = (1 + Math.cos(Math.PI * x / 14)) / 2; }
  return w.low + (w.high - w.low) * f;
}

// Temperature stage from the air temperature (homebrew: Darker Dungeons leaves the baseline to the GM).
// Returns { stage, side: 'cold'|'hot'|null }.
export function tempStage(f, gear = {}, sheltered = false, wind = 0) {
  let side = null, stage;
  const felt = f - (wind === 2 ? 10 : wind === 1 ? 4 : 0);
  if (felt >= 66 && felt <= 72) stage = 0;
  else if (felt >= 60 && felt <= 80) stage = 1;
  else if (felt < 60) {
    side = 'cold';
    stage = felt >= 45 ? 2 : felt >= 32 ? 3 : felt >= 10 ? 4 : felt >= -10 ? 5 : 6;
    if (gear.coldGear) stage -= 2;
    if (gear.coldAdapted) stage -= 1;
    if (sheltered) stage -= 3;
    if (gear.coldRes) stage = Math.min(stage, 3);
  } else {
    side = 'hot';
    stage = felt <= 88 ? 2 : felt <= 96 ? 3 : felt <= 104 ? 4 : felt <= 114 ? 5 : 6;
    if (gear.heatAdapted) stage -= 1;
    if (sheltered) stage -= 2;
    if (gear.heatRes) stage = Math.min(stage, 3);
  }
  stage = Math.max(side ? 1 : 0, Math.min(6, stage));
  return { stage, side: stage <= 1 ? null : side };
}

// Clock marks (minutes into the day): dawn 6:00, noon 12:00, dusk 18:00.
export const MARKS = [
  { at: 6 * 60, name: 'dawn', hunger: 1, thirst: 1, fatigue: 0 },
  { at: 12 * 60, name: 'noon', hunger: 0, thirst: 0, fatigue: 1 },
  { at: 18 * 60, name: 'dusk', hunger: 1, thirst: 1, fatigue: 1 },
];
// Every mark passed going from t0 to t1 (forward only), oldest first.
export function marksBetween(t0, t1) {
  const out = [];
  if (t1 <= t0) return out;
  const d0 = Math.floor(t0 / DAY), d1 = Math.floor(t1 / DAY);
  for (let d = d0; d <= d1 && out.length < 400; d++) for (const m of MARKS) { const t = d * DAY + m.at; if (t > t0 && t <= t1) out.push({ ...m, t }); }
  return out;
}
