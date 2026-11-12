import type { Cadence, Habit, HabitKind, Transaction } from "./types";
import { dayOfMonth, daysBetween, weekday, WEEKDAYS, ordinal } from "./dates";

// Finds recurring spending in a statement. This part is plain code (no AI), so it is
// fast, free and gives the same answer every time. SERV then reviews the result
// (names, "forgotten subscription?" notes) in /api/statement.

type CategoryRule = { category: string; label: string; kind: HabitKind; match: RegExp; mergeMerchants: boolean };

const CATEGORIES: CategoryRule[] = [
  { category: "coffee", label: "Coffee", kind: "lifestyle", match: /caf[eé]|coffee|espresso|starbucks/i, mergeMerchants: true },
  { category: "nightlife", label: "Night out", kind: "lifestyle", match: /\bbar\b|lounge|pub|club/i, mergeMerchants: true },
  { category: "rides", label: "Rides", kind: "lifestyle", match: /ride|uber|bolt|lyft|taxi|cab\b/i, mergeMerchants: true },
  { category: "food", label: "Food delivery", kind: "lifestyle", match: /food delivery|quickbite|chowdeck|glovo|doordash|ubereats|deliveroo/i, mergeMerchants: true },
  { category: "groceries", label: "Groceries", kind: "essential", match: /grocer|mart\b|supermarket|freshmart/i, mergeMerchants: true },
  { category: "subscriptions", label: "Subscription", kind: "bill", match: /subscription|monthly|music|stream|netflix|spotify|prime|flix/i, mergeMerchants: false },
  { category: "phone", label: "Phone plan", kind: "bill", match: /phone|mobile|airtime|data plan|telecom/i, mergeMerchants: false },
  { category: "rent", label: "Rent", kind: "bill", match: /rent\b|apartment|landlord/i, mergeMerchants: false },
];

export function cleanMerchant(desc: string) {
  return desc
    .replace(/^(card purchase|pos purchase|pos|web purchase|debit card|purchase)\s*/i, "")
    .replace(/\s*-\s*.*$/, (m) => (/(rent|payment)/i.test(desc) ? m : "")) // drop " - HEADPHONES" style suffixes
    .replace(/\s+/g, " ")
    .trim();
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

export function detectHabits(txs: Transaction[]): Habit[] {
  const spend = txs.filter((t) => t.amount < 0);
  if (!spend.length) return [];
  const spanDays = Math.max(7, daysBetween(spend[0].date, spend[spend.length - 1].date) + 1);
  const weeks = spanDays / 7;

  // Group transactions: by category for everyday habits, by merchant for bills.
  const groups = new Map<string, { rule?: CategoryRule; merchants: Map<string, number>; items: Transaction[] }>();
  for (const t of spend) {
    const merchant = titleCase(cleanMerchant(t.description));
    const rule = CATEGORIES.find((c) => c.match.test(t.description));
    const key = rule?.mergeMerchants ? `cat:${rule.category}` : `m:${merchant.toLowerCase()}`;
    const g = groups.get(key) ?? { rule, merchants: new Map<string, number>(), items: [] };
    g.merchants.set(merchant, (g.merchants.get(merchant) ?? 0) + 1);
    g.items.push(t);
    groups.set(key, g);
  }

  const habits: Habit[] = [];
  for (const [key, g] of groups) {
    const cadence = findCadence(g.items, weeks);
    if (!cadence) continue;
    const amounts = g.items.map((t) => -t.amount);
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const max = Math.max(...amounts);
    const merchants = [...g.merchants].sort((a, b) => b[1] - a[1]).map(([m]) => m); // most used first
    let name = g.rule?.mergeMerchants ? g.rule.label : merchants[0].replace(/^Rent Payment.*$/i, "Rent");
    if (g.rule?.category === "nightlife" && cadence.type === "weekly") name = `${WEEKDAYS[cadence.weekday]} night out`;

    habits.push({
      id: key.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase(),
      name,
      category: g.rule?.category ?? "other",
      merchants,
      cadence,
      kind: g.rule?.kind ?? "lifestyle",
      count: g.items.length,
      avgAmount: round2(avg),
      maxAmount: round2(max),
      lastSeen: g.items[g.items.length - 1].date,
      usualTime: typicalTime(g.items),
      enabled: false, // nothing runs until the user switches it on
      capPerPurchase: suggestCap(max),
      approvalsInARow: 0,
      autopilot: false,
    });
  }

  // Most frequent first, then biggest
  return habits.sort((a, b) => b.count - a.count || b.avgAmount - a.avgAmount);
}

function findCadence(items: Transaction[], weeks: number): Cadence | null {
  const n = items.length;
  if (n < 2) return null;
  const dates = items.map((t) => t.date);

  // Monthly: about one a month on a similar day
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
  const doms = dates.map(dayOfMonth);
  if (gaps.every((g) => g >= 26 && g <= 34) && Math.max(...doms) - Math.min(...doms) <= 3) {
    return { type: "monthly", dayOfMonth: median(doms) };
  }
  if (n < 5) return null;

  const byDay = new Array(7).fill(0);
  dates.forEach((d) => byDay[weekday(d)]++);
  const top = byDay.indexOf(Math.max(...byDay));
  const perWeek = n / weeks;

  // Most weekdays (Mon–Fri)
  const weekdayShare = (n - byDay[0] - byDay[6]) / n;
  const weekdaysUsed = byDay.slice(1, 6).filter((c) => c > 0).length;
  if (perWeek >= 3 && weekdayShare >= 0.9 && weekdaysUsed >= 4) return { type: "weekdays" };

  // Weekly on the same day
  if (byDay[top] / n >= 0.7 && perWeek >= 0.5) return { type: "weekly", weekday: top };

  // Regular, but no fixed day
  if (perWeek >= 0.5) return { type: "frequent", perWeek: Math.round(perWeek * 10) / 10 };
  return null;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

// Median time of day, rounded to 5 minutes. Only when most transactions have a time.
function typicalTime(items: Transaction[]): string | undefined {
  const mins = items.filter((t) => t.time).map((t) => Number(t.time!.slice(0, 2)) * 60 + Number(t.time!.slice(3, 5)));
  if (mins.length < Math.ceil(items.length / 2)) return undefined;
  const m = Math.round(median(mins) / 5) * 5;
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// "08:10" -> "8:10 am"
export function formatTime(hhmm?: string) {
  if (!hhmm) return "";
  const h = Number(hhmm.slice(0, 2)), m = hhmm.slice(3, 5);
  return `${h % 12 || 12}:${m} ${h < 12 ? "am" : "pm"}`;
}

// Suggested hard limit: a little above the most it has ever cost, rounded up to a whole dollar
export const suggestCap = (max: number) => Math.ceil(max * 1.1);

export function describeCadence(c: Cadence, usualTime?: string) {
  const when = usualTime ? ` at about ${formatTime(usualTime)}` : "";
  return describeDays(c) + when;
}

function describeDays(c: Cadence) {
  switch (c.type) {
    case "weekdays": return "most weekdays";
    case "weekly": return `every ${WEEKDAYS[c.weekday]}`;
    case "monthly": return `monthly on the ${ordinal(c.dayOfMonth)}`;
    case "frequent": return `about ${c.perWeek} times a week`;
  }
}

export function describeLimit(h: Habit) {
  const per = { weekdays: "a day", weekly: "a week", monthly: "a month", frequent: "per order" }[h.cadence.type];
  return `up to $${h.capPerPurchase} ${per}`;
}
