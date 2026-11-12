import { parseStatementCsv } from "@/lib/statement";
import { detectHabits, describeCadence } from "@/lib/habits";
import { servConfigured, servJson } from "@/lib/serv";
import type { Habit, HabitKind } from "@/lib/types";

// Upload a statement: code finds the recurring spending, SERV reviews it
// (friendlier names, bill vs lifestyle, "possibly forgotten" notes).
export async function POST(req: Request) {
  const { csv } = (await req.json()) as { csv?: string };
  if (!csv) return Response.json({ error: "No statement received." }, { status: 400 });

  const transactions = parseStatementCsv(csv);
  if (!transactions.length) return Response.json({ error: "Couldn't read any transactions. Is it a CSV with Date and Description columns?" }, { status: 400 });

  let habits = detectHabits(transactions);
  let reviewedBy: "serv" | "rules" = "rules";

  if (servConfigured() && habits.length) {
    try {
      habits = await reviewWithServ(habits);
      reviewedBy = "serv";
    } catch (e) {
      console.error("SERV review failed, keeping rule-based habits", e);
    }
  } else {
    habits = habits.map((h) => ({ ...h, note: mockNote(h) }));
  }

  return Response.json({
    habits,
    reviewedBy,
    transactions: transactions.length,
    from: transactions[0].date,
    to: transactions[transactions.length - 1].date,
    latestBalanceDate: transactions[transactions.length - 1].date,
    usualWeek: usualWeek(transactions),
  });
}

type Review = { habits: { id: string; name: string; kind: HabitKind; note?: string }[] };

async function reviewWithServ(habits: Habit[]): Promise<Habit[]> {
  const list = habits.map((h) => ({
    id: h.id, name: h.name, merchants: h.merchants, cadence: describeCadence(h.cadence, h.usualTime),
    avgAmount: h.avgAmount, count: h.count, lastSeen: h.lastSeen, kind: h.kind,
  }));
  const out = await servJson<Review>(
    "You review recurring spending found in a person's bank statement for a budgeting agent called Reins. " +
      "For each habit: give a short friendly name (max 4 words), set kind to 'bill' (subscriptions, phone, rent, utilities), " +
      "'essential' (groceries, pharmacy) or 'lifestyle' (coffee, nights out, rides, takeaway), and an optional note under 12 words " +
      "only if useful, e.g. a subscription that may be forgotten. Keep every id unchanged.",
    `Habits: ${JSON.stringify(list)}\nReturn {"habits":[{"id","name","kind","note"}]}`,
    800,
  );
  const byId = new Map(out.habits.map((r) => [r.id, r]));
  return habits.map((h) => {
    const r = byId.get(h.id);
    if (!r) return h;
    const kind: HabitKind = ["bill", "essential", "lifestyle"].includes(r.kind) ? r.kind : h.kind;
    return { ...h, name: r.name?.trim() || h.name, kind, note: r.note?.trim() || undefined };
  });
}

// Stand-in notes when SERV isn't connected
function mockNote(h: Habit) {
  if (h.category === "subscriptions" && /stream|flix|netflix|prime/i.test(h.merchants.join(" "))) return "Streaming subscription. Still watching? Leave it off if not.";
  if (h.cadence.type === "frequent") return "No fixed day, so Reins handles these as on-demand requests.";
  return undefined;
}

// Average everyday spending per weekday (Mon..Sun). Big one-offs (over $200, e.g. rent) are left out.
function usualWeek(txs: { date: string; amount: number }[]) {
  const totals = new Array(7).fill(0);
  const days = new Array(7).fill(0);
  const first = new Date(`${txs[0].date}T00:00:00Z`).getTime();
  const last = new Date(`${txs[txs.length - 1].date}T00:00:00Z`).getTime();
  for (let t = first; t <= last; t += 864e5) days[(new Date(t).getUTCDay() + 6) % 7]++;
  for (const tx of txs) {
    if (tx.amount >= 0 || tx.amount < -200) continue;
    totals[(new Date(`${tx.date}T00:00:00Z`).getUTCDay() + 6) % 7] += -tx.amount;
  }
  return totals.map((v, i) => Math.round((v / Math.max(1, days[i])) * 100) / 100);
}
