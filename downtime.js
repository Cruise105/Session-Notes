// Optional table rules: downtime training (improving abilities and proficiencies with a trainer)
// and a magic item broker who finds buyers and sellers for a 20% fee.
import { DAY } from './calendar.js';

export const ABILITIES = ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'];
export const SKILLS = [
  ['Acrobatics', 'Dexterity'], ['Animal Handling', 'Wisdom'], ['Arcana', 'Intelligence'], ['Athletics', 'Strength'],
  ['Deception', 'Charisma'], ['History', 'Intelligence'], ['Insight', 'Wisdom'], ['Intimidation', 'Charisma'],
  ['Investigation', 'Intelligence'], ['Medicine', 'Wisdom'], ['Nature', 'Intelligence'], ['Perception', 'Wisdom'],
  ['Performance', 'Charisma'], ['Persuasion', 'Charisma'], ['Religion', 'Intelligence'], ['Sleight of Hand', 'Dexterity'],
  ['Stealth', 'Dexterity'], ['Survival', 'Wisdom'],
];
// Tool kits.
export const TOOLS = [
  ["Alchemist's Supplies", ['Intelligence']], ["Brewer's Supplies", ['Wisdom']], ["Calligrapher's Supplies", ['Intelligence']],
  ["Carpenter's Kit", ['Strength']], ["Cartographer's Tools", ['Wisdom']], ["Cobbler's Tools", ['Dexterity']],
  ['Cooking Utensils', ['Intelligence', 'Wisdom']], ["Climber's Kit", ['Strength']], ['Disguise Kit', ['Charisma']],
  ['Forgery Kit', ['Dexterity']], ['Gaming Sets', ['Dexterity', 'Wisdom']], ["Glassblower's Tools", ['Dexterity']],
  ["Healer's Kit", ['Wisdom']], ['Herbalism Kit', ['Wisdom']], ["Jeweler's Tools", ['Dexterity']],
  ["Leatherworker's Tools", ['Dexterity']], ["Mason's Tools", ['Strength']], ['Musical Instruments', ['Charisma']],
  ["Navigator's Tools", ['Wisdom']], ["Painter's Supplies", ['Dexterity']], ["Poisoner's Kit", ['Intelligence']],
  ["Potter's Tools", ['Dexterity']], ["Smith's Tools", ['Strength']], ["Thieves' Tools", ['Dexterity', 'Intelligence']],
  ["Tinker's Tools", ['Intelligence']], ["Weaver's Tools", ['Dexterity']], ["Woodcarver's Tools", ['Dexterity']],
];

// Hours a day, and cost per session (a day) in gp. Saving throws have no price in the table.
export const KINDS = {
  language: { label: 'Language', hours: 4 },
  skill: { label: 'Skill', hours: 2 },
  tool: { label: 'Tool', hours: 2 },
  weapon: { label: 'Weapon', hours: 2 },
  save: { label: 'Saving throw', hours: 3 },
  ability: { label: 'Ability score (+1)', hours: 8 },
};
export function baseCost(kind, sub) {
  if (kind === 'language') return sub === 'Uncommon' ? 6 : 3;
  if (kind === 'skill' || kind === 'tool') return 5;
  if (kind === 'weapon') return sub === 'Firearm' ? 12 : sub === 'Martial' ? 8 : 6;
  if (kind === 'ability') return 25;
  return null;
}
export const TRAINERS = {
  none: { label: 'No trainer', time: 1.5, cost: 0 },
  apprentice: { label: 'Apprentice', time: 1.25, cost: 0.9 },
  skilled: { label: 'Skilled', time: 1, cost: 1 },
  expert: { label: 'Expert', time: 0.75, cost: 1.1 },
};

// Weeks = 10 − modifier, then the trainer's time change. Partial weeks become days, rounded up.
export function trainingDays(mod, trainer) {
  const weeks = Math.max(1, 10 - (+mod || 0));
  return Math.ceil(weeks * TRAINERS[trainer].time * 7 - 1e-9);
}
export function dailyCost(kind, sub, trainer, partyMember) {
  if (trainer === 'none' || partyMember) return 0;
  const b = baseCost(kind, sub);
  return b == null ? null : Math.round(b * TRAINERS[trainer].cost * 100) / 100;
}

export function trainingStatus(t, now) {
  const paused = t.pausedAt != null ? now - t.pausedAt : 0;
  const total = t.days * DAY;
  const done = Math.max(0, Math.min(total, now - t.startAt - (t.pausedTotal || 0) - paused));
  return { done, total, frac: total ? done / total : 1, finishAt: t.startAt + (t.pausedTotal || 0) + paused + total, paused: t.pausedAt != null };
}

// ---------- the magic item broker
export const RARITIES = ['Common', 'Uncommon', 'Rare', 'Very Rare', 'Legendary'];
export const FIND_SELLER = { Common: 90, Uncommon: 70, Rare: 50, 'Very Rare': 30, Legendary: 10 };
export const FIND_BUYER = { Common: 50, Uncommon: 70, Rare: 80, 'Very Rare': 90, Legendary: 95 };
export const WEEKS_DIE = { Common: 4, Uncommon: 6, Rare: 8, 'Very Rare': 10, Legendary: 12 };
export const SELLER_BANDS = [
  { roll: [1, 1], name: 'Desperate seller', lo: 50, hi: 75 },
  { roll: [2, 3], name: 'Reasonable seller', lo: 75, hi: 100 },
  { roll: [4, 5], name: 'Firm seller', lo: 100, hi: 125 },
  { roll: [6, 6], name: 'Stubborn seller', lo: 125, hi: 150 },
];
export const BUYER_BANDS = [
  { roll: [1, 1], name: 'Lowball buyer', lo: 25, hi: 50 },
  { roll: [2, 3], name: 'Reasonable buyer', lo: 50, hi: 75 },
  { roll: [4, 5], name: 'Motivated buyer', lo: 75, hi: 100 },
  { roll: [6, 6], name: 'Desperate buyer', lo: 100, hi: 125 },
];
export const bandFor = (bands, d6) => bands.find(b => d6 >= b.roll[0] && d6 <= b.roll[1]);
export const CALDER_FEE = 0.2;
// The broker is a go-between, like a realtor: the fee is always 20% of the real price.
// Paying up front is a deposit of 20% of the estimated (base) value; he settles the difference honestly on delivery.
export const FEE_TIMING = { upfront: 'Up front, on the estimated value', delivery: 'On delivery, on the actual price' };
// DMG price ranges by rarity, as a reminder when you set a base value.
export const VALUE_HINT = { Common: '50–100 gp', Uncommon: '101–500 gp', Rare: '501–5,000 gp', 'Very Rare': '5,001–50,000 gp', Legendary: '50,001+ gp' };

export const upfrontFee = base => Math.round(base * CALDER_FEE);
export function buyMath(base, pct, timing = 'delivery') {
  const price = Math.round(base * pct / 100), fee = Math.round(price * CALDER_FEE);
  const deposit = timing === 'upfront' ? upfrontFee(base) : 0;
  const settle = fee - deposit; // more owed (+) or refunded (−) on the fee
  return { timing, price, fee, total: price + fee, deposit, settle, dueOnDelivery: price + settle };
}
export function sellMath(base, pct, timing = 'delivery') {
  const offer = Math.round(base * pct / 100), fee = Math.round(offer * CALDER_FEE);
  const deposit = timing === 'upfront' ? upfrontFee(base) : 0;
  const settle = deposit - fee; // refunded (+) or still owed (−) on the fee
  return { timing, offer, fee, deposit, settle, onDelivery: offer - fee + deposit, payout: offer - fee };
}

export function fmtGp(n) {
  if (n == null) return '—';
  const cp = Math.round(n * 100), gp = Math.floor(cp / 100), sp = Math.floor((cp % 100) / 10), c = cp % 10;
  return [gp ? `${gp.toLocaleString()} gp` : '', sp ? `${sp} sp` : '', c ? `${c} cp` : ''].filter(Boolean).join(' ') || '0 gp';
}
