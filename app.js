import { db, uid, STORES } from './db.js';
import * as C from './calendar.js';
import { openInkEditor, renderThumb } from './ink.js';
import { initSync, suiteNow } from './sync.js';
import * as W from './weather.js';
import * as H from './health.js';
import * as T from './downtime.js';
import * as O from './outbreaks.js';

const APP_VERSION = '2.0.0';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtReal = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const state = {
  campaigns: [], pcs: [], sessions: [], ink: [], locations: [], weather: [], diseases: [], cases: [], outbreaks: [], training: [], trades: [], cards: [],
  campaignId: null, view: 'session', sessionId: null, calMonth: null, calDay: null, query: '',
};

// ---------- data helpers
const campaign = () => state.campaigns.find(c => c.id === state.campaignId);
const now = () => campaign().current;
const livePcs = () => state.pcs.filter(p => p.campaignId === state.campaignId && !p.deleted).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
const activePcs = () => livePcs().filter(p => p.active !== false);
// Absent players' characters sit out the clock: no survival changes, meals or party-wide rests while they're away.
const openSessionNow = () => { const s = state.sessions.filter(x => x.campaignId === state.campaignId && !x.deleted).sort((a, b) => b.number - a.number)[0]; return s && s.endAt == null ? s : null; };
const isAbsent = id => (openSessionNow()?.absent || []).includes(id);
const presentPcs = () => activePcs().filter(p => !isAbsent(p.id));
const campaignSessions = () => state.sessions.filter(s => s.campaignId === state.campaignId && !s.deleted).sort((a, b) => b.number - a.number || b.createdAt - a.createdAt);
const latestSession = () => campaignSessions()[0];
const inkFor = s => (s.inkIds || []).map(id => state.ink.find(i => i.id === id)).filter(i => i && !i.deleted);
const liveLocations = () => state.locations.filter(l => !l.deleted);
const locById = id => state.locations.find(l => l.id === id && !l.deleted);
const hereLoc = () => locById(campaign().locationId);

// ---------- weather records (one per campaign, location and day)
const wxId = (locId, epoch) => `${state.campaignId}:${locId}:${epoch}`;
const wxIndex = new Map();
function indexWeather() { wxIndex.clear(); for (const w of state.weather) wxIndex.set(w.id, w); }
let wxToSave = [];
let wxSaveT;
function queueWx(rec) { wxToSave.push(rec); clearTimeout(wxSaveT); wxSaveT = setTimeout(() => { const l = wxToSave; wxToSave = []; db.putMany('weather', l); }, 300); }

// Returns the weather for a location and day, rolling it (and any days in between, so streaks carry) if needed.
// Weather runs in fixed 14-day blocks: the first day of a block is a fresh roll and each later day builds on the one before.
// That way every device works out exactly the same weather for a day, whatever it has or hasn't rolled before.
const WX_V = 2, BLOCK = 14;
const wxUsable = r => r && (r.manual || r.rerolls || r.v === WX_V);
function weatherFor(loc, epoch) {
  if (!loc) return null;
  const hit = wxIndex.get(wxId(loc.id, epoch));
  if (wxUsable(hit)) return hit;
  const blockStart = epoch - (((epoch % BLOCK) + BLOCK) % BLOCK);
  let prev = null, rec;
  for (let e = blockStart; e <= epoch; e++) {
    const have = wxIndex.get(wxId(loc.id, e));
    if (wxUsable(have)) { prev = have; rec = have; continue; }
    rec = { ...W.rollDay(loc, e, prev), id: wxId(loc.id, e), campaignId: state.campaignId, locationId: loc.id, v: WX_V, updatedAt: 1 };
    const i = state.weather.findIndex(x => x.id === rec.id); if (i >= 0) state.weather[i] = rec; else state.weather.push(rec);
    wxIndex.set(rec.id, rec); queueWx(rec);
    prev = rec;
  }
  return rec;
}
// After a day's weather is changed by hand, later rolled days in that block are worked out again from it.
function dropLaterWeather(locId, epoch, campaignId = state.campaignId) {
  const end = epoch - (((epoch % BLOCK) + BLOCK) % BLOCK) + BLOCK;
  for (const w of state.weather) {
    if (w.campaignId === campaignId && w.locationId === locId && w.epoch > epoch && w.epoch < end && !w.manual && !w.rerolls) { w.v = 0; wxIndex.set(w.id, w); }
  }
}
const todayWx = () => weatherFor(hereLoc(), Math.floor(now() / C.DAY));
// The day's weather hour by hour (yesterday and tomorrow decide whether a storm runs over midnight).
function hoursFor(loc, epoch) {
  const w = weatherFor(loc, epoch); if (!w) return null;
  return W.hourly(loc, w, weatherFor(loc, epoch - 1), weatherFor(loc, epoch + 1));
}
// The weather right now where the party is.
function wxNow() {
  const loc = hereLoc(); if (!loc) return null;
  const t = now(), ep = Math.floor(t / C.DAY), w = weatherFor(loc, ep), hrs = hoursFor(loc, ep);
  return { w, hrs, cur: W.at(hrs, w, t - ep * C.DAY), hour: Math.floor((t - ep * C.DAY) / 60) };
}

// ---------- health helpers
const liveDiseases = () => state.diseases.filter(d => !d.deleted).sort((a, b) => a.name.localeCompare(b.name));
const disById = id => state.diseases.find(d => d.id === id);
const OPEN_STATES = ['incubating', 'sick', 'declining'];
const openCases = pcId => state.cases.filter(c => c.campaignId === state.campaignId && !c.deleted && OPEN_STATES.includes(c.state) && (!pcId || c.pcId === pcId));
const activeOutbreaksAt = locId => state.outbreaks.filter(o => o.campaignId === state.campaignId && o.locationId === locId && O.isActive(o, now()));
const randomOutbreaksOn = () => campaign().randomOutbreaks !== false;
const dueCases = () => openCases().filter(c => c.state !== 'declining' && c.dueAt <= now());
function surv(p) {
  if (!p.survival) p.survival = H.defaultSurvival();
  const d = H.defaultSurvival();
  p.survival.exhausting = { ...d.exhausting, ...(p.survival.exhausting || {}) };
  p.survival.gear = { ...d.gear, ...(p.survival.gear || {}) };
  return p.survival;
}
const survivalOn = () => campaign().survivalOn !== false;
const diseasesOn = () => campaign().diseasesOn !== false;
const trainingOn = () => campaign().trainingOn !== false;
const brokerOn = () => campaign().brokerOn !== false;
// The item broker's name (a campaign setting): who finds buyers and sellers for magic items
const broker = () => campaign()?.brokerName || 'The broker';
const brokerShort = () => broker().split(' ')[0];
const supplies = () => campaign().supplies || 'plentiful';
function doublingFor(p) {
  const out = { hunger: false, thirst: false, fatigue: false };
  for (const c of openCases(p.id)) { if (c.state === 'incubating') continue; const d = H.rateDoubling(disById(c.diseaseId), c.stage); for (const k in out) out[k] ||= d[k]; }
  return out;
}
function tempNow(p) {
  const loc = hereLoc(); if (!loc) return null;
  const { cur } = wxNow();
  return { air: cur.temp, ...H.tempStage(cur.temp, surv(p).gear, !!campaign().sheltered, cur.wind) };
}
function refreshFlags(p) {
  const sv = surv(p); let changed = false;
  for (const k of ['hunger', 'thirst', 'fatigue']) { sv[k] = Math.max(0, Math.min(6, sv[k])); if (sv[k] >= 5 && !sv.exhausting[k]) { sv.exhausting[k] = true; changed = true; } }
  const tn = tempNow(p);
  if (tn && tn.stage >= 5 && !sv.exhausting.temp) { sv.exhausting.temp = true; changed = true; }
  return changed;
}
function conditionExhaustion(p) {
  const sv = surv(p), tn = tempNow(p);
  const plus = Math.min(3, Object.values(sv.exhausting).filter(Boolean).length);
  const zeros = ['hunger', 'thirst', 'fatigue'].filter(k => sv[k] === 0).length + (tn && tn.stage === 0 ? 1 : 0);
  return { plus, zeros };
}
// A rest clears exhaustion from any condition that's back to stage 4 or better.
function restClear(p) {
  const sv = surv(p), tn = tempNow(p);
  for (const k of ['hunger', 'thirst', 'fatigue']) if (sv[k] <= 4) sv.exhausting[k] = false;
  if (!tn || tn.stage <= 4) sv.exhausting.temp = false;
}

// Moving the clock: dawn, noon and dusk change hunger, thirst and fatigue (Darker Dungeons).
async function applyClock(t0, t1, { longRest = false } = {}) {
  const pcs = presentPcs();
  const c = campaign();
  const msgs = [];
  if (survivalOn() && pcs.length) {
    const delta = t1 - t0, scarce = supplies() === 'scarce';
    if (delta >= C.DAY) {
      // Whole days passing: assume normal days of meals and sleep. Scarce supplies get used up.
      const days = Math.floor(delta / C.DAY);
      if (scarce) for (const p of pcs) {
        const sv = surv(p), need = 2 * days, f = Math.min(sv.food, need), w = Math.min(sv.water, need);
        sv.food -= f; sv.water -= w; sv.hunger += need - f; sv.thirst += need - w;
        if (need - f || need - w) msgs.push(`${p.name} ran short`);
      }
    } else if (delta > 0) {
      const marks = H.marksBetween(t0, t1);
      for (const m of marks) for (const p of pcs) {
        const sv = surv(p), dbl = doublingFor(p);
        sv.fatigue += m.fatigue * (dbl.fatigue ? 2 : 1);
        // With plenty of food and water they eat and drink as normal; only a disease's extra need shows.
        sv.hunger += m.hunger * (dbl.hunger ? 2 : 1) - (scarce ? 0 : m.hunger);
        sv.thirst += m.thirst * (dbl.thirst ? 2 : 1) - (scarce ? 0 : m.thirst);
      }
      const meal = [...marks].reverse().find(m => m.name !== 'noon');
      if (scarce && meal) c.mealPending = meal.name;
    } else if (delta < 0 && delta > -2 * C.DAY) {
      for (const m of H.marksBetween(t1, t0)) for (const p of pcs) {
        const sv = surv(p), dbl = doublingFor(p);
        sv.fatigue -= m.fatigue * (dbl.fatigue ? 2 : 1);
        sv.hunger -= m.hunger * (dbl.hunger ? 2 : 1) - (supplies() === 'scarce' ? 0 : m.hunger);
        sv.thirst -= m.thirst * (dbl.thirst ? 2 : 1) - (supplies() === 'scarce' ? 0 : m.thirst);
      }
    }
    for (const p of pcs) {
      const sv = surv(p);
      if (longRest) sv.fatigue -= 3;
      refreshFlags(p);
      if (longRest) restClear(p);
    }
    for (const p of pcs) await save('pcs', p);
  }
  if (t1 > t0) addOutbreakDays(t0, t1);
  await processCases();
  await processDowntime();
  await rollOutbreaks();
  return msgs;
}

// ---------- downtime helpers
const pcName = id => (id === 'party' ? 'The party' : state.pcs.find(p => p.id === id)?.name || '?');
const campaignTraining = () => state.training.filter(t => t.campaignId === state.campaignId && !t.deleted);
const campaignTrades = () => state.trades.filter(t => t.campaignId === state.campaignId && !t.deleted);
const campaignCards = () => state.cards.filter(c => c.campaignId === state.campaignId && !c.deleted);
async function processDowntime() {
  for (const t of campaignTraining()) {
    if (t.state !== 'active') continue;
    const st = T.trainingStatus(t, now());
    if (st.done >= st.total) {
      t.state = 'complete'; t.completedAt = st.finishAt; await save('training', t);
      const p = state.pcs.find(x => x.id === t.pcId);
      if (p) { p.learned = [...(p.learned || []), { at: st.finishAt, text: `${t.what} (${T.KINDS[t.kind].label})` }]; await save('pcs', p); }
      toast(`${p?.name || 'Someone'} finished training: ${t.what}.`);
    }
  }
}

// ---------- random outbreaks (homebrew)
async function rollOutbreaks() {
  const c = campaign(), cur = O.weekOf(now());
  if (!randomOutbreaksOn()) { if (c.obWeek !== cur) { c.obWeek = cur; await save('campaigns', c); } return; }
  let from = c.obWeek == null ? cur - 3 : c.obWeek + 1;
  if (from > cur) return;
  from = Math.max(from, cur - 12); // a big jump only rolls the last 12 weeks
  const have = new Set(state.outbreaks.map(o => o.id)), add = [];
  for (let w = from; w <= cur; w++) {
    for (const loc of liveLocations()) {
      const busy = state.outbreaks.concat(add).some(o => o.campaignId === c.id && o.locationId === loc.id && !o.deleted && !o.endedAt && o.startAt <= (w + 1) * O.WEEK && (!o.endAt || o.endAt > w * O.WEEK));
      if (busy) continue;
      const rec = O.rollWeek(c.id, loc, w, state.diseases, c.outbreakFreq || 'normal');
      if (rec && !have.has(rec.id)) add.push({ ...rec, createdAt: Date.now(), updatedAt: 1 });
    }
  }
  if (add.length) { await db.putMany('outbreaks', add); state.outbreaks.push(...add); }
  c.obWeek = cur; await save('campaigns', c);
}

// Days spent somewhere with an outbreak add up into one exposure prompt.
function addOutbreakDays(t0, t1) {
  const c = campaign(), d0 = Math.floor(t0 / C.DAY), d1 = Math.floor(t1 / C.DAY);
  if (d1 <= d0 || !c.locationId) return;
  for (const o of state.outbreaks.filter(o => o.campaignId === c.id && o.locationId === c.locationId && !o.deleted && !o.endedAt)) {
    let days = 0;
    for (let d = d0 + 1; d <= d1; d++) { const t = d * C.DAY; if (o.startAt <= t && (!o.endAt || t < o.endAt)) days++; }
    if (!days) continue;
    const p = (c.obPrompts || []).find(x => x.outbreakId === o.id);
    if (p) p.days += days; else c.obPrompts = [...(c.obPrompts || []), { outbreakId: o.id, days }];
  }
}

function obPromptHTML() {
  const c = campaign(), pcs = presentPcs();
  return (c.obPrompts || []).map(p => {
    const o = state.outbreaks.find(x => x.id === p.outbreakId), d = o && disById(o.diseaseId);
    if (!o || !d) return '';
    const pct = Math.round(O.exposureChance(o.severity || 'spreading', p.days) * 100);
    return `<div class="meal ob-prompt" data-obp="${o.id}">
      <b>Exposure roll: ${esc(d.name)} in ${esc(locById(o.locationId)?.name || '?')}</b>
      <p class="small">The party has spent ${p.days} day${p.days > 1 ? 's' : ''} there during the outbreak (${esc(O.SEVERITY[o.severity || 'spreading'].label.toLowerCase())}). Roll a d100 for each PC: <b>${pct} or lower</b> means they were exposed. Tick anyone who was.</p>
      <div class="check-grid">${pcs.map(pc => `<label class="check small"><input type="checkbox" data-obpc="${pc.id}"> ${esc(pc.name)}</label>`).join('')}</div>
      <div class="row left"><button class="btn primary small" data-act="obp-log">Log exposures</button><button class="btn small" data-act="obp-none">No one was exposed</button></div>
      <p class="muted small">Exposure odds are homebrew: ${Math.round(O.SEVERITY.few.daily * 100)}% a day for a few cases, ${Math.round(O.SEVERITY.spreading.daily * 100)}% spreading, ${Math.round(O.SEVERITY.epidemic.daily * 100)}% in an epidemic.</p>
    </div>`;
  }).join('');
}

// Diseases in decline get better on their own each period (Darker Dungeons: automatic success).
async function processCases() {
  for (const cs of openCases()) {
    if (cs.state !== 'declining') continue;
    const d = disById(cs.diseaseId); let changed = false;
    while (cs.state === 'declining' && cs.dueAt <= now()) {
      cs.stage -= 1; changed = true;
      cs.log.push({ at: cs.dueAt, kind: 'decline', result: 'auto', stage: cs.stage });
      if (cs.stage <= 0) { cs.state = 'cured'; cs.curedAt = cs.dueAt; break; }
      cs.dueAt += H.incubationMins(d);
    }
    if (changed) await save('cases', cs);
  }
}

async function save(store, rec) {
  rec.updatedAt = Date.now();
  if (store !== 'campaigns' && rec.campaignId) {
    const c = state.campaigns.find(x => x.id === rec.campaignId);
    if (c?.seed && state.campaignId) { c.seed = false; c.updatedAt = Date.now(); await db.put('campaigns', c); }
  }
  const list = state[store === 'campaigns' ? 'campaigns' : store];
  const i = list.findIndex(r => r.id === rec.id);
  if (i >= 0) list[i] = rec; else list.push(rec);
  await db.put(store, rec);
  if (store === 'pcs' || store === 'cases' || store === 'diseases') publishSoon();
  if (store === 'campaigns') campaignsChanged();
  return rec;
}

const pending = new Map();
function saveSoon(store, rec, ms = 600) {
  const p = pending.get(rec.id); if (p) clearTimeout(p.t);
  pending.set(rec.id, { store, rec, t: setTimeout(() => { pending.delete(rec.id); save(store, rec); }, ms) });
}
function flushSaves() {
  for (const [id, p] of pending) { clearTimeout(p.t); save(p.store, p.rec); }
  pending.clear();
}

// ---------- first run
// A new user starts with one empty campaign, rules as written: the optional systems (survival, diseases, outbreaks,
// training, the item broker) start off, and the calendar is the default until they set their own.
async function seed() {
  const cid = uid();
  // `seed: true` marks the untouched starter campaign, so loading a backup on a new device replaces it instead of duplicating it.
  const c = { id: cid, name: 'My campaign', current: C.toMinutes({ year: 1, month: 0, day: 1, hour: 8 }), createdAt: Date.now(), seed: true, locationId: null, ...OPTIONAL_OFF };
  await save('campaigns', c);
  await db.setMeta('campaignId', cid);
}
// The optional systems, off (a new user's first campaign). Older campaigns without these keep them on.
const OPTIONAL_OFF = { survivalOn: false, randomOutbreaks: false, diseasesOn: false, trainingOn: false, brokerOn: false };
const OPTIONAL_KEYS = Object.keys(OPTIONAL_OFF);

function newPc(fields) {
  return { id: uid(), campaignId: state.campaignId, name: '', ancestry: '', classes: '', player: '', maxHp: null, ac: null, pp: null,
    active: true, deaths: [], favor: { spent: false }, order: livePcs().length, createdAt: Date.now(), ...fields };
}

async function load() {
  const [campaigns, pcs, sessions, ink, locations, weather, diseases, cases, outbreaks, training, trades, cards] = await Promise.all(STORES.map(s => db.all(s)));
  Object.assign(state, { campaigns, pcs, sessions, ink, locations, weather, diseases, cases, outbreaks, training, trades, cards });
  // A brand-new library starts with the built-in diseases (an existing one keeps its own; they sync like any record)
  if (!state.diseases.length) {
    const addD = H.SEED_DISEASES.map(d => ({ ...d, stages: d.stages.slice(), updatedAt: 0 }));
    if (addD.length) { await db.putMany('diseases', addD); state.diseases.push(...addD); }
  }
  if (!campaigns.filter(c => !c.deleted).length) { await seed(); }
  // A brand-new list of places starts with the built-in ones (fixed ids and updatedAt 0, so devices agree and any edit wins)
  if (!state.locations.length) {
    const add = W.SEED_LOCATIONS.map(l => ({ ...l, override: l.override ? { ...l.override } : null, updatedAt: 0 }));
    if (add.length) { await db.putMany('locations', add); state.locations.push(...add); }
  }
  state.campaignId = (await db.getMeta('campaignId')) || state.campaigns[0].id;
  if (!campaign() || campaign().deleted) {
    // The campaign this device was on was combined into another (or deleted): move to one that's still here.
    state.campaignId = (state.campaigns.find(c => !c.deleted && c.name === campaign()?.name) || state.campaigns.find(c => !c.deleted)).id;
    await db.setMeta('campaignId', state.campaignId);
    state.sessionId = null;
  }
  const c = campaign();
  if (c.locationId === undefined) { c.locationId = null; await save('campaigns', c); }
  await keepSettingInData();
  applyCalendar();
}
// Each campaign keeps its own calendar, and each place how crowded it is, in your synced data rather than in the
// app's code. Campaigns and places made before that get what the code used to say, once.
async function keepSettingInData() {
  const known = (await db.getMeta('calendars')) || {};
  let learned = false;
  for (const c of state.campaigns) {
    if (c.deleted || c.seed) continue;
    // a device on an older version can save the campaign without its calendar: put back the one this device knew
    if (!c.calendar) { c.calendar = known[c.id] || C.calendarData(); await save('campaigns', c); }
    if (JSON.stringify(known[c.id]) !== JSON.stringify(c.calendar)) { known[c.id] = c.calendar; learned = true; }
  }
  if (learned) await db.setMeta('calendars', known);
  for (const l of state.locations) if (!l.deleted && !l.pop) { l.pop = O.popOf(l); await save('locations', l); }
}
// Use the current campaign's calendar everywhere (dates, months, moons, seasons, weather)
function applyCalendar() { C.setCalendar(campaign()?.calendar); }

// ---------- theme
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.themeResolved = dark ? 'dark' : 'light';
  document.querySelectorAll('#themeSeg button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.theme === (t || 'system'))));
}
let themePref = 'system';
try { themePref = localStorage.getItem('sn-theme') || 'system'; } catch (_) {}
applyTheme(themePref);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(themePref));

// ---------- moons
function moonSVG(moon, epoch, size = 18) {
  const { frac, name } = C.moonPhase(moon, epoch);
  const r = 8, cx = 10, cy = 10, k = Math.cos(2 * Math.PI * frac), rx = Math.abs(k) * r;
  let d;
  if (frac <= 0.5) d = `M${cx},${cy - r} A${r},${r} 0 0 1 ${cx},${cy + r} A${rx},${r} 0 0 ${k > 0 ? 0 : 1} ${cx},${cy - r}Z`;
  else d = `M${cx},${cy - r} A${r},${r} 0 0 0 ${cx},${cy + r} A${rx},${r} 0 0 ${k > 0 ? 1 : 0} ${cx},${cy - r}Z`;
  return `<svg class="moon" viewBox="0 0 20 20" width="${size}" height="${size}" role="img" aria-label="${esc(moon.name)}: ${name}"><title>${esc(moon.name)}: ${name}</title><circle cx="10" cy="10" r="8" class="moon-dark"/><path d="${d}" fill="${moon.color}"/><circle cx="10" cy="10" r="8" class="moon-rim"/></svg>`;
}

// ---------- header
function renderHeader() {
  const t = now(), d = C.fromMinutes(t);
  $('#campaignBtn').textContent = campaign().name;
  $('#clockDate').textContent = C.fmtDate(t);
  $('#clockTime').textContent = `${C.fmtTime(t)} · ${C.seasonOf(d.month, d.day)}`;
  $('#clockMoons').innerHTML = C.CAL.moons.map(m => moonSVG(m, d.epoch, 20)).join('');
  const loc = hereLoc(), wn = loc ? wxNow() : null;
  $('#wxBtn').innerHTML = wn
    ? `${W.iconSVG(W.weatherIcon(wn.cur), 24)}<span class="wx-chip-text"><b>${W.fmtF(wn.cur.temp)} <small>${esc(W.describe(wn.cur).split(',')[0])}</small></b><span>${esc(loc.name)} · ${W.fmtF(wn.w.low)} / ${W.fmtF(wn.w.high)}</span></span>`
    : `${W.iconSVG('cloud', 24)}<span class="wx-chip-text"><b>Weather</b><span>Pick a location</span></span>`;
  $('#wxBtn').setAttribute('aria-label', wn ? `${loc.name} now: ${W.describe(wn.cur)}, ${W.fmtF(wn.cur.temp)}. Today ${W.fmtF(wn.w.low)} to ${W.fmtF(wn.w.high)}. Open World.` : 'Pick a location for weather');
  document.querySelectorAll('.tabs [data-view]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === state.view)));
}

// ---------- date picker (month/day/year/time)
function pickerHTML(id, t) {
  const d = C.fromMinutes(t);
  return `<div class="picker" id="${id}">
    <label class="field"><span>Day</span><input type="number" inputmode="numeric" data-k="day" min="1" max="30" value="${d.day}"></label>
    <label class="field grow"><span>Month</span><select data-k="month">${C.CAL.months.map((m, i) => `<option value="${i}" ${i === d.month ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Year (CR)</span><input type="number" inputmode="numeric" data-k="year" min="1" value="${d.year}"></label>
    <label class="field"><span>Time</span><input type="time" data-k="time" value="${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')}"></label>
  </div>`;
}
function readPicker(id) {
  const el = document.getElementById(id);
  const v = k => el.querySelector(`[data-k="${k}"]`).value;
  const month = +v('month');
  const day = Math.min(Math.max(1, +v('day') || 1), C.CAL.months[month].length);
  const [hour, minute] = (v('time') || '00:00').split(':').map(Number);
  return C.toMinutes({ year: Math.max(1, +v('year') || 1), month, day, hour, minute });
}

// ---------- views
function render() {
  applyCalendar();
  renderHeader();
  const v = $('#view');
  if (state.view === 'session') v.innerHTML = viewSession();
  if (state.view === 'party') v.innerHTML = viewParty();
  if (state.view === 'calendar') v.innerHTML = viewCalendar();
  if (state.view === 'history') v.innerHTML = viewHistory();
  if (state.view === 'world') v.innerHTML = viewWorld();
  afterRender();
}

function afterRender() {
  document.querySelectorAll('.wx-hours').forEach(el => { const c = el.querySelector('.wx-hr.cur'); if (c) el.scrollLeft = Math.max(0, c.offsetLeft - el.offsetLeft - 8); });
  document.querySelectorAll('textarea.grow').forEach(autoGrow);
  document.querySelectorAll('canvas[data-ink]').forEach(cv => {
    const page = state.ink.find(i => i.id === cv.dataset.ink);
    renderThumb(cv, page?.strokes);
  });
}

function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.max(t.scrollHeight + 2, +t.dataset.min || 0) + 'px'; }

function favorBadge(p) {
  return p.favor?.spent
    ? `<span class="badge spent" title="Spent ${p.favor.at != null ? esc(C.fmtShort(p.favor.at)) : ''}">Spent</span>`
    : `<span class="badge avail">Available</span>`;
}

// ---------- weather card (Session and World tabs)
function wxCard({ big = false } = {}) {
  const loc = hereLoc();
  if (!loc) return `<section class="card wx-card empty"><div><h2>Weather</h2><p class="muted">Choose where the party is to get the day's weather.</p></div><button class="btn primary" data-act="pick-loc">Choose a location</button></section>`;
  const t = now(), ep = Math.floor(t / C.DAY), dl = W.daylight(loc, ep), ec = W.effectiveClimate(loc);
  const { w, hrs, cur, hour } = wxNow();
  const mins = t - ep * C.DAY, isDay = mins >= dl.rise && mins < dl.set;
  const fx = W.effects(w, loc, hrs, hour);
  const tl = W.timeline(hrs);
  return `<section class="card wx-card ${big ? 'big' : ''}">
    <div class="wx-main">
      <div class="wx-glyph">${W.iconSVG(W.weatherIcon(cur), big ? 64 : 48)}</div>
      <div class="wx-text">
        <div class="wx-loc"><button class="link-btn wx-locname" data-act="pick-loc" title="Change location">${esc(loc.name)}</button>${ec.overrideName ? `<span class="badge rime">${esc(ec.overrideName)}</span>` : ''}</div>
        <div class="wx-now"><b>${W.fmtF(cur.temp)}</b> <span>${esc(W.describe(cur))}</span> <span class="muted small">at ${esc(C.fmtTime(t))}</span></div>
        <div class="wx-temps">Today: low <b>${W.fmtF(w.low)}</b> · high <b>${W.fmtF(w.high)}</b> <span class="muted">· ${W.feelsLike(w)}</span></div>
        <div class="wx-desc"><span class="muted">Forecast:</span> ${esc(W.describe(w))}${w.manual ? ' <span class="badge">Set by you</span>' : w.held ? ' <span class="muted small">(same as yesterday)</span>' : ''}${tl ? `<div class="wx-tl">${esc(tl)}</div>` : ''}</div>
        <div class="wx-sun muted small">${dl.twilight ? `Perpetual twilight: the sun never fully rises` : `Sunrise ${W.fmtClock(dl.rise)} · Sunset ${W.fmtClock(dl.set)} · ${dl.hours.toFixed(1)} hours of daylight · ${isDay ? 'Daytime now' : 'Dark now'}`}</div>
      </div>
      <div class="wx-btns">
        <button class="btn small" data-act="pick-loc">Change location</button>
        ${big ? `<button class="btn small" data-act="wx-reroll">Reroll today</button><button class="btn small" data-act="wx-set">Set today's weather</button>` : `<button class="btn small" data-act="goto-world">Weather tools</button>`}
      </div>
    </div>
    ${hourStrip(hrs, hour)}
    ${fx.length ? `<div class="wx-fx">${fx.map(f => `<details class="fx fx-${f.id}${f.now ? ' now' : ''}"><summary>${esc(f.name)}${f.now && f.id !== 'twilight' ? ' <span class="badge now">Now</span>' : ''}</summary><p>${esc(f.text)} <span class="muted">(${esc(f.src)})</span></p></details>`).join('')}</div>` : ''}
  </section>`;
}
// Hour-by-hour strip, starting at the current hour and running to midnight (earlier hours scroll back).
function hourStrip(hrs, hour) {
  const short = h => { const x = h % 12 || 12; return `${x} ${h < 12 ? 'AM' : 'PM'}`; };
  return `<div class="wx-hours" role="list" aria-label="Today hour by hour" data-now="${hour}">${hrs.map(x => `<div class="wx-hr${x.hour === hour ? ' cur' : x.hour < hour ? ' past' : ''}${x.precip ? ' wet' : ''}" role="listitem" title="${esc(short(x.hour))}: ${esc(W.describe(x))}, ${W.fmtF(x.temp)}">
      <span class="hr-t">${x.hour === hour ? 'Now' : short(x.hour)}</span>
      ${W.iconSVG(W.weatherIcon(x), 22)}
      <b>${W.fmtF(x.temp)}</b>
      <span class="hr-p">${x.precip ? (x.precip === 2 ? 'Heavy ' : '') + x.precipType : x.wind === 2 ? 'Windy' : x.fog ? 'Fog' : '&nbsp;'}</span>
    </div>`).join('')}</div>`;
}

// ---------- survival card (Session tab)
const condLevel = n => (n <= 1 ? 'good' : n === 2 ? 'ok' : n === 3 ? 'mild' : n === 4 ? 'warn' : 'bad');
function condCell(p, k) {
  const sv = surv(p), cond = H.CONDITIONS.find(c => c.id === k), n = sv[k];
  return `<div class="cond lv-${condLevel(n)}" data-k="${k}">
    <button class="cond-btn" data-act="cond-dec" aria-label="Better ${cond.name.toLowerCase()} for ${esc(p.name)}">−</button>
    <span class="cond-name">${cond.stages[n]}${sv.exhausting[k] ? ' <b class="ex" title="Causing exhaustion until a rest">+1</b>' : ''}</span>
    <button class="cond-btn" data-act="cond-inc" aria-label="Worse ${cond.name.toLowerCase()} for ${esc(p.name)}">+</button>
  </div>`;
}
function survivalCard() {
  if (!survivalOn()) return '';
  const pcs = presentPcs(), c = campaign(), scarce = supplies() === 'scarce';
  for (const p of pcs) if (refreshFlags(p)) saveSoon('pcs', p, 200);
  const meal = scarce && c.mealPending ? `<div class="meal">
      <b>${c.mealPending === 'dawn' ? 'Breakfast' : 'Supper'} time: who's eating and drinking?</b>
      <div class="meal-grid">${pcs.map(p => { const sv = surv(p); return `<div class="meal-pc"><span>${esc(p.name)}</span>
        <label class="check small"><input type="checkbox" data-meal="food" data-pc="${p.id}" ${sv.food > 0 ? 'checked' : 'disabled'}> Food (${sv.food})</label>
        <label class="check small"><input type="checkbox" data-meal="water" data-pc="${p.id}" ${sv.water > 0 ? 'checked' : 'disabled'}> Water (${sv.water})</label></div>`; }).join('')}</div>
      <div class="row left"><button class="btn primary small" data-act="meal-eat">Eat and drink</button><button class="btn small" data-act="meal-skip">Skip this meal</button></div>
    </div>` : '';
  const rows = pcs.map(p => {
    const sv = surv(p), tn = tempNow(p), ex = conditionExhaustion(p);
    const best = Math.min(sv.hunger, sv.thirst, sv.fatigue, tn ? tn.stage : 6);
    const tempCell = tn ? `<div class="cond lv-${condLevel(tn.stage)} temp"><span class="cond-name">${tn.side === 'cold' ? '❄ ' : tn.side === 'hot' ? '☀ ' : ''}${H.CONDITIONS[3].stages[tn.stage]}${sv.exhausting.temp ? ' <b class="ex" title="Causing exhaustion until a rest">+1</b>' : ''}</span>
        <button class="cond-btn gear" data-act="gear" aria-label="Gear and protection for ${esc(p.name)}" title="Gear and protection">⚙</button></div>` : '<span class="muted small">Pick a location</span>';
    return `<tr data-pc="${p.id}">
      <th scope="row"><span class="pc-name">${esc(p.name)}</span></th>
      <td data-label="Hunger">${condCell(p, 'hunger')}</td><td data-label="Thirst">${condCell(p, 'thirst')}</td><td data-label="Fatigue">${condCell(p, 'fatigue')}</td><td data-label="Temperature">${tempCell}</td>
      <td class="exh" data-label="Exhaustion" title="Stage 5–6 conditions add 1 each (up to 3); top-stage conditions take 1 away">${ex.plus - ex.zeros > 0 ? `<b>+${ex.plus - ex.zeros}</b>` : '<span class="muted">0</span>'}${ex.plus && ex.zeros ? `<span class="muted small"> (+${ex.plus} −${ex.zeros})</span>` : ''}</td>
      <td data-label=""><button class="btn small" data-act="stamina">Stamina ${H.STAMINA_DC[best] ? `DC ${H.STAMINA_DC[best]}` : ''}</button></td>
      ${scarce ? `<td class="rations" data-label="Rations"><span>Food <button class="mini-btn" data-act="ration" data-r="food" data-d="-1">−</button><b>${sv.food}</b><button class="mini-btn" data-act="ration" data-r="food" data-d="1">+</button></span>
        <span>Water <button class="mini-btn" data-act="ration" data-r="water" data-d="-1">−</button><b>${sv.water}</b><button class="mini-btn" data-act="ration" data-r="water" data-d="1">+</button></span></td>` : ''}
    </tr>`;
  }).join('');
  return `<section class="card surv-card" id="sec-survival">
    <div class="card-head"><h2>Survival</h2>
      <div class="seg small-seg" role="radiogroup" aria-label="Supplies">
        <button type="button" role="radio" data-act="supplies" data-v="plentiful" aria-checked="${!scarce}">Plentiful supplies</button>
        <button type="button" role="radio" data-act="supplies" data-v="scarce" aria-checked="${scarce}">Scarce supplies</button>
      </div>
      <label class="check small shelter"><input type="checkbox" data-act-change="sheltered" ${c.sheltered ? 'checked' : ''}> Indoors or sheltered</label>
    </div>
    ${meal}
    ${activePcs().some(p => isAbsent(p.id)) ? `<p class="muted small">Sitting out while their player is absent: ${esc(activePcs().filter(p => isAbsent(p.id)).map(p => p.name).join(', '))}.</p>` : ''}
    <div class="table-wrap"><table class="surv">
      <thead><tr><th>PC</th><th>Hunger</th><th>Thirst</th><th>Fatigue</th><th>Temperature</th><th>Exhaustion</th><th></th>${scarce ? '<th>Rations</th>' : ''}</tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="muted">No active characters.</td></tr>'}</tbody>
    </table></div>
    <div class="surv-actions">
      <button class="btn small" data-act="sleep-good">Good night's sleep (−3 fatigue)</button>
      <button class="btn small" data-act="sleep-bad">Disturbed sleep (−1 fatigue)</button>
      <button class="btn small" data-act="short-rest">Short rest</button>
      ${scarce ? '<button class="btn small" data-act="ration-all">Give everyone rations</button>' : ''}
    </div>
    <p class="muted small">Darker Dungeons: dawn +1 hunger and thirst, noon +1 fatigue, dusk +1 to all three; stage 5–6 adds a level of exhaustion (up to 3) until it's better and they rest.${scarce ? '' : ' Plentiful supplies: they eat and drink as normal, so hunger and thirst only move for a disease or if you change them.'} Temperature comes from today's weather and the time of day <span class="flag">(homebrew conversion)</span>.</p>
  </section>`;
}

// ---------- disease card (Session tab)
function caseLine(cs) {
  const d = disById(cs.diseaseId), pc = state.pcs.find(p => p.id === cs.pcId);
  const due = cs.state !== 'declining' && cs.dueAt <= now();
  let status;
  if (cs.state === 'incubating') status = `Incubating · Infection check ${due ? 'due now' : `on ${C.fmtShort(cs.dueAt)}`}`;
  else if (cs.state === 'sick') status = `Stage ${cs.stage} of 4 · Escalation check ${due ? 'due now' : `on ${C.fmtShort(cs.dueAt)}`}`;
  else status = `Getting better · stage ${cs.stage} · improves again ${C.fmtShort(cs.dueAt)}`;
  let contagious = '';
  if (cs.state !== 'incubating' && d.transmission) {
    if (cs.stage >= 4) contagious = 'Always contagious';
    else { const share = H.CONTAGIOUS[cs.stage]; contagious = `Contagious below ${share * 100}% HP${pc?.maxHp ? ` (under ${Math.ceil(pc.maxHp * share)} HP)` : ''}`; }
  }
  const effects = cs.state === 'incubating' ? [] : H.activeEffects(d, cs.stage);
  return `<li class="case ${due ? 'due' : ''} st-${cs.state}" data-case="${cs.id}">
    <div class="case-top"><div><b>${esc(pc?.name || '?')}</b>: ${esc(d?.name || 'Unknown disease')} <span class="muted small">(DC ${d?.dc}, ${esc(d?.transmission || '')})</span></div>
      ${due ? '<span class="badge due-badge">Check due</span>' : ''}${cs.state !== 'incubating' || cs.revealed ? '<span class="badge">On their sheet</span>' : ''}</div>
    <div class="case-status">${esc(status)}${cs.bedRest ? ' · <b>bed rest: advantage on the next check</b>' : ''}${cs.disadvantage && cs.state === 'incubating' ? ' · infection check at disadvantage' : ''}</div>
    ${effects.length ? `<ul class="case-fx">${effects.map((e, i) => `<li><span class="muted">Stage ${i + 1}:</span> ${esc(e)}</li>`).join('')}</ul>` : ''}
    ${contagious ? `<div class="muted small">${esc(contagious)} · Diagnosis: Medicine (Wisdom or Intelligence) DC ${H.RARITY_DC[d.rarity] || 10}</div>` : ''}
    <div class="case-btns">
      ${due ? `<button class="btn small primary" data-act="case-check">${cs.state === 'incubating' ? 'Roll infection check' : 'Roll escalation check'}</button>` : ''}
      ${cs.state === 'sick' ? `<button class="btn small" data-act="case-bedrest">${cs.bedRest ? 'Cancel bed rest' : 'Bed rest or first aid'}</button>` : ''}
      ${cs.state !== 'incubating' ? `<button class="btn small" data-act="case-magic">Treated with magic</button>` : ''}
      ${cs.state === 'declining' ? `<button class="btn small" data-act="case-relapse">Exposed again</button>` : ''}
      ${cs.state !== 'incubating' && cs.stage >= 4 ? `<button class="btn small danger-text" data-act="case-died">They died</button>` : ''}
      ${cs.state === 'incubating' ? `<button class="btn small" data-act="case-reveal" title="Shows the disease's name on the player's character sheet before symptoms start. Once symptoms start it shows there on its own.">${cs.revealed ? 'Hide from their sheet' : 'Reveal on their sheet'}</button>` : ''}
      <button class="link-btn" data-act="case-remove">Remove</button>
    </div>
  </li>`;
}
function diseaseCard() {
  const list = openCases().sort((a, b) => a.dueAt - b.dueAt);
  const loc = hereLoc();
  const ob = loc ? activeOutbreaksAt(loc.id) : [];
  return `<section class="card dis-card" id="sec-diseases">
    <div class="card-head"><h2>Diseases</h2><span class="muted small">Darker Dungeons rules</span><button class="btn small push" data-act="exposure">Log an exposure</button></div>
    ${ob.map(o => `<p class="outbreak">Going around in ${esc(loc.name)}: <b>${esc(disById(o.diseaseId)?.name || '?')}</b>${o.severity ? ` (${esc(O.SEVERITY[o.severity].label.toLowerCase())})` : ''} since ${esc(C.fmtShort(o.startAt))}${o.note ? ` · ${esc(o.note)}` : ''}</p>`).join('')}
    ${obPromptHTML()}
    ${list.length ? `<ul class="case-list">${list.map(caseLine).join('')}</ul>` : '<p class="muted">No one is sick.</p>'}
  </section>`;
}

function diseaseSummary(pcId) {
  const cs = openCases(pcId);
  if (!cs.length) return '<span class="muted">—</span>';
  return cs.map(c => { const d = disById(c.diseaseId); const due = c.state !== 'declining' && c.dueAt <= now();
    return `<span class="dis-chip ${due ? 'due' : ''}">${esc(d?.name || '?')}${c.state === 'incubating' ? ' (incubating)' : c.state === 'declining' ? ` (better, ${c.stage})` : ` (${c.stage})`}</span>`; }).join(' ');
}

function worldDiseases() {
  const lib = liveDiseases();
  const t = now();
  const over = o => !O.isActive(o, t);
  const obs = state.outbreaks.filter(o => o.campaignId === state.campaignId && !o.deleted && o.startAt <= t && (!over(o) || (o.endedAt || o.endAt || 0) > t - 4 * O.WEEK))
    .sort((a, b) => (over(a) ? 1 : 0) - (over(b) ? 1 : 0) || b.startAt - a.startAt);
  return `<section class="card">
      <div class="card-head"><h2>Outbreaks</h2><span class="muted small">Diseases going around a place. The Session tab shows them when the party is there, and asks for exposure rolls.</span><button class="btn small push" data-act="outbreak-new">Start an outbreak</button></div>
      ${obs.length ? `<ul class="ob-list">${obs.map(o => `<li data-ob="${o.id}" class="${over(o) ? 'ended' : ''}"><span><b>${esc(disById(o.diseaseId)?.name || '?')}</b> in ${esc(locById(o.locationId)?.name || '?')}${o.severity ? ` · ${esc(O.SEVERITY[o.severity].label)}` : ''} · since ${esc(C.fmtShort(o.startAt))}${over(o) ? ` · over ${esc(C.fmtShort(o.endedAt || o.endAt))}` : o.endAt ? ` · <span class="muted">likely over around ${esc(C.fmtShort(o.endAt))}</span>` : ''}${o.random ? ' <span class="badge">Rolled</span>' : ''}${o.note ? ` · ${esc(o.note)}` : ''}</span>
        ${over(o) ? '<button class="link-btn" data-act="outbreak-del">Remove</button>' : '<button class="btn small" data-act="outbreak-end">It\'s over</button>'}</li>`).join('')}</ul>` : '<p class="muted">No outbreaks.</p>'}
      <p class="muted small">${randomOutbreaksOn() ? `Outbreaks also start on their own (${esc(O.FREQ[campaign().outbreakFreq || 'normal'].label.toLowerCase())}), more in crowded cities, with the season and climate deciding which diseases. <span class="flag">Homebrew</span>: Darker Dungeons has no rules for this. Change it in Settings.` : 'Random outbreaks are off. Turn them on in Settings.'}</p>
    </section>
    <section class="card">
      <div class="card-head"><h2>Disease library</h2><span class="muted small">Darker Dungeons is third-party, not one of your WotC books.</span><button class="btn small push" data-act="disease-new">Create a disease</button></div>
      <div class="dis-lib">${lib.map(d => `<details class="dis-item" data-dis="${d.id}"><summary><b>${esc(d.name)}</b> <span class="muted small">${esc(d.rarity)} · DC ${d.dc} · ${H.fmtIncubation(d.incubation)} · ${esc(d.transmission)}</span> <span class="badge ${d.source === 'Homebrew' ? 'spent' : ''}">${esc(d.source)}</span></summary>
        <p>${esc(d.description)}</p>
        <ol class="dis-stages">${d.stages.map((st, i) => `<li>${esc(st)}${stageFxLine(d, i)}</li>`).join('')}</ol>
        <p><b>Cured:</b> ${esc(d.cured)}</p>
        <div class="row left"><button class="btn small" data-act="disease-edit">Edit</button></div>
      </details>`).join('')}</div>
    </section>`;
}

// ---------- training card
function trainingCard() {
  const list = campaignTraining();
  const active = list.filter(t => t.state === 'active').sort((a, b) => T.trainingStatus(a, now()).finishAt - T.trainingStatus(b, now()).finishAt);
  const done = list.filter(t => t.state === 'complete').sort((a, b) => b.completedAt - a.completedAt);
  const row = t => {
    const st = T.trainingStatus(t, now()), left = st.total - st.done;
    return `<li class="train" data-train="${t.id}">
      <div class="train-top"><b>${esc(pcName(t.pcId))}</b>: ${esc(t.what)} <span class="muted small">(${T.KINDS[t.kind].label}, ${esc(t.ability)} ${t.mod >= 0 ? '+' : ''}${t.mod})</span>
        ${st.paused ? '<span class="badge">Paused</span>' : ''}</div>
      <div class="bar" role="progressbar" aria-valuenow="${Math.round(st.frac * 100)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${(st.frac * 100).toFixed(1)}%"></i></div>
      <div class="train-meta small">${C.fmtSpan(left)} left · finishes ${esc(C.fmtShort(st.finishAt))}${st.paused ? ' if resumed now' : ''} · ${T.KINDS[t.kind].hours} hours a day · ${esc(T.TRAINERS[t.trainer].label)}${t.trainerName ? ` (${esc(t.trainerName)})` : ''} · ${t.costPerDay ? `${T.fmtGp(t.costPerDay)} a day, ${T.fmtGp(t.costPerDay * t.days)} in all` : 'no fee'}</div>
      <div class="case-btns"><button class="btn small" data-act="train-edit">Edit</button><button class="btn small" data-act="train-pause">${st.paused ? 'Resume' : 'Pause'}</button><button class="link-btn" data-act="train-remove">Remove</button></div>
    </li>`;
  };
  return `<section class="card" id="sec-training">
    <div class="card-head"><h2>Downtime training</h2><span class="muted small">Table rule</span><button class="btn small push" data-act="train-new">Start training</button></div>
    ${active.length ? `<ul class="train-list">${active.map(row).join('')}</ul>` : '<p class="muted">No one is training.</p>'}
    ${done.length ? `<details class="done-list"><summary>Finished (${done.length})</summary><ul>${done.map(t => `<li>${esc(pcName(t.pcId))}: ${esc(t.what)} <span class="muted small">· ${esc(C.fmtShort(t.completedAt))}</span></li>`).join('')}</ul></details>` : ''}
  </section>`;
}

// ---------- the item broker's card
function tradeLine(t) {
  const ready = t.state === 'searching' && t.dueAt <= now();
  const buy = t.kind === 'buy';
  const m = t.math, up = m.timing === 'upfront';
  const money = m.advance != null // requests made before the fee choice existed
    ? `Offer ${T.fmtGp(m.offer)} − ${esc(brokerShort())}'s 20% (${T.fmtGp(m.fee)}) − advance already paid (${T.fmtGp(m.advance)}) = <b>${T.fmtGp(m.payout)} to pay out</b>`
    : buy ? (up ? `${feeSettleText(m, true)} <b>${T.fmtGp(m.dueOnDelivery)}</b> due on delivery (${T.fmtGp(m.total)} in all).`
                : `${T.fmtGp(m.price)} + ${esc(brokerShort())}'s 20% (${T.fmtGp(m.fee)}) = <b>${T.fmtGp(m.total)}</b> due on delivery.`)
    : (up ? `${feeSettleText(m, false)} ${esc(brokerShort())} pays them <b>${T.fmtGp(m.onDelivery)}</b> on delivery (${T.fmtGp(m.payout)} after the fee).`
          : `Offer ${T.fmtGp(m.offer)} − ${esc(brokerShort())}'s 20% (${T.fmtGp(m.fee)}) = <b>${T.fmtGp(m.payout)}</b> paid out on delivery.`);
  return `<li class="trade ${ready ? 'due' : ''}" data-trade="${t.id}">
    <div class="case-top"><div><span class="badge ${buy ? 'rime' : 'avail'}">${buy ? 'Buying' : 'Selling'}</span> <b>${esc(t.item)}</b> <span class="muted small">(${esc(t.rarity)}, base ${T.fmtGp(t.base)}) for ${esc(pcName(t.pcId))}</span></div>
      ${ready ? `<span class="badge due-badge">${esc(brokerShort())} has news</span>` : ''}</div>
    <div class="case-status">${ready ? `${buy ? 'He found a seller' : 'He found a buyer'}: ${esc(t.band)} at ${t.pct}%.` : `Searching · ${buy ? 'seller' : 'buyer'} found ${esc(C.fmtShort(t.dueAt))} (${C.fmtSpan(Math.max(0, t.dueAt - now()))} from now). He'll be a ${esc(t.band.toLowerCase())} at ${t.pct}%.`}</div>
    <div class="small">${money}</div>
    <div class="case-btns">
      ${ready ? (buy ? `<button class="btn small primary" data-act="trade-done">They bought it</button><button class="btn small" data-act="trade-pass">They passed</button>`
                      : `<button class="btn small primary" data-act="trade-done">Paid out</button><button class="btn small" data-act="trade-pass">Called off</button>`) : ''}
      <button class="link-btn" data-act="trade-remove">Remove</button>
    </div>
  </li>`;
}
// "Paid 100 gp up front; his fee came to 113 gp, so 13 gp more is owed" (or refunded).
function feeSettleText(m, buy) {
  const diff = buy ? m.settle : -m.settle;
  const tail = diff > 0 ? `${T.fmtGp(diff)} more is owed` : diff < 0 ? `${brokerShort()} refunds ${T.fmtGp(-diff)}` : 'it comes out even';
  return `Paid ${T.fmtGp(m.deposit)} up front; the 20% fee came to ${T.fmtGp(m.fee)}, so ${tail}.`;
}
function calderCard() {
  const list = campaignTrades();
  const open = list.filter(t => t.state === 'searching').sort((a, b) => a.dueAt - b.dueAt);
  const closed = list.filter(t => t.state !== 'searching').sort((a, b) => (b.closedAt || b.askedAt) - (a.closedAt || a.askedAt));
  const word = { done: 'done', declined: 'passed or called off', failed: `${brokerShort()} couldn't find one` };
  return `<section class="card" id="sec-calder">
    <div class="card-head"><h2>${esc(broker())}</h2><span class="muted small">Magic item broker</span>
      <span class="push btn-pair"><button class="btn small" data-act="trade-new" data-kind="buy">Find an item</button><button class="btn small" data-act="trade-new" data-kind="sell">Sell an item</button></span></div>
    ${open.length ? `<ul class="case-list">${open.map(tradeLine).join('')}</ul>` : '<p class="muted">No open requests.</p>'}
    ${closed.length ? `<details class="done-list"><summary>Past requests (${closed.length})</summary><ul>${closed.map(t => `<li>${t.kind === 'buy' ? 'Buy' : 'Sell'}: ${esc(t.item)} for ${esc(pcName(t.pcId))} · ${esc(word[t.state] || t.state)}${t.state === 'done' ? ` · ${T.fmtGp(t.kind === 'buy' ? t.math.total : t.math.payout)}` : ''}${t.state === 'failed' && t.upfrontPaid ? ` · ${T.fmtGp(t.upfrontPaid)} fee was paid up front` : ''} <span class="muted small">· ${esc(C.fmtShort(t.closedAt || t.askedAt))}</span></li>`).join('')}</ul></details>` : ''}
  </section>`;
}

// ---------- cards to make
function cardsCard() {
  const list = campaignCards();
  const todo = list.filter(c => !c.done).sort((a, b) => a.addedAt - b.addedAt), made = list.filter(c => c.done);
  return `<section class="card" id="sec-cards">
    <div class="card-head"><h2>Cards to make</h2><span class="muted small">Magic items the party has that need a printed card.</span></div>
    <div class="card-add">
      <input id="cardItem" placeholder="Item name" autocomplete="off" aria-label="Item name">
      <select id="cardPc" aria-label="Who has it"><option value="party">The party</option>${activePcs().map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <button class="btn small" data-act="card-add">Add</button>
    </div>
    ${todo.length ? `<ul class="todo">${todo.map(c => `<li data-card="${c.id}"><label class="check"><input type="checkbox" data-act-change="card-done"> <span><b>${esc(c.item)}</b> <span class="muted small">· ${esc(pcName(c.pcId))}${c.note ? ` · ${esc(c.note)}` : ''} · ${esc(C.fmtShort(c.addedAt))}</span></span></label><button class="link-btn" data-act="card-remove">Remove</button></li>`).join('')}</ul>` : '<p class="muted">Nothing waiting for a card.</p>'}
    ${made.length ? `<details class="done-list"><summary>Made (${made.length})</summary><ul>${made.map(c => `<li data-card="${c.id}">${esc(c.item)} <span class="muted small">· ${esc(pcName(c.pcId))}</span> <button class="link-btn" data-act="card-undo">Not made yet</button></li>`).join('')}</ul></details>` : ''}
  </section>`;
}

function viewWorld() {
  const loc = hereLoc();
  const ep = Math.floor(now() / C.DAY);
  let recent = '';
  if (loc) {
    weatherFor(loc, ep);
    const rows = [];
    for (let e = ep; e > ep - 10; e--) { const r = wxIndex.get(wxId(loc.id, e)); if (r) rows.push(r); }
    recent = `<section class="card"><h2>Recent weather in ${esc(loc.name)}</h2>
      <div class="table-wrap"><table class="wx-table"><thead><tr><th>Day</th><th>Weather</th><th>Night</th><th>Day</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${esc(C.fmtDate(r.epoch * C.DAY))}</td><td><span class="wx-inline">${W.iconSVG(W.weatherIcon(r), 20)} ${esc(W.describe(r))}</span></td><td>${W.fmtF(r.low)}</td><td>${W.fmtF(r.high)}</td><td class="muted small">${r.manual ? 'Set by you' : r.held ? 'Held over' : 'New roll'}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted small">Each morning there's a 50% chance yesterday's weather holds, so storms and cold snaps last a few days. Heavy rain or snow ends after 1–3 days.</p></section>`;
  }
  const groups = {};
  for (const l of liveLocations()) (groups[l.region || 'Other'] ||= []).push(l);
  const order = Object.keys(groups).sort((a, b) => a.localeCompare(b));
  const lib = order.map(g => `<details class="loc-group" ${groups[g].some(l => l.id === loc?.id) ? 'open' : ''}><summary>${esc(g)} <span class="muted">(${groups[g].length})</span></summary>
    <ul class="loc-list">${groups[g].sort((a, b) => a.name.localeCompare(b.name)).map(l => `<li data-loc="${l.id}" class="${l.id === loc?.id ? 'here' : ''}">
      <div class="loc-info"><b>${esc(l.name)}</b><span class="muted small">${esc(W.climateById(l.climate).name)}${l.hemisphere === 'south' ? ' · southern hemisphere' : ''}${+l.tempAdjust ? ` · ${l.tempAdjust > 0 ? '+' : ''}${l.tempAdjust}°F` : ''}${l.wind > 0 ? ' · windy' : l.wind < 0 ? ' · sheltered' : ''}${l.fog ? ' · often foggy' : ''}${l.overcast ? ' · always overcast' : ''}</span>
        ${activeOutbreaksAt(l.id).map(o => `<span class="badge spent">Outbreak: ${esc(disById(o.diseaseId)?.name || '?')}</span>`).join(' ')}
        ${l.override ? `<span class="badge ${l.override.active ? 'rime' : ''}">${esc(l.override.name || 'Override')}${l.override.active ? '' : ' (off)'}</span>` : ''}</div>
      <div class="loc-btns">${l.id === loc?.id ? '<span class="pill live">Party is here</span>' : '<button class="btn small" data-act="go-loc">Go here</button>'}<button class="btn small" data-act="edit-loc">Edit</button></div>
    </li>`).join('')}</ul></details>`).join('');
  return `<div class="view-head"><h1>World</h1></div>
    ${wxCard({ big: true })}
    ${recent}
    <section class="card">
      <div class="card-head"><h2>Locations</h2><span class="muted small">Each place has a climate. Temperatures and rain chances are estimates from real-world climates, not from a sourcebook.</span>
        <button class="btn small push" data-act="add-loc">Add a location</button></div>
      ${lib}
    </section>
    ${worldDiseases()}`;
}

function viewSession() {
  const list = campaignSessions();
  if (!list.length) {
    return `<section class="welcome card">
      <h1>Your first session</h1>
      <p>Each session starts filled in: the party's stats, the session number, today's date and the current in-game date. You only change what's different.</p>
      <p class="muted">The party comes from this campaign's characters in the Character Sheet app (or add them on the Party tab). Their Max HP, AC and Passive Perception fill in from their sheets.</p>
      <div class="welcome-row">
        <label class="field"><span>Session number</span><input id="firstNum" type="number" inputmode="numeric" min="1" value="1"></label>
        <button class="btn primary big" data-act="start-first">Start session</button>
      </div>
    </section>`;
  }
  let s = list.find(x => x.id === state.sessionId) || list[0];
  state.sessionId = s.id;
  const isLatest = s.id === list[0].id;
  const open = s.endAt == null;
  const rows = open ? activePcs().map(p => ({ pc: p, v: p })) : (s.party || []).map(sp => ({ pc: state.pcs.find(p => p.id === sp.pcId), v: sp }));
  const pages = inkFor(s);
  const idx = list.indexOf(s);

  return `<article class="session">
    <div class="session-head">
      <div class="session-title">
        <button class="icon-btn" data-act="sess-older" ${idx >= list.length - 1 ? 'disabled' : ''} aria-label="Previous session">‹</button>
        <h1>Session <input class="num-input" data-field="number" type="number" inputmode="numeric" value="${s.number}" aria-label="Session number"></h1>
        <button class="icon-btn" data-act="sess-newer" ${idx === 0 ? 'disabled' : ''} aria-label="Next session">›</button>
        ${open ? '<span class="pill live">In progress</span>' : '<span class="pill">Ended</span>'}
      </div>
      <div class="session-meta">
        <label class="meta-item"><span>Played</span><input type="date" data-field="realDate" value="${esc(s.realDate)}"></label>
        <div class="meta-item"><span>In game, started</span><b>${esc(C.fmtDateTime(s.startAt))}</b>
          ${open ? (now() > s.startAt ? `<em>Now ${esc(C.fmtDateTime(now()))} (${esc(C.fmtSpan(now() - s.startAt))} later)</em>` : '<em>No in-game time has passed yet</em>')
                 : `<em>Ended ${esc(C.fmtDateTime(s.endAt))} (${esc(C.fmtSpan(s.endAt - s.startAt))} later)</em>`}</div>
      </div>
    </div>

    ${open ? `<nav class="jump" aria-label="Jump to">${[['party', 'Party'], ['notes', 'Notes'], ['ink', 'Ink'], ...(diseasesOn() ? [['diseases', 'Diseases']] : []), ...(survivalOn() ? [['survival', 'Survival']] : []), ...(trainingOn() ? [['training', 'Training']] : []), ...(brokerOn() ? [['calder', brokerShort()]] : []), ['cards', 'Cards']].map(([id, l]) => `<a href="#sec-${id}" data-jump="${id}">${l}${id === 'diseases' && (dueCases().length || (campaign().obPrompts || []).length) ? ' <b class="ex">!</b>' : ''}${id === 'calder' && campaignTrades().some(t => t.state === 'searching' && t.dueAt <= now()) ? ' <b class="ex">!</b>' : ''}</a>`).join('')}</nav>` : ''}
    ${open ? wxCard() : (s.locationId && locById(s.locationId) ? `<p class="muted small sess-loc">Started in ${esc(locById(s.locationId).name)}${(s.visited || []).length ? `, then ${(s.visited || []).map(v => esc(locById(v.locationId)?.name || '?')).join(', ')}` : ''}.</p>` : '')}

    <section class="card" id="sec-party">
      <h2>Party</h2>
      <div class="table-wrap"><table class="party">
        <thead><tr><th>PC</th><th>Max HP</th><th>AC</th><th>Pass. Perc.</th><th>Diseases</th><th>Deaths</th><th>Favor of Fate</th></tr></thead>
        <tbody>${rows.map(({ pc, v }) => `<tr data-pc="${pc?.id || ''}" class="${(open ? (s.absent || []).includes(pc?.id) : v.absent) ? 'absent-row' : ''}">
          <th scope="row"><span class="pc-name">${esc(v.name ?? pc?.name)}</span><span class="pc-sub">${esc(pc?.classes || '')}</span>
            ${open && pc ? `<span class="missed">${missedCount(pc.id) ? `Missed ${missedCount(pc.id)} session${missedCount(pc.id) > 1 ? 's' : ''}` : 'No sessions missed'}</span>` : ''}
            ${open && pc ? `<button class="here-btn ${(s.absent || []).includes(pc.id) ? 'away' : ''}" data-act="toggle-absent" aria-pressed="${(s.absent || []).includes(pc.id)}">${(s.absent || []).includes(pc.id) ? 'Absent' : 'Here'}</button>` : (v.absent ? '<span class="badge spent">Absent</span>' : '')}</th>
          ${['maxHp', 'ac', 'pp'].map(k => `<td>${open && pc
            ? `<input class="cell-input" type="number" inputmode="numeric" data-stat="${k}" value="${v[k] ?? ''}" placeholder="—" aria-label="${k}">`
            : `<span class="cell-val">${v[k] ?? '—'}</span>`}</td>`).join('')}
          <td class="dis-cell">${open && pc ? diseaseSummary(pc.id) : esc(v.diseases || '—')}</td>
          <td><span class="deaths">${open && pc ? pc.deaths.length : (v.deaths ?? 0)}</span>${open && pc ? `<button class="mini-btn" data-act="death" title="Log a death" aria-label="Log a death for ${esc(pc.name)}">+</button>` : ''}</td>
          <td>${open && pc ? favorBadge(pc) : (v.favorSpent ? '<span class="badge spent">Spent</span>' : '<span class="badge avail">Available</span>')}</td>
        </tr>`).join('') || `<tr><td colspan="7" class="muted">${open ? 'No active characters. Add them on the Party tab.' : `The party's stats weren't recorded for this session.${absentNames(s) ? ` Absent: ${esc(absentNames(s))}.` : ''}`}</td></tr>`}</tbody>
      </table></div>
      ${open ? '' : '<p class="muted small">Stats as they were when this session ended.</p>'}
    </section>


    <section class="card notes-card" id="sec-notes">
      <div class="card-head"><h2>Notes</h2><span class="muted small">Write with the S Pen; it turns into text you can search.</span></div>
      <textarea class="ruled grow" data-field="notes" data-min="420" placeholder="What happened this session…">${esc(s.notes)}</textarea>
    </section>

    <section class="card">
      <div class="card-head" id="sec-ink"><h2>Ink pages</h2><span class="muted small">Freehand pages for sketches and quick scribbles.</span></div>
      <div class="ink-grid">
        ${pages.map((pg, i) => `<button class="ink-thumb" data-act="open-ink" data-id="${pg.id}" aria-label="Open ink page ${i + 1}"><canvas data-ink="${pg.id}"></canvas><span>Page ${i + 1}</span></button>`).join('')}
        <button class="ink-thumb add" data-act="new-ink"><span class="plus">+</span><span>New ink page</span></button>
      </div>
    </section>

    ${open ? (diseasesOn() ? diseaseCard() : '') + survivalCard() + (trainingOn() ? trainingCard() : '') + (brokerOn() ? calderCard() : '') + cardsCard() : ''}
    <section class="card">
      <div class="card-head"><h2>Shopping notes</h2><span class="muted small">Anything else to remember from this session's shopping.</span></div>
      <textarea class="ruled grow" data-field="shopping" data-min="110" placeholder="Bought, sold, haggled over…">${esc(s.shopping)}</textarea>
    </section>

    <div class="session-actions">
      ${open && isLatest ? `<button class="btn" data-act="end-session">End session</button>` : ''}
      ${isLatest ? `<button class="btn primary" data-act="next-session">${open ? 'End and start' : 'Start'} session ${s.number + 1}</button>` : ''}
      ${!open && isLatest ? `<button class="btn" data-act="reopen-session">Reopen</button>` : ''}
      <span class="spacer"></span>
      <button class="btn danger-text" data-act="delete-session">Delete session</button>
    </div>
  </article>`;
}

function viewParty() {
  const pcs = livePcs();
  // which characters are tied to a Character Sheet character (by permanent id), and whether its sheet is reachable live
  const { core } = suiteNow();
  const sheets = new Map((core?.cachedParty?.() || []).map(c => [c.id, c]));
  const linkTag = p => {
    if (!p.charId) return '<span class="badge">Not linked to a character sheet</span>';
    const ch = sheets.get(p.charId);
    if (!ch) return '<span class="badge">Linked, sheet not found yet</span>';
    return `<span class="badge on-sheet">Linked to ${esc(ch.name || 'their sheet')}'s sheet${ch.liveKey ? ' · live' : ''}</span>`;
  };
  const card = p => {
    const deaths = p.deaths.slice().sort((a, b) => a.at - b.at);
    return `<article class="card pc-card ${p.active === false ? 'retired' : ''}" data-pc="${p.id}">
      <div class="pc-top">
        <div><h2>${esc(p.name)}</h2><p class="muted">${esc([p.ancestry, p.classes].filter(Boolean).join(' · ') || 'No details yet')}${p.player ? ` · played by ${esc(p.player)}` : ''}</p>${linkTag(p)}</div>
        <div class="pc-btns">
          <button class="btn small" data-act="edit-pc">Edit</button>
          <button class="btn small" data-act="toggle-active">${p.active === false ? 'Bring back' : 'Retire'}</button>
        </div>
      </div>
      <div class="stat-row">
        ${[['maxHp', 'Max HP'], ['ac', 'AC'], ['pp', 'Pass. Perc.']].map(([k, l]) => `<label class="stat"><span>${l}</span><input class="cell-input" type="number" inputmode="numeric" data-stat="${k}" value="${p[k] ?? ''}" placeholder="—"></label>`).join('')}
        <div class="stat"><span>Deaths</span><b class="deaths big">${p.deaths.length}</b></div>
        <div class="stat"><span>Sessions missed</span><b class="deaths big">${missedCount(p.id)}</b></div>
        <div class="stat"><span>Favor of Fate</span>${favorBadge(p)}</div>
      </div>
      <div class="pc-cols">
        <div>
          <h3>Deaths</h3>
          ${deaths.length ? `<ol class="death-list">${deaths.map(d => `<li><b>${esc(C.fmtShort(d.at))}</b> ${esc(d.note || 'No details')}${d.favor ? ' <span class="badge spent">Revived by Favor of Fate</span>' : ''} <button class="link-btn" data-act="del-death" data-id="${d.id}" aria-label="Remove this death">Remove</button></li>`).join('')}</ol>` : '<p class="muted small">None yet.</p>'}
          <button class="btn small" data-act="death">Log a death</button>
        </div>
        ${(p.learned || []).length ? `<div><h3>Training finished</h3><ul class="death-list">${p.learned.map(l => `<li><b>${esc(C.fmtShort(l.at))}</b> ${esc(l.text)}</li>`).join('')}</ul></div>` : ''}
        <div>
          <h3>Favor of Fate</h3>
          ${p.favor?.spent
            ? `<p class="small">Spent on ${p.favor.at != null ? esc(C.fmtShort(p.favor.at)) : 'an unrecorded date'}${p.favor.note ? `: ${esc(p.favor.note)}` : ''}.</p><button class="btn small" data-act="favor-restore">Give the coin back</button>`
            : `<p class="small">Their coin is unspent: one revival, once.</p><button class="btn small" data-act="favor-spend">Mark as spent</button>`}
        </div>
      </div>
    </article>`;
  };
  const active = pcs.filter(p => p.active !== false), retired = pcs.filter(p => p.active === false);
  return `<div class="view-head"><h1>Party</h1><button class="btn primary" data-act="add-pc">Add a character</button></div>
    <p class="muted shared-note">The party comes from this campaign's characters in the Character Sheet app, and every app uses the same characters. What you track here (deaths, Favor of Fate, diseases, survival) shows on their sheets right away.</p>
    ${active.map(card).join('') || '<p class="muted">No active characters.</p>'}
    ${retired.length ? `<details class="retired-list"><summary>Retired or departed (${retired.length})</summary>${retired.map(card).join('')}</details>` : ''}`;
}

function viewCalendar() {
  const cur = C.fromMinutes(now());
  if (!state.calMonth) state.calMonth = { year: cur.year, month: cur.month };
  const { year, month } = state.calMonth;
  const m = C.CAL.months[month];
  const first = C.epochOf(year, month, 1);
  const lead = C.weekdayOf(first);
  const sessByEpoch = {};
  for (const s of campaignSessions()) (sessByEpoch[Math.floor(s.startAt / C.DAY)] ||= []).push(s);
  // Weather already recorded for this campaign: prefer where the party is now, otherwise any place that day.
  const wxByEpoch = {};
  const hereId = campaign().locationId;
  if (hereLoc()) weatherFor(hereLoc(), cur.epoch);
  for (const w of state.weather) if (w.campaignId === state.campaignId && (!wxByEpoch[w.epoch] || w.locationId === hereId)) wxByEpoch[w.epoch] = w;
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="cal-cell empty" aria-hidden="true"></div>');
  for (let d = 1; d <= m.length; d++) {
    const ep = first + d - 1;
    const isToday = ep === cur.epoch;
    const moons = C.CAL.moons.map(mo => {
      const ph = C.moonPhase(mo, ep).name, prev = C.moonPhase(mo, ep - 1).name;
      return (ph === 'Full' || ph === 'New') && ph !== prev ? `<span class="cal-moon" title="${esc(mo.name)} ${ph}">${moonSVG(mo, ep, 14)}</span>` : '';
    }).join('');
    const evs = C.eventsOn(month, d);
    const ss = sessByEpoch[ep] || [];
    const sel = state.calDay === d;
    cells.push(`<button class="cal-cell${isToday ? ' today' : ''}${sel ? ' sel' : ''}" data-act="cal-day" data-day="${d}" aria-label="${d} ${esc(m.name)}${isToday ? ', current in-game day' : ''}">
      <span class="cal-num">${d}${isToday ? '<span class="cal-now">Now</span>' : ''}</span><span class="cal-moons">${moons}</span>
      ${evs.map(e => `<span class="cal-ev ${e.kind}">${esc(e.name)}</span>`).join('')}
      ${ss.map(s => `<span class="cal-sess">Session ${s.number}</span>`).join('')}
      ${wxByEpoch[ep] && ep <= cur.epoch ? `<span class="cal-wx" title="${esc(W.describe(wxByEpoch[ep]))}">${W.iconSVG(W.weatherIcon(wxByEpoch[ep]), 16)}${W.fmtF(wxByEpoch[ep].high)}</span>` : ''}
    </button>`);
  }
  let detail = '';
  if (state.calDay) {
    const d = state.calDay, ep = first + d - 1;
    const t = ep * C.DAY + cur.hour * 60 + cur.minute;
    const evs = C.eventsOn(month, d);
    const ss = sessByEpoch[ep] || [];
    detail = `<section class="card day-detail">
      <h2>${esc(C.fmtDate(t))}</h2>
      <p class="muted">${C.seasonOf(month, d)}</p>
      <ul class="moon-list">${C.CAL.moons.map(mo => { const ph = C.moonPhase(mo, ep); return `<li>${moonSVG(mo, ep, 22)} <b>${esc(mo.name)}</b> ${ph.name} <span class="muted">(day ${ph.day} of ${mo.cycle})</span></li>`; }).join('')}</ul>
      ${wxByEpoch[ep] && ep <= cur.epoch ? `<p class="wx-inline">${W.iconSVG(W.weatherIcon(wxByEpoch[ep]), 22)} ${esc(locById(wxByEpoch[ep].locationId)?.name || '')}: ${esc(W.describe(wxByEpoch[ep]))}, ${W.fmtF(wxByEpoch[ep].low)} to ${W.fmtF(wxByEpoch[ep].high)}</p>` : ''}
      ${evs.map(e => `<div class="ev-detail"><b>${esc(e.label)}</b>${e.description ? `<p class="small">${esc(e.description)}</p>` : ''}</div>`).join('')}
      ${ss.map(s => `<button class="link-btn" data-act="goto-session" data-id="${s.id}">Session ${s.number} started this day</button>`).join(' ')}
      ${ep !== cur.epoch ? `<div class="row left"><button class="btn" data-act="cal-set" data-epoch="${ep}">Make this the current in-game day</button></div>` : '<p class="small"><b>This is the current in-game day.</b></p>'}
    </section>`;
  }
  return `<div class="view-head cal-head">
      <button class="icon-btn" data-act="cal-prev" aria-label="Previous month">‹</button>
      <h1>${esc(m.name)} <span class="muted">${year} ${C.CAL.era}</span></h1>
      <button class="icon-btn" data-act="cal-next" aria-label="Next month">›</button>
      <span class="spacer"></span>
      <button class="btn" data-act="cal-today">Current day</button>
    </div>
    <div class="cal-grid" role="grid">
      ${C.CAL.weekdays.map(w => `<div class="cal-wd" role="columnheader">${esc(w)}</div>`).join('')}
      ${cells.join('')}
    </div>
    <p class="muted small cal-legend">Moon icons mark the day each moon turns full or new. Weekdays run straight through the year, so each month starts on a different day.</p>
    ${detail}`;
}

function snippet(text, q) {
  const f = fold(text), i = f.indexOf(q);
  if (i < 0) return null;
  const start = Math.max(0, i - 60), end = Math.min(text.length, i + q.length + 80);
  return (start > 0 ? '…' : '') + esc(text.slice(start, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length, end)) + (end < text.length ? '…' : '');
}

const missedCount = pcId => campaignSessions().filter(x => (x.absent || []).includes(pcId)).length;
const absentNames = s => (s.absent || []).map(id => state.pcs.find(p => p.id === id)?.name).filter(Boolean).join(', ');
function viewHistory() {
  const q = fold(state.query.trim());
  const list = campaignSessions();
  let body;
  if (q) {
    const hits = [];
    for (const s of list) {
      const parts = [['Notes', s.notes], ['Shopping', s.shopping]].map(([l, t]) => [l, snippet(t || '', q)]).filter(x => x[1]);
      if (parts.length) hits.push(`<button class="hist-item" data-act="goto-session" data-id="${s.id}">
        <span class="hist-title">Session ${s.number}<span class="muted"> · ${esc(fmtReal(s.realDate))} · ${esc(C.fmtShort(s.startAt))}</span></span>
        ${parts.map(([l, sn]) => `<span class="hist-snip"><b>${l}:</b> ${sn}</span>`).join('')}</button>`);
    }
    for (const p of livePcs()) for (const d of p.deaths) {
      const sn = snippet(d.note || '', q);
      const nameHit = fold(p.name).includes(q);
      if (sn || nameHit) hits.push(`<div class="hist-item static"><span class="hist-title">${esc(p.name)} died<span class="muted"> · ${esc(C.fmtShort(d.at))}</span></span><span class="hist-snip">${sn || esc(d.note || 'No details')}</span></div>`);
    }
    body = hits.join('') || `<p class="muted">Nothing found for “${esc(state.query)}”.</p>`;
  } else {
    body = list.map(s => `<button class="hist-item" data-act="goto-session" data-id="${s.id}">
      <span class="hist-title">Session ${s.number}<span class="muted"> · ${esc(fmtReal(s.realDate))}</span></span>
      <span class="hist-sub">${esc(C.fmtShort(s.startAt))}${s.endAt != null ? ` → ${esc(C.fmtShort(s.endAt))}` : ' · in progress'}${inkFor(s).length ? ` · ${inkFor(s).length} ink page${inkFor(s).length > 1 ? 's' : ''}` : ''}</span>
      ${absentNames(s) ? `<span class="hist-sub">Absent: ${esc(absentNames(s))}</span>` : ''}
      <span class="hist-snip">${esc((s.notes || '').slice(0, 180)) || '<i class="muted">No notes</i>'}</span></button>`).join('') || '<p class="muted">No sessions yet.</p>';
  }
  return `<div class="view-head"><h1>History</h1><button class="btn primary" data-act="past-new">Add a past session</button></div>
    <label class="search"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
      <input id="searchInput" type="search" placeholder="Search notes, shopping and deaths" value="${esc(state.query)}" autocomplete="off" aria-label="Search"></label>
    <div class="hist-list">${body}</div>`;
}

// ---------- actions
async function startSession(number) {
  const s = { id: uid(), campaignId: state.campaignId, number, realDate: todayISO(), startAt: now(), endAt: null, locationId: campaign().locationId || null, visited: [],
    party: snapshotParty(), notes: '', shopping: '', inkIds: [], createdAt: Date.now() };
  await save('sessions', s);
  state.sessionId = s.id;
}
function snapshotParty(absent = openSessionNow()?.absent || []) {
  return activePcs().map(p => ({ pcId: p.id, name: p.name, maxHp: p.maxHp, ac: p.ac, pp: p.pp, deaths: p.deaths.length, favorSpent: !!p.favor?.spent, absent: absent.includes(p.id),
    diseases: openCases(p.id).map(c => `${disById(c.diseaseId)?.name || '?'}${c.state === 'incubating' ? ' (incubating)' : ` (stage ${c.stage})`}`).join(', ') || '—' }));
}
async function endSession(s) { s.party = snapshotParty(s.absent || []); s.endAt = now(); await save('sessions', s); }

function curSession() { return state.sessions.find(s => s.id === state.sessionId); }

let deathPc = null;
function openDeath(pc) {
  deathPc = pc;
  const f = $('#deathForm');
  f.reset();
  $('#deathTitle').textContent = `Log a death: ${pc.name}`;
  $('#deathPicker').innerHTML = pickerHTML('dp', now());
  $('#deathFavorRow').hidden = !!pc.favor?.spent;
  $('#deathDlg').returnValue = '';
  $('#deathDlg').showModal();
}
$('#deathDlg').addEventListener('close', async () => {
  if ($('#deathDlg').returnValue !== 'save' || !deathPc) return;
  const f = $('#deathForm');
  const d = { id: uid(), at: readPicker('dp'), note: f.note.value.trim(), favor: !deathPc.favor?.spent && f.favor.checked };
  deathPc.deaths.push(d);
  if (d.favor) deathPc.favor = { spent: true, at: d.at, deathId: d.id, note: d.note ? `undid "${d.note}"` : 'undid a death' };
  await save('pcs', deathPc);
  toast(d.favor ? `${deathPc.name} died, and the Favor of Fate brought them back.` : `Death logged for ${deathPc.name}.`);
  render();
});

let editPc = null;
function openPc(pc) {
  editPc = pc;
  const f = $('#pcForm');
  f.reset();
  $('#pcTitle').textContent = pc ? `Edit ${pc.name}` : 'Add a character';
  for (const k of ['name', 'ancestry', 'classes', 'player', 'maxHp', 'ac', 'pp', 'immunity']) f[k].value = pc?.[k] ?? '';
  $('#pcDlg').returnValue = '';
  $('#pcDlg').showModal();
}
$('#pcDlg').addEventListener('close', async () => {
  if ($('#pcDlg').returnValue !== 'save') return;
  const f = $('#pcForm');
  const pc = editPc || newPc({});
  for (const k of ['name', 'ancestry', 'classes', 'player']) pc[k] = f[k].value.trim();
  for (const k of ['maxHp', 'ac', 'pp', 'immunity']) pc[k] = f[k].value === '' ? null : +f[k].value;
  if (!pc.name) return;
  await save('pcs', pc);
  render();
});

function confirmBox(title, body, yes) {
  return new Promise(res => {
    $('#confirmTitle').textContent = title; $('#confirmBody').textContent = body; $('#confirmYes').textContent = yes;
    const dlg = $('#confirmDlg');
    dlg.returnValue = '';
    dlg.addEventListener('close', () => res(dlg.returnValue === 'yes'), { once: true });
    dlg.showModal();
  });
}

let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200); }

async function setTime(t, opts = {}) {
  const c = campaign(), old = c.current; c.current = Math.max(0, t);
  await applyClock(old, c.current, opts);
  await save('campaigns', c);
  renderHeader(); $('#timeNow').innerHTML = timeNowHTML();
  if ($('#inkView').hidden) render();
}
function timeNowHTML() {
  const t = now(), d = C.fromMinutes(t);
  return `<div class="tn-date">${esc(C.fmtDate(t))}</div><div class="tn-time">${esc(C.fmtTime(t))} · ${C.seasonOf(d.month, d.day)}</div>
    <div class="tn-moons">${C.CAL.moons.map(m => `<span>${moonSVG(m, d.epoch, 22)} ${esc(m.name)}: ${C.moonPhase(m, d.epoch).name}</span>`).join('')}</div>
    ${C.eventsOn(d.month, d.day).map(e => `<div class="tn-ev">${esc(e.label)}</div>`).join('')}
    ${hereLoc() ? (() => { const dl = W.daylight(hereLoc(), d.epoch); return `<div class="tn-sun">In ${esc(hereLoc().name)}: ${dl.twilight ? 'perpetual twilight' : `sunrise ${W.fmtClock(dl.rise)}, sunset ${W.fmtClock(dl.set)}`}</div>`; })() : ''}`;
}

// ---------- locations
async function moveTo(locId) {
  const c = campaign();
  if (c.locationId === locId) return;
  const obs = activeOutbreaksAt(locId);
  if (obs.length) {
    const lines = obs.map(o => `${disById(o.diseaseId)?.name || 'A disease'} is going around${o.severity ? ` (${O.SEVERITY[o.severity].label.toLowerCase()})` : ''}, since ${C.fmtShort(o.startAt)}.`).join(' ');
    if (!(await confirmBox(`Outbreak in ${locById(locId).name}`, `${lines} While the party stays there, the app will ask for exposure rolls each day.`, 'Go there anyway'))) return;
  }
  c.locationId = locId; await save('campaigns', c);
  const s = latestSession();
  if (s && s.endAt == null) { s.visited = [...(s.visited || []), { locationId: locId, at: now() }]; await save('sessions', s); }
  const loc = locById(locId), w = weatherFor(loc, Math.floor(now() / C.DAY));
  toast(`The party is in ${loc.name}. ${W.describe(w)}, ${W.fmtF(w.low)} to ${W.fmtF(w.high)}.`);
}

function openLocPicker() {
  const dlg = $('#locPickDlg');
  const draw = q => {
    const f = fold(q.trim());
    const list = liveLocations().filter(l => !f || fold(l.name + ' ' + l.region + ' ' + (l.notes || '')).includes(f));
    const groups = {};
    for (const l of list) (groups[l.region || 'Other'] ||= []).push(l);
    $('#locPickList').innerHTML = Object.keys(groups).sort().map(g => `<div class="pick-group"><h3>${esc(g)}</h3>${groups[g].sort((a, b) => a.name.localeCompare(b.name)).map(l =>
      `<button type="button" class="pick-item ${l.id === campaign().locationId ? 'here' : ''}" data-pick="${l.id}"><b>${esc(l.name)}</b><span class="muted small">${esc(W.climateById(l.climate).name)}${l.override?.active ? ` · ${esc(l.override.name)}` : ''}</span>${activeOutbreaksAt(l.id).map(o => `<span class="badge spent">${esc(disById(o.diseaseId)?.name || 'Outbreak')}</span>`).join(' ')}</button>`).join('')}</div>`).join('') || '<p class="muted">No locations match. You can add one on the World tab.</p>';
  };
  $('#locSearch').value = '';
  $('#locSearch').oninput = e => draw(e.target.value);
  draw('');
  dlg.returnValue = '';
  dlg.showModal();
}
$('#locPickList').addEventListener('click', async e => {
  const b = e.target.closest('[data-pick]'); if (!b) return;
  $('#locPickDlg').close();
  await moveTo(b.dataset.pick); render();
});

let editLoc = null;
function openLocEditor(loc) {
  editLoc = loc;
  const f = $('#locForm');
  f.reset();
  $('#locTitle').textContent = loc ? `Edit ${loc.name}` : 'Add a location';
  $('#locClimate').innerHTML = W.CLIMATES.map(c => `<option value="${c.id}">${esc(c.name)}: ${esc(c.feel)}</option>`).join('');
  $('#ovClimate').innerHTML = W.CLIMATES.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('#regionList').innerHTML = [...new Set(liveLocations().map(l => l.region))].sort().map(r => `<option value="${esc(r)}">`).join('');
  const L = loc || { name: '', region: '', climate: 'tempinland', hemisphere: 'north', tempAdjust: 0, wind: 0, fog: false, overcast: false, notes: '', override: null };
  f.name.value = L.name; f.region.value = L.region; f.climate.value = L.climate; f.hemisphere.value = L.hemisphere || 'north';
  f.pop.value = loc ? O.popOf(loc) : 'town';
  f.tempAdjust.value = L.tempAdjust || 0; f.wind.value = String(L.wind || 0); f.fog.checked = !!L.fog; f.overcast.checked = !!L.overcast; f.notes.value = L.notes || '';
  const o = L.override;
  f.hasOverride.checked = !!o;
  f.ovName.value = o?.name || ''; f.ovActive.checked = o ? !!o.active : true; f.ovClimate.value = o?.climate || L.climate;
  f.ovLock.checked = o ? !!o.lockWinter : true; f.ovWet.value = o?.wet ?? ''; f.ovDaylight.value = o?.daylight ?? ''; f.ovTwilight.checked = !!o?.twilight;
  $('#ovFields').hidden = !o;
  $('#locDelete').hidden = !loc;
  $('#locDlg').returnValue = '';
  $('#locDlg').showModal();
}
$('#locForm').hasOverride.addEventListener('change', e => { $('#ovFields').hidden = !e.target.checked; });
$('#locDelete').addEventListener('click', async () => {
  if (!editLoc) return;
  if (editLoc.id === campaign().locationId) { toast("The party is here. Move them somewhere else before deleting it."); return; }
  $('#locDlg').close();
  if (!(await confirmBox(`Delete ${editLoc.name}?`, 'It disappears from your location list. Weather already recorded there stays in your history.', 'Delete'))) return;
  editLoc.deleted = true; await save('locations', editLoc); render();
});
$('#locDlg').addEventListener('close', async () => {
  if ($('#locDlg').returnValue !== 'save') return;
  const f = $('#locForm');
  const loc = editLoc || { id: 'loc-' + uid(), createdAt: Date.now() };
  loc.name = f.name.value.trim() || loc.name || 'Unnamed place';
  loc.region = f.region.value.trim() || 'My locations';
  loc.climate = f.climate.value; loc.hemisphere = f.hemisphere.value; loc.pop = f.pop.value;
  loc.tempAdjust = +f.tempAdjust.value || 0; loc.wind = +f.wind.value || 0;
  loc.fog = f.fog.checked; loc.overcast = f.overcast.checked; loc.notes = f.notes.value.trim();
  loc.override = f.hasOverride.checked ? {
    name: f.ovName.value.trim() || 'Magical weather', active: f.ovActive.checked, climate: f.ovClimate.value, lockWinter: f.ovLock.checked,
    wet: f.ovWet.value === '' ? null : Math.max(0, Math.min(100, +f.ovWet.value)), daylight: f.ovDaylight.value === '' ? null : Math.max(0, Math.min(24, +f.ovDaylight.value)), twilight: f.ovTwilight.checked,
  } : null;
  await save('locations', loc);
  toast(`${loc.name} saved. New settings apply from the next day that gets rolled.`);
  render();
});

function openWxSet() {
  const loc = hereLoc(), ep = Math.floor(now() / C.DAY), w = weatherFor(loc, ep), f = $('#wxForm');
  f.low.value = w.low; f.high.value = w.high; f.precip.value = String(w.precip); f.wind.value = String(w.wind);
  f.sky.value = w.sky || 'overcast'; f.fog.checked = !!w.fog;
  $('#wxDlg').returnValue = '';
  $('#wxDlg').showModal();
}
$('#wxDlg').addEventListener('close', async () => {
  if ($('#wxDlg').returnValue !== 'save') return;
  const f = $('#wxForm'), loc = hereLoc(), ep = Math.floor(now() / C.DAY), cur = weatherFor(loc, ep);
  const low = +f.low.value, high = Math.max(+f.high.value, low), precip = +f.precip.value;
  const n = W.normals(loc, ep);
  const rec = { ...cur, low, high, precip, wind: +f.wind.value, sky: precip ? 'overcast' : f.sky.value, fog: !precip && f.fog.checked, manual: true, held: false,
    offset: Math.round(((low - n.low) + (high - n.high)) / 2), heavyDays: precip === 2 ? 1 : 0, heavyMax: precip === 2 ? 2 : 0 };
  const mid = (low + high) / 2;
  rec.precipType = precip ? (high <= 32 ? 'snow' : mid <= 34 ? 'sleet' : 'rain') : null;
  dropLaterWeather(loc.id, ep);
  await save('weather', rec); wxIndex.set(rec.id, rec);
  toast("Today's weather set. Tomorrow may carry it on."); render();
});

// ---------- disease dialogs
const caseOf = el => state.cases.find(c => c.id === el.closest('[data-case]').dataset.case);
function diseaseOptions(sel) {
  const groups = {};
  for (const d of liveDiseases()) (groups[d.source || 'Other'] ||= []).push(d);
  return Object.keys(groups).sort().map(g => `<optgroup label="${esc(g)}">${groups[g].map(d => `<option value="${d.id}" ${d.id === sel ? 'selected' : ''}>${esc(d.name)} (${esc(d.rarity)}, DC ${d.dc}, ${H.fmtIncubation(d.incubation)})</option>`).join('')}</optgroup>`).join('');
}
function openExposure() {
  const f = $('#expForm'); f.reset();
  $('#expPcs').innerHTML = presentPcs().map(p => `<label class="check"><input type="checkbox" value="${p.id}"> <span>${esc(p.name)}</span></label>`).join('');
  $('#expDisease').innerHTML = diseaseOptions();
  const loc = hereLoc();
  const ob = loc ? activeOutbreaksAt(loc.id)[0] : null;
  if (ob) $('#expDisease').value = ob.diseaseId;
  $('#expNote').textContent = `Exposure time: ${C.fmtDateTime(now())}.`;
  $('#expDlg').returnValue = ''; $('#expDlg').showModal();
}
$('#expDlg').addEventListener('close', async () => {
  if ($('#expDlg').returnValue !== 'save') return;
  const f = $('#expForm'), d = disById(f.disease.value);
  const ids = [...$('#expPcs').querySelectorAll('input:checked')].map(i => i.value);
  if (!ids.length || !d) { toast('Pick at least one character and a disease.'); return; }
  const { immune, logged } = await createExposures(ids, d, f.route.value.split(':')[0], f.disadv.checked);
  toast([logged.length ? `${logged.join(', ')} exposed to ${d.name}. Infection check on ${C.fmtShort(now() + H.incubationMins(d))}.` : '', immune.length ? `${immune.join(', ')} ${immune.length > 1 ? 'are' : 'is'} immune.` : ''].filter(Boolean).join(' '));
  render();
});

async function createExposures(ids, d, route, disadvantage) {
  const immune = [], logged = [];
  for (const id of ids) {
    const p = state.pcs.find(x => x.id === id);
    if (H.immunityDC(+p.immunity || 0) >= d.dc) { immune.push(p.name); continue; }
    const cs = { id: uid(), campaignId: state.campaignId, pcId: id, diseaseId: d.id, contactAt: now(), route, disadvantage,
      state: 'incubating', stage: 0, dueAt: now() + H.incubationMins(d), bedRest: false, log: [{ at: now(), kind: 'exposed' }], createdAt: Date.now() };
    await save('cases', cs); logged.push(p.name);
  }
  return { immune, logged };
}

let checkCase = null;
function openCheck(cs) {
  checkCase = cs;
  const d = disById(cs.diseaseId), p = state.pcs.find(x => x.id === cs.pcId);
  const infection = cs.state === 'incubating';
  $('#checkTitle').textContent = `${infection ? 'Infection' : 'Escalation'} check: ${p?.name}`;
  const adv = infection ? (cs.disadvantage ? 'with <b>disadvantage</b> (open wounds or repeated exposure)' : '') : (cs.bedRest ? 'with <b>advantage</b> (bed rest or first aid)' : '');
  $('#checkBody').innerHTML = `<p>${esc(d.name)}: <b>DC ${d.dc} Constitution saving throw</b> ${adv}.</p>
    <p class="muted small">${infection ? 'Success: not infected. Failure: infected, and the first symptoms (stage 1) begin.' : `Success: the symptoms have peaked; it improves a stage and starts getting better. Failure: it gets worse, to stage ${Math.min(4, cs.stage + 1)}.`}</p>`;
  $('#checkDlg').returnValue = ''; $('#checkDlg').showModal();
}
$('#checkDlg').addEventListener('close', async () => {
  const r = $('#checkDlg').returnValue, cs = checkCase;
  if (!cs || (r !== 'success' && r !== 'failure')) return;
  const d = disById(cs.diseaseId), inc = H.incubationMins(d), p = state.pcs.find(x => x.id === cs.pcId);
  let msg;
  if (cs.state === 'incubating') {
    cs.log.push({ at: now(), kind: 'infection', result: r });
    if (r === 'success') { cs.state = 'resisted'; msg = `${p.name} fought it off: not infected.`; }
    else { cs.state = 'sick'; cs.stage = 1; cs.dueAt += inc; msg = `${p.name} has ${d.name}: stage 1.`; }
  } else {
    cs.log.push({ at: now(), kind: 'escalation', result: r, adv: cs.bedRest });
    cs.bedRest = false;
    if (r === 'success') {
      cs.stage -= 1; cs.dueAt += inc;
      if (cs.stage <= 0) { cs.state = 'cured'; cs.curedAt = now(); msg = `${p.name} has recovered from ${d.name}. ${d.cured}`; }
      else { cs.state = 'declining'; msg = `${p.name}'s ${d.name} is getting better: stage ${cs.stage}.`; }
    } else { cs.stage = Math.min(4, cs.stage + 1); cs.dueAt += inc; msg = `${p.name}'s ${d.name} gets worse: stage ${cs.stage}.`; }
  }
  if (cs.state === 'cured') { p.healthNotes = [...(p.healthNotes || []), { at: now(), text: `Recovered from ${d.name}: ${d.cured}` }]; await save('pcs', p); }
  await save('cases', cs); toast(msg); render();
});

let magicCase = null;
function openMagic(cs) { magicCase = cs; $('#magicForm').reset(); $('#magicDlg').returnValue = ''; $('#magicDlg').showModal(); }
$('#magicDlg').addEventListener('close', async () => {
  if ($('#magicDlg').returnValue !== 'save' || !magicCase) return;
  const cs = magicCase, d = disById(cs.diseaseId), max = H.magicMaxDC(+$('#magicForm').level.value);
  if (d.dc > max) { toast(`Not strong enough: ${d.name} is DC ${d.dc}, and that magic only works up to DC ${max}.`); return; }
  cs.state = 'declining'; cs.log.push({ at: now(), kind: 'magic' });
  await save('cases', cs); toast(`The magic works: ${d.name} is now getting better, a stage at a time.`); render();
});

function openOutbreak() {
  $('#obForm').reset();
  $('#obLoc').innerHTML = liveLocations().sort((a, b) => a.name.localeCompare(b.name)).map(l => `<option value="${l.id}" ${l.id === campaign().locationId ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  $('#obDisease').innerHTML = diseaseOptions();
  $('#obDlg').returnValue = ''; $('#obDlg').showModal();
}
$('#obDlg').addEventListener('close', async () => {
  if ($('#obDlg').returnValue !== 'save') return;
  const f = $('#obForm');
  await save('outbreaks', { id: uid(), campaignId: state.campaignId, locationId: f.loc.value, diseaseId: f.disease.value, startAt: now(), endedAt: null, note: f.note.value.trim(), createdAt: Date.now() });
  render();
});

let editDis = null;
// ---------- what each disease stage does on the character sheet (read by the suite core, or the DM's own words)
let FX = null;
import('/core/effects.js').then(m => { FX = m; if (state.campaignId && campaign()) render(); }).catch(() => {}); // redraw once loaded (not before the app has)
function stageFx(d, i) {
  if (!FX) return null;
  if (Array.isArray(d.stageFx?.[i])) return d.stageFx[i];
  return FX.parseEffects(d.stages?.[i] || '');
}
function stageFxLine(d, i) {
  const fx = stageFx(d, i);
  if (!fx) return '';
  return `<br><span class="muted small">On the sheet: ${fx.length ? esc(fx.map(FX.describe).join(', ')) : 'nothing changes'}${Array.isArray(d.stageFx?.[i]) ? ' (your wording)' : ''}</span>`;
}
function showFxRead() {
  const f = $('#disForm');
  for (let i = 1; i <= 4; i++) {
    const own = f[`fx${i}`].value.trim();
    const fx = FX ? FX.parseEffects(own || f[`s${i}`].value) : null;
    const el = document.querySelector(`.fxread[data-fx="${i}"]`);
    if (el) el.textContent = fx ? `${own ? 'Your wording reads as' : 'Read from the stage'}: ${fx.length ? fx.map(FX.describe).join(', ') : 'nothing changes'}` : '';
  }
}
$('#disForm').addEventListener('input', showFxRead);

function openDisease(d) {
  editDis = d;
  const f = $('#disForm'); f.reset();
  $('#disTitle').textContent = d ? `Edit ${d.name}` : 'Create a disease';
  const D = d || { name: '', transmission: 'Touch', rarity: 'Common', dc: 15, incubation: 2, description: '', stages: ['', '', '', ''], cured: '' };
  f.name.value = D.name; f.transmission.value = D.transmission; f.rarity.value = D.rarity; f.dc.value = String(D.dc);
  const weeks = D.incubation % 7 === 0; f.incN.value = weeks ? D.incubation / 7 : D.incubation; f.incU.value = weeks ? '7' : '1';
  f.description.value = D.description; f.cured.value = D.cured;
  ['s1', 's2', 's3', 's4'].forEach((k, i) => { f[k].value = D.stages[i] || ''; });
  [1, 2, 3, 4].forEach(i => { f[`fx${i}`].value = D.stageFxText?.[i - 1] || ''; });
  showFxRead();
  $('#disDelete').hidden = !d;
  $('#disDlg').returnValue = ''; $('#disDlg').showModal();
}
$('#disDelete').addEventListener('click', async () => {
  if (!editDis) return;
  $('#disDlg').close();
  if (!(await confirmBox(`Delete ${editDis.name}?`, 'It leaves the library. Anyone sick with it stays sick until you resolve it.', 'Delete'))) return;
  editDis.deleted = true; await save('diseases', editDis); render();
});
$('#disDlg').addEventListener('close', async () => {
  if ($('#disDlg').returnValue !== 'save') return;
  const f = $('#disForm');
  const d = editDis || { id: 'dis-' + uid(), source: 'Homebrew', createdAt: Date.now() };
  d.name = f.name.value.trim() || 'Unnamed disease'; d.transmission = f.transmission.value.trim(); d.rarity = f.rarity.value; d.dc = +f.dc.value;
  d.incubation = Math.max(1, +f.incN.value || 1) * +f.incU.value; d.description = f.description.value.trim(); d.cured = f.cured.value.trim();
  d.stages = ['s1', 's2', 's3', 's4'].map(k => f[k].value.trim());
  // the DM's own wording for what a stage does on the sheet (empty: read the stage itself)
  d.stageFxText = [1, 2, 3, 4].map(i => f[`fx${i}`].value.trim());
  d.stageFx = d.stageFxText.map(t => (t && FX ? FX.parseEffects(t) : null));
  if (!d.stageFxText.some(Boolean)) { delete d.stageFxText; delete d.stageFx; }
  await save('diseases', d); render();
});

// ---------- adding a past session (notes from before the app)
function openPast() {
  const f = $('#pastForm'); f.reset();
  const nums = campaignSessions().map(x => x.number);
  f.number.value = nums.length ? Math.max(1, Math.min(...nums) - 1) : 1;
  f.realDate.value = '';
  const start = now() - 7 * C.DAY;
  $('#pastStart').innerHTML = pickerHTML('ps', start);
  $('#pastEnd').innerHTML = pickerHTML('pe', start + 8 * 60);
  $('#pastAbsent').innerHTML = activePcs().map(p => `<label class="check"><input type="checkbox" value="${p.id}"> <span>${esc(p.name)}</span></label>`).join('');
  $('#pastLoc').innerHTML = `<option value="">Not recorded</option>${liveLocations().sort((a, b) => a.name.localeCompare(b.name)).map(l => `<option value="${l.id}" ${l.id === campaign().locationId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}`;
  $('#pastDlg').returnValue = ''; $('#pastDlg').showModal();
}
$('#pastDlg').addEventListener('close', async () => {
  if ($('#pastDlg').returnValue !== 'save' && $('#pastDlg').returnValue !== 'another') return;
  const f = $('#pastForm'), number = Math.max(1, +f.number.value || 1);
  if (campaignSessions().some(x => x.number === number) && !(await confirmBox(`Session ${number} already exists`, 'Add another session with the same number anyway?', 'Add it'))) return;
  const startAt = readPicker('ps'); let endAt = readPicker('pe'); if (endAt < startAt) endAt = startAt;
  const rec = { id: uid(), campaignId: state.campaignId, number, realDate: f.realDate.value, startAt, endAt, locationId: f.loc.value || null, visited: [],
    party: [], absent: [...$('#pastAbsent').querySelectorAll('input:checked')].map(i => i.value), notes: f.notes.value, shopping: f.shopping.value, inkIds: [], past: true, createdAt: Date.now() };
  await save('sessions', rec);
  toast(`Session ${number} added to your history.`);
  render();
  if ($('#pastDlg').returnValue === 'another') { openPast(); $('#pastForm').number.value = Math.max(1, number - 1); }
});

// ---------- training dialog
let editTrain = null, startTouched = false;
function openTraining(t = null) {
  editTrain = t; startTouched = false;
  const f = $('#trainForm'); f.reset();
  $('#trainTitle').textContent = t ? 'Edit training' : 'Start training';
  $('#trainSave').textContent = t ? 'Save changes' : 'Start training';
  $('#trainEditNote').hidden = !t;
  $('#trainPc').innerHTML = activePcs().map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('#trainKind').innerHTML = Object.entries(T.KINDS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  $('#trainTrainer').innerHTML = Object.entries(T.TRAINERS).map(([k, v]) => `<option value="${k}" ${k === 'none' ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
  f.mod.value = 0; $('#trainStart').innerHTML = pickerHTML('ts', t ? t.startAt : now());
  if (t) {
    if (!activePcs().some(p => p.id === t.pcId)) $('#trainPc').insertAdjacentHTML('beforeend', `<option value="${t.pcId}">${esc(pcName(t.pcId))}</option>`);
    f.pc.value = t.pcId; f.kind.value = t.kind; trainKindChanged();
    if (t.sub) f.sub.value = t.sub;
    f.what.value = t.what; trainWhatChanged();
    f.ability.value = t.ability; f.mod.value = t.mod; f.trainer.value = t.trainer; f.trainerName.value = t.trainerName || ''; f.partyMember.checked = !!t.partyMember;
    f.cost.value = t.costPerDay || 0; trainPreview();
  } else trainKindChanged();
  $('#trainDlg').returnValue = ''; $('#trainDlg').showModal();
}
// Editing: unless you change the start date, the share already done is kept (half done stays half done) and the rest is recalculated.
function editedStart(days) {
  const t = editTrain, st = T.trainingStatus(t, now());
  const pausedNow = st.paused ? now() - t.pausedAt : 0;
  const leftDays = Math.ceil((1 - st.frac) * days - 1e-9); // whole days left, rounded up
  return now() - (days - leftDays) * C.DAY - (t.pausedTotal || 0) - pausedNow;
}
function trainKindChanged() {
  const f = $('#trainForm'), k = f.kind.value;
  const whatSel = opts => `<select name="what">${opts.map(o => `<option>${esc(o)}</option>`).join('')}</select>`;
  const whatTxt = ph => `<input name="what" autocomplete="off" placeholder="${ph}">`;
  let what = '', subs = null, subLabel = 'Type', abil = T.ABILITIES;
  if (k === 'language') { what = whatTxt('Giant'); subs = ['Common', 'Uncommon']; subLabel = 'Common or uncommon'; abil = ['Intelligence']; }
  if (k === 'skill') what = whatSel(T.SKILLS.map(x => x[0]));
  if (k === 'tool') what = whatSel(T.TOOLS.map(x => x[0]));
  if (k === 'weapon') { what = whatTxt('Longbow'); subs = ['Simple', 'Martial', 'Firearm']; subLabel = 'Weapon type'; abil = ['Strength', 'Dexterity']; }
  if (k === 'save' || k === 'ability') what = whatSel(T.ABILITIES);
  $('#trainWhatLabel').textContent = k === 'save' ? 'Saving throw' : k === 'ability' ? 'Ability' : k === 'language' ? 'Language' : k === 'weapon' ? 'Weapon' : k === 'tool' ? 'Tool' : 'Skill';
  $('#trainWhat').innerHTML = what;
  $('#trainSubWrap').hidden = !subs;
  $('#trainSub').innerHTML = (subs || []).map(o => `<option>${o}</option>`).join('');
  $('#trainAbility').innerHTML = abil.map(a => `<option>${a}</option>`).join('');
  trainWhatChanged();
}
function trainWhatChanged() {
  const f = $('#trainForm'), k = f.kind.value, w = f.what?.value;
  if (k === 'skill') { const sk = T.SKILLS.find(x => x[0] === w); $('#trainAbility').innerHTML = `<option>${sk[1]}</option>`; }
  if (k === 'tool') { const tl = T.TOOLS.find(x => x[0] === w); $('#trainAbility').innerHTML = tl[1].map(a => `<option>${a}</option>`).join(''); }
  if (k === 'save' || k === 'ability') $('#trainAbility').innerHTML = `<option>${w}</option>`;
  const rules = { language: 'At least 4 hours a day studying and practicing the language.', skill: 'At least 2 hours a day.', tool: 'At least 2 hours a day.', weapon: 'At least 2 hours a day.',
    save: 'At least 3 hours a day practicing that save. Your price table has no cost for saving throws, so set one.', ability: 'At least 8 hours a day. Raises the score by 1. A trainer must be proficient in that ability\'s saving throw.' };
  $('#trainRule').textContent = `${rules[k]} A party member can train them if they're proficient in it. Travel time counts toward the hours.`;
  trainCostDefault();
}
function trainCostDefault() {
  const f = $('#trainForm');
  const c = T.dailyCost(f.kind.value, f.sub.value, f.trainer.value, f.partyMember.checked);
  f.cost.value = c == null ? '' : c;
  trainPreview();
}
function trainStartAt() { const t = readPicker('ts'); return Math.min(t, now()); }
function trainPreview() {
  const f = $('#trainForm');
  const days = T.trainingDays(+f.mod.value, f.trainer.value), weeks = Math.max(1, 10 - (+f.mod.value || 0));
  let start = trainStartAt(), finish = start + days * C.DAY, left = finish - now();
  const cost = f.cost.value === '' ? null : +f.cost.value;
  if (editTrain && !startTouched) {
    const st = T.trainingStatus(editTrain, now());
    const pause = (editTrain.pausedTotal || 0) + (st.paused ? now() - editTrain.pausedAt : 0);
    start = editedStart(days); finish = start + pause + days * C.DAY; left = finish - now();
    $('#trainPreview').innerHTML = `<b>${weeks} weeks</b> base (10 − modifier)${f.trainer.value !== 'skilled' ? `, ${f.trainer.value === 'none' ? '+50%' : f.trainer.value === 'apprentice' ? '+25%' : '−25%'} for the trainer` : ''} = <b>${C.fmtSpan(days * C.DAY)}</b> (${days} days).
      ${Math.round(st.frac * 100)}% done so far stays done, so it now finishes <b>${esc(C.fmtShort(finish))}</b> (<b>${C.fmtSpan(Math.max(0, left))} left</b>${editTrain.days !== days ? `, was ${C.fmtSpan(Math.max(0, st.total - st.done))}` : ''}). ${cost ? `Cost: ${T.fmtGp(cost)} a day, <b>${T.fmtGp(cost * days)}</b> in all.` : 'No fee.'}`;
    return;
  }
  $('#trainPreview').innerHTML = `<b>${weeks} weeks</b> base (10 − modifier)${f.trainer.value !== 'skilled' ? `, ${f.trainer.value === 'none' ? '+50%' : f.trainer.value === 'apprentice' ? '+25%' : '−25%'} for the trainer` : ''} = <b>${C.fmtSpan(days * C.DAY)}</b> (${days} days).
    ${start < now() ? `Started ${esc(C.fmtShort(start))}. ` : ''}Finishes <b>${esc(C.fmtShort(finish))}</b>${start < now() ? (left > 0 ? ` (<b>${C.fmtSpan(left)} left</b>)` : ' (<b>already finished</b>: it will be marked done)') : ''}. ${cost == null ? 'No cost set.' : cost ? `Cost: ${T.fmtGp(cost)} a day, <b>${T.fmtGp(cost * days)}</b> in all.` : 'No fee.'}`;
}
$('#trainForm').addEventListener('change', e => {
  const n = e.target.name;
  if (n === 'kind') trainKindChanged();
  else if (n === 'what') trainWhatChanged();
  else if (n === 'sub' || n === 'trainer' || n === 'partyMember') { applyLeft(); trainCostDefault(); }
  else trainPreview();
});
// Work the start date out from the time left.
function applyLeft() {
  const f = $('#trainForm'); if (f.left.value === '') return;
  const days = T.trainingDays(+f.mod.value, f.trainer.value), left = Math.max(0, Math.min(days, +f.left.value || 0));
  const d = C.fromMinutes(now()), start = (d.epoch - (days - left)) * C.DAY + d.hour * 60 + d.minute;
  $('#trainStart').innerHTML = pickerHTML('ts', start);
}
$('#trainForm').addEventListener('input', e => {
  if (e.target.closest('#trainStart')) { $('#trainForm').left.value = ''; startTouched = true; }
  else { if (e.target.name === 'left') startTouched = $('#trainForm').left.value !== ''; applyLeft(); }
  trainPreview();
});
$('#trainDlg').addEventListener('close', async () => {
  if ($('#trainDlg').returnValue !== 'save') return;
  const f = $('#trainForm');
  const what = (f.what?.value || '').trim() || 'Training';
  if (editTrain) {
    const t = editTrain, days = T.trainingDays(+f.mod.value, f.trainer.value);
    const newStart = startTouched ? trainStartAt() : editedStart(days);
    Object.assign(t, { pcId: f.pc.value, kind: f.kind.value, what, sub: $('#trainSubWrap').hidden ? null : f.sub.value, ability: f.ability.value, mod: +f.mod.value || 0,
      trainer: f.trainer.value, trainerName: f.trainerName.value.trim(), partyMember: f.partyMember.checked, costPerDay: f.cost.value === '' ? 0 : +f.cost.value, days, startAt: newStart });
    if (startTouched) { t.pausedTotal = 0; t.pausedAt = null; }
    await save('training', t);
    const st = T.trainingStatus(t, now());
    toast(st.done >= st.total ? `${pcName(t.pcId)} has finished ${t.what}.` : `${pcName(t.pcId)}: ${t.what} now finishes ${C.fmtShort(st.finishAt)} (${C.fmtSpan(st.total - st.done)} left).`);
    editTrain = null; await processDowntime(); render(); return;
  }
  const t = { id: uid(), campaignId: state.campaignId, pcId: f.pc.value, kind: f.kind.value, what: f.kind.value === 'language' && f.sub.value ? `${what}` : what,
    sub: $('#trainSubWrap').hidden ? null : f.sub.value, ability: f.ability.value, mod: +f.mod.value || 0, trainer: f.trainer.value, trainerName: f.trainerName.value.trim(),
    partyMember: f.partyMember.checked, costPerDay: f.cost.value === '' ? 0 : +f.cost.value, days: T.trainingDays(+f.mod.value, f.trainer.value),
    startAt: trainStartAt(), pausedAt: null, pausedTotal: 0, state: 'active', createdAt: Date.now() };
  await save('training', t);
  const fin = t.startAt + t.days * C.DAY;
  toast(fin > now() ? `${pcName(t.pcId)}: ${t.what}. ${C.fmtSpan(fin - now())} left, finishing ${C.fmtShort(fin)}.` : `${pcName(t.pcId)} has already finished ${t.what}.`);
  await processDowntime(); render();
});

// ---------- the item broker's dialog
let tradeKind = 'buy';
function openTrade(kind) {
  tradeKind = kind; const f = $('#tradeForm'); f.reset();
  $('#tradeTitle').textContent = kind === 'buy' ? `${brokerShort()}: find an item` : `${brokerShort()}: sell an item`;
  $('#tradePc').innerHTML = `<option value="party">The party</option>${activePcs().map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}`;
  $('#tradeRarity').innerHTML = T.RARITIES.map(r => `<option ${r === 'Uncommon' ? 'selected' : ''}>${r}</option>`).join('');
  tradeUpdate(); $('#tradeDlg').returnValue = ''; $('#tradeDlg').showModal();
}
function tradeCalc() {
  const f = $('#tradeForm'), r = f.rarity.value, buy = tradeKind === 'buy';
  const need = (buy ? T.FIND_SELLER : T.FIND_BUYER)[r], die = T.WEEKS_DIE[r];
  const d100 = +f.d100.value || 0, found = d100 >= 1 && d100 <= need;
  const band = f.d6.value ? T.bandFor(buy ? T.SELLER_BANDS : T.BUYER_BANDS, +f.d6.value) : null;
  return { r, buy, need, die, d100, found, band, weeks: +f.weeks.value || 0, pct: +f.pct.value || 0, base: +f.base.value || 0, timing: f.timing.value };
}
function tradeUpdate() {
  const f = $('#tradeForm');
  { const c0 = tradeCalc(); if (c0.band && (!f.pct.value || +f.pct.value < c0.band.lo || +f.pct.value > c0.band.hi)) f.pct.value = Math.round((c0.band.lo + c0.band.hi) / 2); }
  const c = tradeCalc();
  $('#tradeHint').textContent = `DMG price range for ${c.r.toLowerCase()} items: ${T.VALUE_HINT[c.r]}.${c.timing === 'upfront' && c.base ? ` Paying up front: a ${T.fmtGp(T.upfrontFee(c.base))} deposit now (20% of the estimated value). ${brokerShort()} settles the difference on delivery.` : ''}`;
  $('#tradeFindLabel').textContent = `1. Roll d100: ${c.buy ? 'he finds a seller' : 'he finds a buyer'} on ${c.need} or lower`;
  $('#tradeWeeksLabel').textContent = `2. Roll d${c.die}: weeks it takes`;
  $('#tradeD6Label').textContent = `3. Roll d6: the ${c.buy ? 'seller' : 'buyer'}`;
  $('#tradePctLabel').textContent = c.band ? `4. ${c.band.name}: ${c.band.lo}–${c.band.hi}% of base` : '4. Percent of base value';
  const showRest = !f.d100.value || c.found;
  document.querySelectorAll('#tradeForm .step').forEach((el, i) => { if (i > 0) el.hidden = !showRest; });
  f.weeks.max = c.die;
  let out = '';
  if (f.d100.value && !c.found) out = `<b>Rolled ${c.d100}: ${esc(brokerShort())} comes back empty-handed.</b> ${c.buy ? "No seller could be found." : "No one will buy it right now, so the item goes back."}${c.timing === 'upfront' ? ` Whether ${esc(brokerShort())} hands back the ${T.fmtGp(T.upfrontFee(c.base))} paid up front is your call, though his reputation suggests he would.` : ''}`;
  else if (c.found && c.band && c.weeks && c.base) {
    const due = now() + c.weeks * 7 * C.DAY;
    const wk = `(${c.weeks} week${c.weeks > 1 ? 's' : ''})`;
    if (c.buy) { const m = T.buyMath(c.base, c.pct, c.timing); out = `Seller found <b>${esc(C.fmtShort(due))}</b> ${wk}. ${c.band.name} asks ${T.fmtGp(m.price)}. ${m.timing === 'upfront' ? `${feeSettleText(m, true)} On delivery they pay <b>${T.fmtGp(m.dueOnDelivery)}</b> (${T.fmtGp(m.total)} in all).` : `With ${esc(brokerShort())}'s 20% (${T.fmtGp(m.fee)}), <b>${T.fmtGp(m.total)}</b> is due on delivery.`}`; }
    else { const m = T.sellMath(c.base, c.pct, c.timing); out = `Buyer found <b>${esc(C.fmtShort(due))}</b> ${wk}. ${c.band.name} offers ${T.fmtGp(m.offer)}. ${m.timing === 'upfront' ? `${feeSettleText(m, false)} On delivery ${esc(brokerShort())} pays them <b>${T.fmtGp(m.onDelivery)}</b> (${T.fmtGp(m.payout)} after the fee).` : `Less ${esc(brokerShort())}'s 20% (${T.fmtGp(m.fee)}), they get <b>${T.fmtGp(m.payout)}</b> on delivery.`}`; }
  } else out = `<span class="muted">Enter the rolls as you make them. The players see none of this until ${esc(brokerShort())} reports back.</span>`;
  $('#tradePreview').innerHTML = out;
}
$('#tradeForm').addEventListener('input', tradeUpdate);
$('#tradeForm').addEventListener('change', tradeUpdate);
$('#tradePick').addEventListener('click', () => { const c = tradeCalc(); if (!c.band) return; $('#tradeForm').pct.value = c.band.lo + Math.floor(Math.random() * (c.band.hi - c.band.lo + 1)); tradeUpdate(); });
$('#tradeDlg').addEventListener('close', async () => {
  if ($('#tradeDlg').returnValue !== 'save') return;
  const f = $('#tradeForm'), c = tradeCalc();
  if (!f.item.value.trim() || !f.d100.value) { toast('Add the item and the d100 roll first.'); return; }
  const t = { id: uid(), campaignId: state.campaignId, kind: tradeKind, pcId: f.pc.value, item: f.item.value.trim(), rarity: c.r, base: c.base, askedAt: now(), d100: c.d100, createdAt: Date.now() };
  t.feeTiming = c.timing; if (c.timing === 'upfront') t.upfrontPaid = T.upfrontFee(c.base);
  if (!c.found) { t.state = 'failed'; t.closedAt = now(); await save('trades', t); toast(`${brokerShort()} couldn't find ${c.buy ? 'a seller' : 'a buyer'} for ${t.item}.`); render(); return; }
  if (!c.band || !c.weeks) { toast('Add the weeks and the d6 roll too.'); return; }
  Object.assign(t, { weeks: Math.min(c.die, Math.max(1, c.weeks)), d6: +f.d6.value, band: c.band.name, pct: c.pct, state: 'searching' });
  t.dueAt = now() + t.weeks * 7 * C.DAY;
  t.math = c.buy ? T.buyMath(c.base, c.pct, c.timing) : T.sellMath(c.base, c.pct, c.timing);
  await save('trades', t); toast(`${brokerShort()} is on it, with news ${C.fmtShort(t.dueAt)}.`); render();
});

// ---------- survival dialogs
let gearPc = null;
function openGear(p) {
  gearPc = p; const g = surv(p).gear, f = $('#gearForm');
  $('#gearTitle').textContent = `${p.name}: protection`;
  for (const k of Object.keys(g)) f[k].checked = !!g[k];
  f.everyone.checked = false;
  $('#gearDlg').returnValue = ''; $('#gearDlg').showModal();
}
$('#gearDlg').addEventListener('close', async () => {
  if ($('#gearDlg').returnValue !== 'save' || !gearPc) return;
  const g = surv(gearPc).gear, f = $('#gearForm');
  for (const k of Object.keys(g)) g[k] = f[k].checked;
  const who = f.everyone.checked ? presentPcs() : [gearPc];
  for (const p of who) { surv(p).gear = { ...g }; refreshFlags(p); await save('pcs', p); }
  render();
});

let stamPc = null;
function openStamina(p) {
  stamPc = p; const sv = surv(p), tn = tempNow(p);
  const stages = { hunger: sv.hunger, thirst: sv.thirst, fatigue: sv.fatigue, ...(tn ? { temperature: tn.stage } : {}) };
  const best = Math.min(...Object.values(stages)), dc = H.STAMINA_DC[best];
  $('#stamTitle').textContent = `Stamina check: ${p.name}`;
  $('#stamBody').innerHTML = dc
    ? `<p><b>DC ${dc} Constitution saving throw</b>, from their best condition.</p><p class="muted small">After a strenuous event. On a failure, roll a d6 to see which condition gets worse.</p>`
    : `<p>Their best condition is at its top stage, so there's no check to make.</p>`;
  $('#stamRow').hidden = false; $('#stamD6').hidden = true; $('#stamFail').hidden = !dc;
  $('#stamDlg').returnValue = ''; $('#stamDlg').showModal();
}
$('#stamFail').addEventListener('click', () => { $('#stamRow').hidden = true; $('#stamD6').hidden = false; });
$('#stamD6').addEventListener('click', async e => {
  const b = e.target.closest('[data-d6]'); if (!b || !stamPc) return;
  const sv = surv(stamPc); sv[b.dataset.d6] = Math.min(6, sv[b.dataset.d6] + 1); refreshFlags(stamPc);
  await save('pcs', stamPc); $('#stamDlg').close(); toast(`${stamPc.name}: +1 ${b.dataset.d6}.`); render();
});

// ---------- ink
async function openInk(page) {
  const view = $('#inkView');
  view.hidden = false;
  document.body.classList.add('ink-open');
  openInkEditor(view, page, {
    onChange: async (strokes, { color, size }) => { page.strokes = strokes; page.lastColor = color; page.lastSize = size; await save('ink', page); },
    onClose: () => { view.hidden = true; view.innerHTML = ''; document.body.classList.remove('ink-open'); render(); },
    onDelete: async () => {
      if (!(await confirmBox('Delete this ink page?', 'Everything written on it will be removed.', 'Delete page'))) return;
      page.deleted = true; await save('ink', page);
      const s = curSession(); s.inkIds = s.inkIds.filter(id => id !== page.id); await save('sessions', s);
      view.hidden = true; view.innerHTML = ''; document.body.classList.remove('ink-open'); render();
    },
  });
}

// ---------- events
document.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-view]'); if (!b) return;
  state.view = b.dataset.view;
  if (state.view === 'session') state.sessionId = latestSession()?.id;
  render(); $('#view').focus({ preventScroll: true }); window.scrollTo(0, 0);
});

$('#view').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  const pcEl = b.closest('[data-pc]');
  const pc = pcEl ? state.pcs.find(p => p.id === pcEl.dataset.pc) : null;
  const s = curSession();
  switch (act) {
    case 'start-first': await startSession(Math.max(1, +$('#firstNum').value || 1)); break;
    case 'sess-older': { const l = campaignSessions(); state.sessionId = l[l.indexOf(s) + 1]?.id || s.id; break; }
    case 'sess-newer': { const l = campaignSessions(); state.sessionId = l[l.indexOf(s) - 1]?.id || s.id; break; }
    case 'end-session': await endSession(s); toast(`Session ${s.number} ended at ${C.fmtShort(s.endAt)}, ${C.fmtTime(s.endAt)}.`); break;
    case 'reopen-session': s.endAt = null; await save('sessions', s); break;
    case 'next-session': if (s.endAt == null) await endSession(s); await startSession(s.number + 1); window.scrollTo(0, 0); break;
    case 'delete-session':
      if (!(await confirmBox(`Delete session ${s.number}?`, 'Its notes, shopping and ink pages will be removed. The party and calendar are not affected.', 'Delete session'))) return;
      s.deleted = true; await save('sessions', s); state.sessionId = latestSession()?.id; break;
    case 'death': openDeath(pc); return;
    case 'del-death': {
      if (!(await confirmBox('Remove this death?', 'Use this to fix a mistake. If the Favor of Fate was used on it, the coin is given back.', 'Remove'))) return;
      const id = b.dataset.id;
      pc.deaths = pc.deaths.filter(d => d.id !== id);
      if (pc.favor?.deathId === id) pc.favor = { spent: false };
      await save('pcs', pc); break;
    }
    case 'favor-spend': pc.favor = { spent: true, at: now(), note: '' }; await save('pcs', pc); break;
    case 'favor-restore':
      if (!(await confirmBox(`Give ${pc.name} their coin back?`, 'Their Favor of Fate will show as available again.', 'Give it back'))) return;
      pc.favor = { spent: false }; await save('pcs', pc); break;
    case 'edit-pc': openPc(pc); return;
    case 'add-pc': openPc(null); return;
    case 'toggle-active': pc.active = pc.active === false; await save('pcs', pc); break;
    case 'new-ink': {
      const page = { id: uid(), sessionId: s.id, strokes: [], createdAt: Date.now() };
      await save('ink', page); s.inkIds = [...(s.inkIds || []), page.id]; await save('sessions', s);
      openInk(page); return;
    }
    case 'open-ink': openInk(state.ink.find(i => i.id === b.dataset.id)); return;
    case 'cal-prev': case 'cal-next': {
      let { year, month } = state.calMonth; month += act === 'cal-next' ? 1 : -1;
      if (month < 0) { month = C.CAL.months.length - 1; year--; } if (month >= C.CAL.months.length) { month = 0; year++; }
      state.calMonth = { year: Math.max(1, year), month }; state.calDay = null; break;
    }
    case 'cal-today': { const d = C.fromMinutes(now()); state.calMonth = { year: d.year, month: d.month }; state.calDay = d.day; break; }
    case 'cal-day': state.calDay = +b.dataset.day; break;
    case 'cal-set': {
      const cur = C.fromMinutes(now());
      const t = +b.dataset.epoch * C.DAY + cur.hour * 60 + cur.minute;
      if (!(await confirmBox('Change the current in-game day?', `The campaign's date moves to ${C.fmtDate(t)}, keeping the time of day.`, 'Change date'))) return;
      await setTime(t); break;
    }
    case 'goto-session': state.view = 'session'; state.sessionId = b.dataset.id; window.scrollTo(0, 0); break;
    case 'goto-world': state.view = 'world'; window.scrollTo(0, 0); break;
    case 'pick-loc': openLocPicker(); return;
    case 'go-loc': await moveTo(b.closest('[data-loc]').dataset.loc); break;
    case 'edit-loc': openLocEditor(locById(b.closest('[data-loc]').dataset.loc)); return;
    case 'add-loc': openLocEditor(null); return;
    case 'wx-reroll': {
      const loc = hereLoc(), ep = Math.floor(now() / C.DAY), cur = weatherFor(loc, ep);
      const prev = wxIndex.get(wxId(loc.id, ep - 1)) || null;
      const n = (cur.rerolls || 0) + 1;
      const rec = { ...W.rollDay(loc, ep, prev, 'r' + n), id: cur.id, campaignId: cur.campaignId, locationId: loc.id, rerolls: n, v: 2 };
      dropLaterWeather(loc.id, ep);
      await save('weather', rec); wxIndex.set(rec.id, rec);
      toast(`New weather: ${W.describe(rec)}, ${W.fmtF(rec.low)} to ${W.fmtF(rec.high)}.`); break;
    }
    case 'wx-set': openWxSet(); return;
    // ----- survival
    case 'cond-inc': case 'cond-dec': {
      const k = b.closest('[data-k]').dataset.k, sv = surv(pc);
      sv[k] = Math.max(0, Math.min(6, sv[k] + (act === 'cond-inc' ? 1 : -1))); refreshFlags(pc); await save('pcs', pc); break;
    }
    case 'supplies': { const c = campaign(); c.supplies = b.dataset.v; if (c.supplies === 'plentiful') c.mealPending = null; await save('campaigns', c); break; }
    case 'sleep-good': case 'sleep-bad': {
      for (const p of presentPcs()) { const sv = surv(p); sv.fatigue = Math.max(0, sv.fatigue - (act === 'sleep-good' ? 3 : 1)); restClear(p); await save('pcs', p); }
      toast(act === 'sleep-good' ? 'Everyone slept well: −3 fatigue.' : 'A disturbed night: −1 fatigue.'); break;
    }
    case 'short-rest': for (const p of presentPcs()) { restClear(p); await save('pcs', p); } toast('Short rest: exhaustion from conditions that are better now is gone.'); break;
    case 'ration': { const sv = surv(pc); sv[b.dataset.r] = Math.max(0, sv[b.dataset.r] + +b.dataset.d); await save('pcs', pc); break; }
    case 'ration-all': for (const p of presentPcs()) { const sv = surv(p); sv.food += 2; sv.water += 2; await save('pcs', p); } toast('Everyone got 2 rations of food and 2 of water.'); break;
    case 'meal-eat': {
      for (const p of presentPcs()) {
        const sv = surv(p);
        if (document.querySelector(`[data-meal="food"][data-pc="${p.id}"]`)?.checked && sv.food > 0) { sv.food--; sv.hunger = Math.max(0, sv.hunger - 1); }
        if (document.querySelector(`[data-meal="water"][data-pc="${p.id}"]`)?.checked && sv.water > 0) { sv.water--; sv.thirst = Math.max(0, sv.thirst - 1); }
        await save('pcs', p);
      }
      const c = campaign(); c.mealPending = null; await save('campaigns', c); break;
    }
    case 'meal-skip': { const c = campaign(); c.mealPending = null; await save('campaigns', c); break; }
    case 'gear': openGear(pc); return;
    case 'stamina': openStamina(pc); return;
    // ----- diseases
    case 'exposure': openExposure(); return;
    case 'case-check': openCheck(caseOf(b)); return;
    case 'case-reveal': {
      // The character sheet app shows a disease to its player only after this is tapped
      const cs = caseOf(b); cs.revealed = !cs.revealed; await save('cases', cs);
      toast(cs.revealed ? 'Revealed. It shows on their character sheet after your next sync.' : 'Hidden from their character sheet.'); break;
    }
    case 'case-bedrest': { const cs = caseOf(b); cs.bedRest = !cs.bedRest; await save('cases', cs); break; }
    case 'case-magic': openMagic(caseOf(b)); return;
    case 'case-relapse': {
      const cs = caseOf(b); cs.state = 'sick'; cs.log.push({ at: now(), kind: 'relapse', stage: cs.stage });
      await save('cases', cs); toast('Relapse: it stops getting better, and the next check is rolled as normal.'); break;
    }
    case 'case-died': {
      const cs = caseOf(b), pcx = state.pcs.find(p => p.id === cs.pcId), d = disById(cs.diseaseId);
      cs.state = 'ended'; cs.log.push({ at: now(), kind: 'died', stage: cs.stage }); await save('cases', cs);
      openDeath(pcx); $('#deathForm').note.value = `Died of ${d?.name || 'disease'}`; return;
    }
    case 'case-remove': {
      if (!(await confirmBox('Remove this case?', 'Use this to fix a mistake. It disappears from the list and the party table.', 'Remove'))) return;
      const cs = caseOf(b); cs.deleted = true; await save('cases', cs); break;
    }
    case 'outbreak-new': openOutbreak(); return;
    case 'outbreak-end': { const o = state.outbreaks.find(x => x.id === b.closest('[data-ob]').dataset.ob); o.endedAt = now(); await save('outbreaks', o); break; }
    case 'outbreak-del': { const o = state.outbreaks.find(x => x.id === b.closest('[data-ob]').dataset.ob); o.deleted = true; await save('outbreaks', o); break; }
    case 'disease-new': openDisease(null); return;
    case 'past-new': openPast(); return;
    case 'obp-log': case 'obp-none': {
      const box = b.closest('[data-obp]'), c = campaign(), o = state.outbreaks.find(x => x.id === box.dataset.obp), d = disById(o.diseaseId);
      if (act === 'obp-log') {
        const ids = [...box.querySelectorAll('[data-obpc]:checked')].map(i => i.dataset.obpc);
        if (!ids.length) { toast('Tick who was exposed, or tap "No one was exposed".'); return; }
        const r = await createExposures(ids, d, (d.transmission || 'Air').split(',')[0].trim(), false);
        toast([r.logged.length ? `${r.logged.join(', ')} exposed to ${d.name}. Infection check on ${C.fmtShort(now() + H.incubationMins(d))}.` : '', r.immune.length ? `${r.immune.join(', ')} ${r.immune.length > 1 ? 'are' : 'is'} immune.` : ''].filter(Boolean).join(' '));
      }
      c.obPrompts = (c.obPrompts || []).filter(x => x.outbreakId !== o.id); await save('campaigns', c); break;
    }
    case 'toggle-absent': {
      const set = new Set(s.absent || []);
      if (set.has(pc.id)) set.delete(pc.id); else set.add(pc.id);
      s.absent = [...set]; await save('sessions', s);
      toast(set.has(pc.id) ? `${pc.name} is marked absent. Their survival conditions stay as they are until they're back.` : `${pc.name} is back.`); break;
    }
    // ----- training
    case 'train-new': openTraining(); return;
    case 'train-edit': openTraining(state.training.find(x => x.id === b.closest('[data-train]').dataset.train)); return;
    case 'train-pause': {
      const t = state.training.find(x => x.id === b.closest('[data-train]').dataset.train);
      if (t.pausedAt != null) { t.pausedTotal = (t.pausedTotal || 0) + (now() - t.pausedAt); t.pausedAt = null; } else t.pausedAt = now();
      await save('training', t); break;
    }
    case 'train-remove': {
      if (!(await confirmBox('Remove this training?', 'It disappears without counting as finished.', 'Remove'))) return;
      const t = state.training.find(x => x.id === b.closest('[data-train]').dataset.train); t.deleted = true; await save('training', t); break;
    }
    // ----- the item broker
    case 'trade-new': openTrade(b.dataset.kind); return;
    case 'trade-done': case 'trade-pass': {
      const t = state.trades.find(x => x.id === b.closest('[data-trade]').dataset.trade);
      t.state = act === 'trade-done' ? 'done' : 'declined'; t.closedAt = now(); await save('trades', t);
      if (act === 'trade-done' && t.kind === 'buy') {
        await save('cards', { id: uid(), campaignId: state.campaignId, item: t.item, pcId: t.pcId, note: `bought through ${brokerShort()}`, addedAt: now(), done: false });
        toast(`${t.item} added to your cards to make.`);
      }
      break;
    }
    case 'trade-remove': {
      if (!(await confirmBox('Remove this request?', 'Use this to fix a mistake.', 'Remove'))) return;
      const t = state.trades.find(x => x.id === b.closest('[data-trade]').dataset.trade); t.deleted = true; await save('trades', t); break;
    }
    // ----- cards
    case 'card-add': {
      const item = $('#cardItem').value.trim(); if (!item) { $('#cardItem').focus(); return; }
      await save('cards', { id: uid(), campaignId: state.campaignId, item, pcId: $('#cardPc').value, note: '', addedAt: now(), done: false }); break;
    }
    case 'card-remove': { const c = state.cards.find(x => x.id === b.closest('[data-card]').dataset.card); c.deleted = true; await save('cards', c); break; }
    case 'card-undo': { const c = state.cards.find(x => x.id === b.closest('[data-card]').dataset.card); c.done = false; await save('cards', c); break; }
    case 'disease-edit': openDisease(disById(b.closest('[data-dis]').dataset.dis)); return;
    default: return;
  }
  render();
});

$('#view').addEventListener('click', e => {
  const j = e.target.closest('[data-jump]'); if (!j) return;
  e.preventDefault();
  const el = document.getElementById('sec-' + j.dataset.jump); if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - document.querySelector('.tabs').getBoundingClientRect().bottom - 10;
  window.scrollTo({ top, behavior: 'smooth' });
});
$('#view').addEventListener('input', e => {
  const t = e.target;
  if (t.matches('textarea.grow')) autoGrow(t);
  if (t.id === 'searchInput') {
    state.query = t.value;
    const pos = t.selectionStart;
    $('#view').innerHTML = viewHistory();
    const n = $('#searchInput'); n.focus(); n.setSelectionRange(pos, pos);
    return;
  }
  const s = curSession();
  if (t.dataset.field && s) {
    if (t.dataset.field === 'notes' || t.dataset.field === 'shopping') { s[t.dataset.field] = t.value; saveSoon('sessions', s); }
  }
});

$('#view').addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.actChange === 'card-done') { const c = state.cards.find(x => x.id === t.closest('[data-card]').dataset.card); c.done = t.checked; await save('cards', c); render(); return; }
  if (t.dataset.actChange === 'sheltered') { const c = campaign(); c.sheltered = t.checked; await save('campaigns', c); render(); return; }
  const s = curSession();
  if (t.dataset.field === 'number' && s) { s.number = Math.max(1, +t.value || s.number); await save('sessions', s); render(); return; }
  if (t.dataset.field === 'realDate' && s) { s.realDate = t.value; await save('sessions', s); return; }
  if (t.dataset.stat) {
    const pc = state.pcs.find(p => p.id === t.closest('[data-pc]').dataset.pc);
    pc[t.dataset.stat] = t.value === '' ? null : Math.max(0, +t.value);
    await save('pcs', pc);
  }
});

// Header
$('#wxBtn').addEventListener('click', () => { if (!hereLoc()) { openLocPicker(); return; } state.view = 'world'; render(); window.scrollTo(0, 0); });
$('#clockBtn').addEventListener('click', () => {
  $('#timeNow').innerHTML = timeNowHTML();
  $('#timePicker').innerHTML = pickerHTML('tp', now());
  { const d = C.fromMinutes(now()); $('#clockInput').value = `${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')}`; }
  $('#timeDlg').showModal();
});
$('#timeDlg').addEventListener('click', async e => {
  const b = e.target.closest('[data-adv]'); if (!b) return;
  const v = b.dataset.adv;
  if (v === 'dawn') { const d = C.fromMinutes(now()); let t = d.epoch * C.DAY + 360; if (t <= now()) t += C.DAY; await setTime(t); }
  else await setTime(now() + +v, { longRest: v === '480' });
  $('#timePicker').innerHTML = pickerHTML('tp', now());
});
// Set the time of day: moves forward to the next time it's that o'clock (later today, or tomorrow).
async function setClockTo(mins) {
  const d = C.fromMinutes(now());
  let t = d.epoch * C.DAY + mins;
  if (t <= now()) t += C.DAY;
  const span = t - now();
  await setTime(t);
  $('#timePicker').innerHTML = pickerHTML('tp', now());
  $('#clockInput').value = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  toast(`Moved forward ${C.fmtSpan(span)} to ${C.fmtTime(now())}.`);
}
$('#clockSetBtn').addEventListener('click', () => { const [h, m] = ($('#clockInput').value || '').split(':').map(Number); if (!isNaN(h)) setClockTo(h * 60 + (m || 0)); });
document.querySelector('.clock-quick').addEventListener('click', e => { const b = e.target.closest('[data-tod]'); if (b) setClockTo(+b.dataset.tod); });
$('#timeSetBtn').addEventListener('click', async () => { await setTime(readPicker('tp')); toast('In-game date set.'); });

// Settings
function openSettings() {
  const sel = $('#campaignSel');
  const live = state.campaigns.filter(c => !c.deleted);
  const dupName = c => live.filter(x => x.name === c.name).length > 1;
  sel.innerHTML = live.map(c => { const n = state.sessions.filter(x => x.campaignId === c.id && !x.deleted).length;
    return `<option value="${c.id}" ${c.id === state.campaignId ? 'selected' : ''}>${esc(c.name)}${dupName(c) ? ` (${n} session${n === 1 ? '' : 's'}, last changed ${esc(lastEdited(c))})` : ''}</option>`; }).join('');
  $('#campaignName').value = campaign().name;
  $('#survivalToggle').checked = survivalOn();
  $('#diseasesToggle').checked = diseasesOn(); $('#trainingToggle').checked = trainingOn(); $('#brokerToggle').checked = brokerOn();
  $('#brokerName').value = campaign().brokerName || ''; $('#brokerName').closest('label').hidden = !brokerOn();
  $('#calendarName').textContent = C.CAL.name || 'Default calendar';
  renderCombine();
  $('#obToggle').checked = randomOutbreaksOn(); $('#obFreq').value = campaign().outbreakFreq || 'normal';
  applyTheme(themePref);
  let last = null; try { last = localStorage.getItem('sn-lastBackup'); } catch (_) {}
  $('#lastBackup').textContent = last ? `Last backup saved ${new Date(+last).toLocaleString()}.` : 'No backup saved from this device yet.';
  navigator.storage?.estimate?.().then(({ usage }) => { $('#storageInfo').textContent = `Version ${APP_VERSION}. Using ${(usage / 1048576).toFixed(1)} MB on this device.`; })
    .catch(() => { $('#storageInfo').textContent = `Version ${APP_VERSION}.`; });
  $('#settingsDlg').showModal();
}
$('#settingsBtn').addEventListener('click', openSettings);
$('#campaignBtn').addEventListener('click', openSettings);
$('#campaignSel').addEventListener('change', async e => {
  state.campaignId = e.target.value; await db.setMeta('campaignId', state.campaignId);
  campaignChosen(state.campaignId);
  state.sessionId = null; state.calMonth = null; state.calDay = null;
  $('#campaignName').value = campaign().name; render();
});
$('#campaignName').addEventListener('change', async e => {
  const c = campaign(); c.name = e.target.value.trim() || c.name; await save('campaigns', c); openSettings(); renderHeader();
});
$('#obToggle').addEventListener('change', async e => { const c = campaign(); c.randomOutbreaks = e.target.checked; c.obWeek = O.weekOf(now()) - 1; await save('campaigns', c); await rollOutbreaks(); render(); });
$('#obFreq').addEventListener('change', async e => { const c = campaign(); c.outbreakFreq = e.target.value; await save('campaigns', c); });
$('#survivalToggle').addEventListener('change', async e => { const c = campaign(); c.survivalOn = e.target.checked; await save('campaigns', c); render(); });
for (const [id, key] of [['diseasesToggle', 'diseasesOn'], ['trainingToggle', 'trainingOn'], ['brokerToggle', 'brokerOn']])
  $('#' + id).addEventListener('change', async e => { const c = campaign(); c[key] = e.target.checked; await save('campaigns', c); render(); publishSoon(); openSettings(); });
$('#brokerName').addEventListener('change', async e => { const c = campaign(); c.brokerName = e.target.value.trim(); await save('campaigns', c); render(); });

// ---------- the calendar editor
function openCalendar() {
  const f = $('#calForm'), cal = C.CAL;
  f.name.value = cal.name || ''; f.era.value = cal.era || '';
  f.months.value = cal.months.map(m => `${m.name}, ${m.length}`).join('\n');
  f.weekdays.value = cal.weekdays.join(', ');
  f.moons.value = (cal.moons || []).map(m => [m.name, m.cycle, m.color].filter(x => x != null && x !== '').join(', ')).join('\n');
  f.events.value = (cal.events || []).filter(e => e.kind !== 'astro').map(e => [e.name, e.month + 1, e.day, e.days > 1 ? e.days : ''].filter(x => x !== '').join(', ')).join('\n');
  const md = doy => { let m = 0; while (m < cal.months.length - 1 && doy >= C.monthOffset(m + 1)) m++; return `${m + 1} ${doy - C.monthOffset(m) + 1}`; };
  for (const k of ['spring', 'summer', 'autumn', 'winter']) f[k].value = md(cal.seasons[k]);
  $('#calErr').hidden = true;
  $('#calDlg').showModal();
}
function readCalendar() {
  const f = $('#calForm'), err = [];
  const lines = t => t.split('\n').map(l => l.trim()).filter(Boolean);
  const months = lines(f.months.value).map(l => { const m = /^(.*?)[,\s]+(\d+)$/.exec(l); if (!m) err.push(`Month "${l}" needs a name and a number of days.`); return m ? { name: m[1].trim(), length: +m[2] } : null; }).filter(Boolean);
  if (!months.length) err.push('Add at least one month.');
  const weekdays = f.weekdays.value.split(',').map(x => x.trim()).filter(Boolean);
  if (!weekdays.length) err.push('Add at least one weekday.');
  const moons = lines(f.moons.value).map(l => { const p = l.split(',').map(x => x.trim()); const cyc = Number(p[1]); if (!p[0] || !(cyc > 0)) { err.push(`Moon "${l}" needs a name and days per cycle.`); return null; } return { name: p[0], cycle: cyc, shift: 0, color: p[2] || '#f4f1e8' }; }).filter(Boolean);
  const events = lines(f.events.value).map(l => { const p = l.split(',').map(x => x.trim()); const mo = Number(p[1]) - 1, d = Number(p[2]); if (!p[0] || !(mo >= 0 && mo < months.length) || !(d >= 1)) { err.push(`Holiday "${l}" needs a name, a month number and a day.`); return null; } const old = (C.CAL.events || []).find(e => e.name === p[0]); return { name: p[0], month: mo, day: d, ...(Number(p[3]) > 1 ? { days: Number(p[3]) } : {}), kind: 'holiday', ...(old?.description ? { description: old.description } : {}) }; }).filter(Boolean);
  const offs = []; let acc = 0; for (const m of months) { offs.push(acc); acc += m.length; }
  const seasons = {};
  for (const k of ['spring', 'summer', 'autumn', 'winter']) {
    const m = /^(\d+)\D+(\d+)$/.exec(f[k].value.trim());
    if (!m || !(+m[1] >= 1 && +m[1] <= months.length)) { err.push(`${k[0].toUpperCase() + k.slice(1)} needs a month number and a day, like "3 20".`); continue; }
    seasons[k] = offs[+m[1] - 1] + Math.min(+m[2], months[+m[1] - 1].length) - 1;
  }
  const names = { spring: 'Spring equinox', summer: 'Summer solstice', autumn: 'Autumn equinox', winter: 'Winter solstice' };
  const astro = Object.entries(seasons).map(([k, doy]) => { let mo = 0; while (mo < months.length - 1 && doy >= offs[mo + 1]) mo++; return { name: names[k], month: mo, day: doy - offs[mo] + 1, kind: 'astro' }; });
  return { err, cal: { name: f.name.value.trim(), era: f.era.value.trim(), weekdays, months, moons, events: [...astro, ...events], seasons } };
}
$('#calendarBtn').addEventListener('click', openCalendar);
$('#calSave').addEventListener('click', async () => {
  const { err, cal } = readCalendar();
  if (err.length) { $('#calErr').textContent = err.join(' '); $('#calErr').hidden = false; return; }
  const c = campaign(); c.calendar = cal; await save('campaigns', c);
  applyCalendar(); $('#calDlg').close(); state.calMonth = null; render(); openSettings(); toast('Calendar saved.');
});
$('#calDefault').addEventListener('click', async () => {
  const c = campaign(); c.calendar = JSON.parse(JSON.stringify(C.DEFAULT_CALENDAR)); await save('campaigns', c);
  applyCalendar(); $('#calDlg').close(); state.calMonth = null; render(); openSettings(); toast('Using the default calendar.');
});
// Two copies of the same campaign (each device started its own before syncing): fold one into the other.
function lastEdited(c) {
  let t = c.updatedAt || 0;
  for (const st of STORES) if (state[st]?.length) for (const r of state[st]) if (r.campaignId === c.id && (r.updatedAt || 0) > t) t = r.updatedAt;
  return t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
}
function campaignSummary(c) {
  const n = st => state[st].filter(x => x.campaignId === c.id && !x.deleted).length;
  const withNotes = state.sessions.filter(x => x.campaignId === c.id && !x.deleted && (x.notes || '').trim()).length;
  return `${n('sessions')} session${n('sessions') === 1 ? '' : 's'} (${withNotes} with notes), ${n('pcs')} characters, ${n('training')} training, in-game date ${C.fmtShort(c.current)}, last changed ${lastEdited(c)}`;
}
function renderCombine() {
  const others = state.campaigns.filter(c => !c.deleted && c.id !== state.campaignId);
  const box = $('#combineBox');
  if (!others.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<p class="small"><b>This campaign:</b> ${esc(campaign().name)} · ${esc(campaignSummary(campaign()))}</p>
    ${others.map(c => `<div class="combine-row"><span class="small"><b>${esc(c.name)}</b> · ${esc(campaignSummary(c))}</span>
      <button type="button" class="btn small" data-combine="${c.id}">Combine into this one</button></div>`).join('')}
    <p class="muted small">Combining moves the other copy's sessions, notes, training, diseases, item broker requests and cards into this campaign. Characters with the same name become one character. This campaign's in-game date and location are kept. The other copy is then removed, and sync carries the change to your other device.</p>`;
}
$('#combineBox').addEventListener('click', async e => {
  const b = e.target.closest('[data-combine]'); if (!b) return;
  const keep = campaign(), other = state.campaigns.find(c => c.id === b.dataset.combine);
  $('#settingsDlg').close();
  if (!(await confirmBox(`Combine "${other.name}" into this campaign?`, `Its sessions, notes, training, diseases and the rest move here, and characters with the same name are joined up. This campaign keeps its date (${C.fmtShort(keep.current)}).`, 'Combine'))) { openSettings(); return; }
  await combineCampaigns(keep, other);
  toast(`Combined. "${other.name}" is folded into this campaign.`);
  openSettings(); render();
});
async function combineCampaigns(keep, other) {
  flushSaves();
  // Characters: match by name, fill in anything the kept one is missing, and join their histories.
  const map = {};
  const keepPcs = state.pcs.filter(p => p.campaignId === keep.id && !p.deleted);
  for (const op of state.pcs.filter(p => p.campaignId === other.id && !p.deleted)) {
    const kp = keepPcs.find(p => fold(p.name) === fold(op.name));
    if (kp) {
      map[op.id] = kp.id;
      for (const k of ['ancestry', 'classes', 'player', 'maxHp', 'ac', 'pp', 'immunity']) if ((kp[k] == null || kp[k] === '') && op[k] != null && op[k] !== '') kp[k] = op[k];
      const ids = new Set(kp.deaths.map(d => d.id)); kp.deaths = [...kp.deaths, ...op.deaths.filter(d => !ids.has(d.id))];
      if (!kp.favor?.spent && op.favor?.spent) kp.favor = op.favor;
      kp.learned = [...(kp.learned || []), ...(op.learned || [])];
      await save('pcs', kp);
      op.deleted = true; await save('pcs', op);
    } else { op.campaignId = keep.id; await save('pcs', op); map[op.id] = op.id; }
  }
  const re = id => map[id] || id;
  const keepNums = new Set(state.sessions.filter(x => x.campaignId === keep.id && !x.deleted).map(x => x.number));
  for (const s of state.sessions.filter(x => x.campaignId === other.id && !x.deleted)) {
    const empty = !s.notes && !s.shopping && !(s.inkIds || []).length;
    if (empty && keepNums.has(s.number)) { s.deleted = true; await save('sessions', s); continue; } // an empty duplicate
    s.campaignId = keep.id; s.party = (s.party || []).map(p => ({ ...p, pcId: re(p.pcId) })); s.absent = (s.absent || []).map(re);
    await save('sessions', s);
  }
  for (const st of ['cases', 'training', 'trades', 'cards']) {
    for (const r of state[st].filter(x => x.campaignId === other.id && !x.deleted)) { r.campaignId = keep.id; if (r.pcId) r.pcId = re(r.pcId); await save(st, r); }
  }
  for (const o of state.outbreaks.filter(x => x.campaignId === other.id && !x.deleted)) {
    if (o.random) { o.deleted = true; } else o.campaignId = keep.id; // rolled outbreaks belong to the old copy's dice
    await save('outbreaks', o);
  }
  other.deleted = true; await save('campaigns', other);
}

$('#deleteCampaignBtn').addEventListener('click', async () => {
  const c = campaign();
  $('#settingsDlg').close();
  if (!(await confirmBox(`Delete "${c.name}"?`, `This removes the whole campaign: ${campaignSummary(c)}. It's removed from your other device too when it syncs. A backup file is the only way to get it back.`, 'Delete campaign'))) { openSettings(); return; }
  flushSaves();
  for (const st of ['pcs', 'sessions', 'cases', 'training', 'trades', 'cards', 'outbreaks']) {
    for (const r of state[st].filter(x => x.campaignId === c.id && !x.deleted)) { r.deleted = true; await save(st, r); }
  }
  c.deleted = true; await save('campaigns', c);
  let next = state.campaigns.find(x => !x.deleted);
  if (!next) { next = { id: uid(), name: 'New campaign', current: c.current, createdAt: Date.now(), locationId: null, calendar: c.calendar }; await save('campaigns', next); }
  state.campaignId = next.id; await db.setMeta('campaignId', next.id);
  campaignChosen(next.id);
  state.sessionId = null; state.calMonth = null; state.calDay = null;
  toast(`"${c.name}" deleted.`); render(); openSettings();
});
$('#newCampaignBtn').addEventListener('click', async () => {
  // starts on the same in-game date, with the same calendar and the same optional systems as the current one
  const cur = campaign();
  const c = { id: uid(), name: 'New campaign', current: now(), createdAt: Date.now(), calendar: C.calendarData(), ...Object.fromEntries(OPTIONAL_KEYS.map(k => [k, cur?.[k] !== false])) };
  await save('campaigns', c); state.campaignId = c.id; await db.setMeta('campaignId', c.id);
  campaignChosen(c.id);
  state.sessionId = null; state.calMonth = null; openSettings(); render();
  toast('New campaign created. It starts on the same in-game date; change it from the clock.');
});
$('#themeSeg').addEventListener('click', e => {
  const b = e.target.closest('[data-theme]'); if (!b) return;
  themePref = b.dataset.theme; try { localStorage.setItem('sn-theme', themePref); } catch (_) {}
  applyTheme(themePref); render();
});

// ---------- the suite: one campaign list and current campaign for every app, characters linked by permanent id,
// and what each player's sheet shows from here sent over the live link the moment it changes
const SWITCH_KEY = 'sn-campaign-switched'; // when this device last chose a campaign
const switchedAt = () => { try { return Number(localStorage.getItem(SWITCH_KEY)) || 0; } catch { return 0; } };
// This device picked a campaign: every app follows
async function campaignChosen(id) {
  try { localStorage.setItem(SWITCH_KEY, String(Date.now())); } catch { /* storage blocked */ }
  const { core, token } = suiteNow();
  if (core?.saveSuite && token) { try { await core.saveSuite(token, { current: id }); } catch { /* offline: goes up with the next sync */ } }
  linkParty(); publishSoon();
}
let campTimer = null;
function campaignsChanged() { clearTimeout(campTimer); campTimer = setTimeout(() => { pushCampaigns(); pushClock(); }, 1500); }
// Each campaign's in-game time goes to the suite, for apps that need the date (the shop's monthly restocks)
async function pushClock() {
  const { core, token } = suiteNow(); if (!core?.saveSuite || !token) return;
  const known = core.cachedSuite?.().clock || {};
  const clock = {};
  for (const c of state.campaigns) if (!c.deleted && c.current != null && known[c.id]?.now !== c.current) clock[c.id] = c.current;
  if (!Object.keys(clock).length) return;
  try { await core.saveSuite(token, { clock }); } catch { /* next time */ }
}
async function pushCampaigns() {
  const { core, token } = suiteNow(); if (!core?.saveSuite || !token) return;
  const list = state.campaigns.map(c => ({ id: c.id, name: c.name || '', deleted: !!c.deleted, updatedAt: c.updatedAt || c.createdAt || 1 }));
  const sig = JSON.stringify(list.map(c => [c.id, c.name, c.deleted]));
  let last = ''; try { last = localStorage.getItem('sn-campaigns-sent') || ''; } catch { /* */ }
  if (sig === last) return;
  try { await core.saveSuite(token, { campaigns: list }); localStorage.setItem('sn-campaigns-sent', sig); } catch { /* next time */ }
}
// After each sync: share campaigns, follow a campaign another app switched to, link the party, send to sheets
async function suiteSync(core, token) {
  await pushCampaigns();
  await pushClock();
  let s = await core.loadSuite(token);
  // this device switched campaigns while offline: tell the others now
  if (s?.current && s.current.id !== state.campaignId && switchedAt() > (s.current.at || 0)) s = await core.saveSuite(token, { current: state.campaignId });
  const cur = s?.current;
  if (cur?.id && cur.id !== state.campaignId && (cur.at || 0) > switchedAt() && state.campaigns.some(c => c.id === cur.id && !c.deleted)) {
    state.campaignId = cur.id; await db.setMeta('campaignId', cur.id);
    try { localStorage.setItem(SWITCH_KEY, String(cur.at)); } catch { /* */ }
    state.sessionId = null; state.calMonth = null; state.calDay = null;
    toast(`Switched to ${campaign()?.name || 'the current campaign'}, like your other apps.`);
    render();
  }
  try { await core.loadParty(token); } catch (e) { if (e.auth) throw e; }
  await linkParty();
  publishSoon();
}
const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
// Each character in this campaign (from the Character Sheet) has one character here, tied by its permanent id.
// Older ones are tied once by name; missing ones are added; names follow the sheet.
async function linkParty() {
  const { core } = suiteNow(); if (!core?.party) return;
  const chars = core.party(state.campaignId);
  if (!chars.length) return;
  let changed = false;
  for (const ch of chars) {
    const mine = livePcs();
    let pc = mine.find(p => p.charId === ch.id);
    if (!pc) {
      const n = normName(ch.name), f = n.split(' ')[0];
      pc = mine.find(p => !p.charId && normName(p.name) === n) || (f ? mine.find(p => !p.charId && normName(p.name).split(' ')[0] === f) : null);
      if (pc) { pc.charId = ch.id; await save('pcs', pc); changed = true; }
    }
    if (!pc) {
      await save('pcs', newPc({ name: ch.name || 'Unnamed', charId: ch.id, ancestry: ch.race || '', classes: ch.classes || '', player: ch.player || '',
        maxHp: ch.maxHp || null, ac: ch.ac || null, pp: ch.pp || null }));
      changed = true; continue;
    }
    if (ch.name && pc.name !== ch.name) { pc.name = ch.name; await save('pcs', pc); changed = true; }
  }
  if (changed) render();
}
// What each player's sheet shows from here (deaths, Favor of Fate, diseases, survival), sent when it changes
const sentSn = new Map();
let pubTimer = null;
function publishSoon() { clearTimeout(pubTimer); pubTimer = setTimeout(publishSheets, 400); }
async function publishSheets() {
  const { core } = suiteNow(); if (!core?.cachedParty) return;
  const [V, L] = await Promise.all([core.views?.(), core.live?.()]);
  if (!V || !L) return;
  const keys = new Map(core.cachedParty().filter(c => c.liveKey).map(c => [c.id, c.liveKey]));
  const sn = { diseases: state.diseases, cases: state.cases };
  for (const pc of state.pcs) {
    if (pc.deleted || !pc.charId || !keys.has(pc.charId)) continue;
    const view = V.snView(sn, pc), k = JSON.stringify(view);
    if (sentSn.get(pc.id) === k) continue;
    if (await L.channel(keys.get(pc.charId), 'sn', { sn: view })) sentSn.set(pc.id, k);
  }
}

// The character sheet app publishes each sheet's Max HP, AC and Passive Perception; linked characters take them
async function partyFromSheets(data) {
  if (data?.app !== 'charsheet-party') return 0;
  let n = 0;
  for (const s of data.chars || []) {
    // the character tied to this sheet by its permanent id (or, before the suite, the sheet's own link)
    const p = state.pcs.find(x => !x.deleted && x.charId === s.id) || (s.snPcId && !state.pcs.some(x => x.charId) ? state.pcs.find(x => x.id === s.snPcId) : null);
    if (!p) continue;
    let ch = false;
    for (const [k, v] of [['maxHp', s.maxHp], ['ac', s.ac], ['pp', s.pp]]) if (v && p[k] !== v) { p[k] = v; ch = true; }
    if (ch) { await save('pcs', p); n++; }
  }
  if (n) render();
  return n;
}

// Everything worth carrying between devices (the backup file and the Drive sync file are the same thing).
async function buildBackupData() {
  const data = { app: 'session-notes', version: 1, exported: new Date().toISOString() };
  for (const s of STORES) data[s] = await db.all(s);
  return data;
}

// Merge another device's data in; the newest edit of each record wins. Returns a short summary.
async function mergeBackupData(data) {
  if (data?.app !== 'session-notes') throw new Error('not ours');
  flushSaves();
  // A brand-new device still has the untouched starter campaign: drop it so the party isn't duplicated.
  const starter = state.campaigns.find(c => c.seed && !state.sessions.some(x => x.campaignId === c.id));
  let switched = false;
  if (starter && (data.campaigns || []).length && !data.campaigns.some(c => c.id === starter.id)) {
    for (const pc of state.pcs.filter(x => x.campaignId === starter.id)) await db.del('pcs', pc.id);
    await db.del('campaigns', starter.id);
    const keep = data.campaigns.find(c => !c.deleted && !c.seed) || data.campaigns[0];
    await db.setMeta('campaignId', keep.id);
    switched = true;
  }
  let added = 0, updated = 0;
  for (const s of STORES) {
    for (const rec of data[s] || []) {
      if (!rec?.id) continue;
      const cur = await db.get(s, rec.id);
      if (!cur) { await db.put(s, rec); added++; } else if ((rec.updatedAt || 0) > (cur.updatedAt || 0)) { await db.put(s, rec); updated++; }
    }
  }
  const changed = switched || added > 0 || updated > 0;
  if (changed) {
    await load();
    indexWeather();
    for (const w of data.weather || []) if (w.manual || w.rerolls) dropLaterWeather(w.locationId, w.epoch, w.campaignId);
    if (!state.sessions.some(x => x.id === state.sessionId && !x.deleted && x.campaignId === state.campaignId)) state.sessionId = latestSession()?.id || null;
    refreshAfterSync();
  }
  const parts = [];
  if (added) parts.push(`${added} new`);
  if (updated) parts.push(`${updated} updated`);
  return { changed, parts: parts.length ? parts : ['party set up from your other device'] };
}

// Don't yank the page out from under the pen: if you're writing, refresh once you stop.
let refreshPending = false;
function refreshAfterSync() {
  const a = document.activeElement;
  const busy = !$('#inkView').hidden || (a && $('#view').contains(a) && a.matches('input, textarea, select'));
  if (busy) { refreshPending = true; renderHeader(); return; }
  refreshPending = false; render();
}
document.addEventListener('focusout', () => setTimeout(() => {
  const a = document.activeElement;
  if (refreshPending && !(a && $('#view').contains(a) && a.matches('input, textarea, select')) && $('#inkView').hidden) { refreshPending = false; render(); }
}, 50));

$('#saveBackupBtn').addEventListener('click', async () => {
  const data = await buildBackupData();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `session-notes-backup-${todayISO()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  try { localStorage.setItem('sn-lastBackup', String(Date.now())); } catch (_) {}
  openSettings(); toast('Backup file saved to your downloads.');
});
$('#loadBackupBtn').addEventListener('click', () => $('#backupFile').click());
$('#backupFile').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch (_) { return toast("That file isn't a Session Notes backup."); }
  try {
    const r = await mergeBackupData(data);
    render();
    toast(r.changed ? `Backup loaded: ${r.parts.join(', ')}.` : 'Backup loaded: everything was already up to date.');
  } catch (_) { toast("That file isn't a Session Notes backup."); }
});

// Never lose the last few words: save right away when the app is switched away or closed.
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSaves(); });
window.addEventListener('pagehide', flushSaves);

// ---------- app updates: restart into the new version, but never in the middle of writing
function updateReady() {
  flushSaves();
  const a = document.activeElement;
  const busy = !$('#inkView').hidden || (a && a.matches && a.matches('input, textarea, select')) || document.querySelector('dialog[open]');
  if (!busy) { toast('Updating to the new version…'); setTimeout(() => location.reload(), 900); return; }
  const bar = $('#updateBar');
  bar.hidden = false;
  bar.querySelector('button').onclick = () => { flushSaves(); setTimeout(() => location.reload(), 300); };
}

// ---------- boot
(async function boot() {
  await load();
  indexWeather();
  await processCases();
  await rollOutbreaks();
  state.sessionId = latestSession()?.id || null;
  render();
  initSync({ toast, build: buildBackupData, merge: async d => { const r = await mergeBackupData(d); await keepSettingInData(); applyCalendar(); return r; }, fromSheets: partyFromSheets, suite: suiteSync });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(reg => {
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
      $('#updateCheckBtn').onclick = async () => {
        if (!navigator.onLine) { toast("You're offline. Connect to the internet to check for updates."); return; }
        toast('Checking for updates…');
        try {
          await reg.update();
          const nw = reg.installing || reg.waiting;
          if (!nw) { toast(`You have the newest version (${APP_VERSION}).`); return; }
          toast('Downloading the update…');
          // When it's ready, the app restarts into it on its own.
        } catch (_) { toast("Couldn't reach the app's website. Try again in a minute."); }
      };
    }).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; } // first install, nothing to refresh
      updateReady();
    });
  }
})();
