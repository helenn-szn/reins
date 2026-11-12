import { ruleDecision } from "@/lib/engine";
import { servConfigured, servJson } from "@/lib/serv";
import { describeCadence } from "@/lib/habits";
import type { Decision, EngineState, PurchaseRequest } from "@/lib/types";

// Every purchase passes through here.
// 1. Rules (exact money math, limits, Safe Mode, the user's mode) decide first.
// 2. If the rules say "allow", SERV gets a second look: is this purchase usual for
//    this person? SERV can turn "allow" into "ask", never the other way round.
export async function POST(req: Request) {
  const { request, state } = (await req.json()) as { request: PurchaseRequest; state: EngineState };
  const rules = ruleDecision(request, state);
  if (rules.action !== "allow" || !servConfigured()) return Response.json(rules);

  try {
    const habit = state.habits.find((h) => h.id === request.habitId);
    const context = {
      purchase: { merchant: request.merchant, amount: request.amount, date: request.date, note: request.description },
      matchedHabit: habit ? { name: habit.name, cadence: describeCadence(habit.cadence, habit.usualTime), usualAmount: habit.avgAmount, maxSeen: habit.maxAmount } : null,
      otherHabits: state.habits.filter((h) => h.enabled).map((h) => `${h.name}: ~$${h.avgAmount} ${describeCadence(h.cadence, h.usualTime)}`),
      walletBalance: state.walletBalance,
    };
    const v = await servJson<{ usual: boolean; reason: string }>(
      "You are the judgment step of Reins, an agent that pays for a person's regular purchases. " +
        "Decide if this purchase looks usual for them given their habits. Unusual means a different merchant type, " +
        "a much bigger amount than usual, or an odd time. Give a one-sentence reason a normal person understands.",
      `${JSON.stringify(context)}\nReturn {"usual": true|false, "reason": "..."}`,
    );
    const d: Decision = v.usual
      ? { ...rules, reason: v.reason || rules.reason, source: "serv" }
      : { action: "ask", reason: v.reason || "This looks unusual, so it needs your OK.", source: "serv", safeMode: rules.safeMode };
    return Response.json(d);
  } catch (e) {
    console.error("SERV check failed, using the rules decision", e);
    return Response.json(rules);
  }
}
