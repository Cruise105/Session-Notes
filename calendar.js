// The calendar: each campaign keeps its own (campaign.calendar), set with setCalendar(). A campaign without one
// uses the default. Time is stored everywhere as one number: minutes since midnight, day 1 of year 1.
//
// A calendar: { name, era, weekdays: [...], months: [{ name, length }], moons: [{ name, cycle, shift, color }],
//   events: [{ name, month, day, days?, kind, description? }],
//   seasons?: { spring, summer, autumn, winter } (0-based day of year each starts; worked out from the year if missing) }

// The default: a plain twelve-month year (365 days, no leap years), seven-day week and one moon. Any campaign can
// set its own in Settings, Calendar.
const STANDARD = {
  name: 'Standard calendar',
  era: '',
  weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  months: [
    { name: 'January', length: 31 }, { name: 'February', length: 28 }, { name: 'March', length: 31 }, { name: 'April', length: 30 },
    { name: 'May', length: 31 }, { name: 'June', length: 30 }, { name: 'July', length: 31 }, { name: 'August', length: 31 },
    { name: 'September', length: 30 }, { name: 'October', length: 31 }, { name: 'November', length: 30 }, { name: 'December', length: 31 },
  ],
  moons: [{ name: 'The moon', cycle: 29.5, shift: 0, color: '#f4f1e8' }],
  // 20 March, 21 June, 22 September, 21 December (0-based day of the year)
  seasons: { spring: 78, summer: 171, autumn: 264, winter: 354 },
  events: [
    { name: 'Spring equinox', month: 2, day: 20, kind: 'astro' },
    { name: 'Summer solstice', month: 5, day: 21, kind: 'astro' },
    { name: 'Autumn equinox', month: 8, day: 22, kind: 'astro' },
    { name: 'Winter solstice', month: 11, day: 21, kind: 'astro' },
  ],
};

export const DAY = 1440;
export const DEFAULT_CALENDAR = STANDARD;
export const CAL = {};
let offsets = [];
export let YEAR_DAYS = 0;
let current = null;
const copy = o => JSON.parse(JSON.stringify(o));
/** Use this calendar (a campaign's), or the default. Cheap to call often: does nothing if it's already in use. */
export function setCalendar(cal) {
  const next = cal && Array.isArray(cal.months) && cal.months.length ? cal : DEFAULT_CALENDAR;
  if (next === current) return false;
  current = next;
  for (const k of Object.keys(CAL)) delete CAL[k];
  Object.assign(CAL, { name: '', era: '', weekdays: ['Day'], moons: [], events: [] }, copy(next));
  if (!CAL.weekdays.length) CAL.weekdays = ['Day'];
  offsets = []; let acc = 0;
  for (const m of CAL.months) { m.length = Math.max(1, Number(m.length) || 1); offsets.push(acc); acc += m.length; }
  YEAR_DAYS = acc;
  const f = x => Math.round(YEAR_DAYS * x);
  CAL.seasons = { spring: f(0.22), summer: f(0.47), autumn: f(0.72), winter: f(0.97), ...(next.seasons || {}) };
  return true;
}
/** A copy of the calendar in use, to save with a campaign. */
export const calendarData = () => copy(current || DEFAULT_CALENDAR);
setCalendar(null);

export function monthOffset(m) { return offsets[m]; }
export const winterSolstice = () => CAL.seasons.winter;

// Day number since day 1 of year 1 (this matches Fantasy Calendar's "epoch").
export function epochOf(year, month, day) {
  return (year - 1) * YEAR_DAYS + offsets[month] + (day - 1);
}

export function toMinutes({ year, month, day, hour = 0, minute = 0 }) {
  return epochOf(year, month, day) * DAY + hour * 60 + minute;
}

export function fromMinutes(t) {
  const epoch = Math.floor(t / DAY);
  let mins = t - epoch * DAY;
  const year = Math.floor(epoch / YEAR_DAYS) + 1;
  let doy = epoch - (year - 1) * YEAR_DAYS;
  let month = 0;
  while (month < CAL.months.length - 1 && doy >= offsets[month + 1]) month++;
  const day = doy - offsets[month] + 1;
  const hour = Math.floor(mins / 60);
  const minute = mins % 60;
  return { year, month, day, hour, minute, epoch, doy, weekday: weekdayOf(epoch) };
}

// Weeks run on across months and years: day 1 of year 1 is the first weekday.
export function weekdayOf(epoch) { return ((epoch % 7) + 7) % 7; }

export function moonPhase(moon, epoch) {
  const pos = (epoch - moon.shift) / moon.cycle;
  const frac = pos - Math.floor(pos); // 0 = new, 0.5 = full
  const names = ['New', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
  const idx = Math.round(frac * 8) % 8;
  return { frac, name: names[idx], day: Math.floor(frac * moon.cycle) + 1 };
}

export function seasonOf(month, day) {
  const d = offsets[month] + day - 1; // 0-based day of year
  const s = CAL.seasons;
  if (d >= s.spring && d < s.summer) return 'Spring';
  if (d >= s.summer && d < s.autumn) return 'Summer';
  if (d >= s.autumn && d < s.winter) return 'Autumn';
  return 'Winter';
}

export function eventsOn(month, day) {
  return CAL.events.filter(e => e.month === month && day >= e.day && day < e.day + (e.days || 1))
    .map(e => (e.days > 1 ? { ...e, label: `${e.name} (day ${day - e.day + 1} of ${e.days})` } : { ...e, label: e.name }));
}

export function ordinalDay(n) { return String(n); }

export function fmtTime(t) {
  const d = fromMinutes(t);
  const h12 = d.hour % 12 === 0 ? 12 : d.hour % 12;
  return `${h12}:${String(d.minute).padStart(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}`;
}

export function fmtDate(t, { weekday = true, year = true } = {}) {
  const d = fromMinutes(t);
  const parts = [];
  if (weekday) parts.push(CAL.weekdays[d.weekday] + ',');
  parts.push(`${d.day} ${CAL.months[d.month].name}`);
  if (year) parts.push(CAL.era ? `${d.year} ${CAL.era}` : `Year ${d.year}`);
  return parts.join(' ');
}

export function fmtDateTime(t) { return `${fmtDate(t)} · ${fmtTime(t)}`; }

export function fmtShort(t) {
  const d = fromMinutes(t);
  return `${d.day} ${CAL.months[d.month].name} ${d.year}`;
}

// "3 weeks, 2 days" style span.
export function fmtSpan(mins) {
  const neg = mins < 0; mins = Math.abs(mins);
  const days = Math.floor(mins / DAY), rem = mins % DAY;
  const w = Math.floor(days / 7), d = days % 7, h = Math.floor(rem / 60), m = rem % 60;
  const out = [];
  if (w) out.push(`${w} week${w > 1 ? 's' : ''}`);
  if (d) out.push(`${d} day${d > 1 ? 's' : ''}`);
  if (h) out.push(`${h} hour${h > 1 ? 's' : ''}`);
  if (m && !w) out.push(`${m} min`);
  return (neg ? '−' : '') + (out.join(', ') || '0 min');
}
