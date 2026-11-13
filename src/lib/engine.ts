import type { Decision, EngineState, Habit, PurchaseRequest } from "./types";
import { addDays, dayOfMonth, weekday, weekStart } from "./dates";

// The rules side of Reins. All money math lives here, in plain code, so it is
// exact and predictable. SERV adds judgment on top in /api/decide, but it can
// only make a decision MORE careful (allow -> ask), never less.

export const SAFE_MODE_HORIZON_DAYS = 14;

export function isDue(h: Habit, date: string) {
  switch (h.cadence.type) {
    case "weekdays": { const w = weekday(date); return w >= 1 && w <= 5; }
    case "weekly": return weekday(date) === h.cadence.weekday;
    case "monthly": return dayOfMonth(date) === h.cadence.dayOfMonth;
    case "frequent": return false; // no fixed day: these come in as on-demand requests
  }
}

export function periodKey(h: Habit, date: string) {
  switch (h.cadence.type) {
    case "weekdays": return date;
    case "weekly": return weekStart(date);
    case "monthly": return date.slice(0, 7);
    case "frequent": return weekStart(date);
  }
}

// How much a habit may spend in one period (its hard limit)
export function periodCap(h: Habit) {
  const times = h.cadence.type === "frequent" ? Math.max(1, Math.ceil(h.cadence.perWeek)) : 1;
  return h.capPerPurchase * times;
}

// Bills and essentials that are switched on and due in the next two weeks
export function upcomingObligations(s: Pick<EngineState, "habits" | "today">) {
  const items: { habit: Habit; date: string; amount: number }[] = [];
  for (let i = 1; i <= SAFE_MODE_HORIZON_DAYS; i++) {
    const date = addDays(s.today, i);
    for (const h of s.habits) {
      if (h.enabled && h.kind !== "lifestyle" && isDue(h, date)) items.push({ habit: h, date, amount: h.avgAmount });
    }
  }
  return { items, total: round2(items.reduce((a, b) => a + b.amount, 0)) };
}

// Safe Mode switches on by itself when the user's real wallet can't cover what's coming plus
// their safety floor. The user can also switch it on by hand at any time.
export function safeModeStatus(s: EngineState) {
  const upcoming = upcomingObligations(s);
  const needed = round2(upcoming.total + s.safetyFloor);
  const auto = s.walletBalance < needed;
  return { active: auto || Boolean(s.forceSafeMode), auto, manual: Boolean(s.forceSafeMode) && !auto, needed, upcoming };
}

export function ruleDecision(req: PurchaseRequest, s: EngineState): Decision {
  const safe = safeModeStatus(s);
  let habit = req.habitId ? s.habits.find((h) => h.id === req.habitId) : undefined;
  // An on-demand request for something that isn't a switched-on habit is simply a one-off purchase
  if (habit && req.description && !habit.enabled) habit = undefined;
  const d = (action: Decision["action"], reason: string): Decision => ({ action, reason, source: "rules", safeMode: safe.active });

  // 1. Hard limits (Kite would refuse these anyway)
  if (req.amount <= 0) return d("block", "Invalid amount.");
  if (req.amount > s.potBalance) return d("ask", `Your spending pot has $${s.potBalance.toFixed(2)}, not enough for $${req.amount.toFixed(2)}. Top it up from your wallet to continue.`);
  if (habit) {
    if (!habit.enabled) return d("block", `${habit.name} is switched off.`);
  }
  // With a Kite Passport session, Kite holds the spending limits; Reins' own per-habit limits step aside
  if (habit && !s.passportLimits) {
    if (req.amount > habit.capPerPurchase) return d("block", `$${req.amount.toFixed(2)} is over the $${habit.capPerPurchase} limit for ${habit.name}.`);
    const spent = s.spent[`${habit.id}:${periodKey(habit, req.date)}`] ?? 0;
    if (spent + req.amount > periodCap(habit)) return d("block", `${habit.name} already used its limit for this period.`);
  }

  // 2. Safe Mode overrides every mode
  if (safe.active) {
    const why = safe.auto
      ? `your wallet has $${s.walletBalance.toFixed(2)} and you need $${safe.needed.toFixed(2)} for upcoming payments plus your safety floor`
      : "you switched Safe Mode on";
    if (habit?.kind === "lifestyle") return d("block", `Paused in Safe Mode: ${why}.`);
    return d("ask", `Safe Mode is on (${why}), so every payment needs your approval.`);
  }

  // 3. Would this purchase put upcoming bills at risk?
  if (s.walletBalance - req.amount < safe.needed) {
    return d("ask", `Paying $${req.amount.toFixed(2)} would leave less than the $${safe.needed.toFixed(2)} you need for upcoming payments.`);
  }

  // 4. The user's chosen control mode
  if (s.mode === "ask_every_time") return d("ask", "You asked to approve every payment.");
  if (!habit) {
    if (s.mode === "full_autopilot" && req.amount <= s.onDemandAutoLimit) return d("allow", `Small on-demand purchase within your $${s.onDemandAutoLimit} auto-approve limit.`);
    return d("ask", "New purchase, so it needs your OK.");
  }
  if (s.mode === "full_autopilot" || habit.autopilot) return d("allow", `Usual ${habit.name.toLowerCase()} purchase, within its limit.`);
  return d("ask", `${habit.name} hasn't earned autopilot yet (${habit.approvalsInARow}/3 approvals in a row).`);
}

export const TRUST_LADDER_STEPS = 3;
const round2 = (x: number) => Math.round(x * 100) / 100;
