import { servConfigured, servJson } from "@/lib/serv";
import type { Habit } from "@/lib/types";

// Turns "Order lunch under $15" into a purchase: merchant, amount, matching habit.
export async function POST(req: Request) {
  const { text, habits } = (await req.json()) as { text: string; habits: Habit[] };
  if (!text?.trim()) return Response.json({ error: "Say what you'd like Reins to pay for." }, { status: 400 });

  if (servConfigured()) {
    try {
      const options = habits.map((h) => ({ id: h.id, name: h.name, merchants: h.merchants, usualAmount: h.avgAmount }));
      const r = await servJson<{ merchant: string; amount: number; habitId?: string | null }>(
        "You turn a spending request into a purchase for the Reins agent. Pick the best merchant from the person's habits " +
          "if one fits (and give its habitId), otherwise name a sensible merchant type. Amount in USD: use the stated limit, " +
          "or the habit's usual amount, or a typical price.",
        `Request: "${text}"\nHabits: ${JSON.stringify(options)}\nReturn {"merchant","amount","habitId"}`,
      );
      if (r.merchant && r.amount > 0) return Response.json({ merchant: r.merchant, amount: Math.round(r.amount * 100) / 100, habitId: r.habitId || undefined });
    } catch (e) {
      console.error("SERV parse failed, using simple matching", e);
    }
  }
  return Response.json(simpleParse(text, habits));
}

// Stand-in without SERV: find a dollar amount and a keyword
function simpleParse(text: string, habits: Habit[]) {
  const t = text.toLowerCase();
  const amount = Number(t.match(/\$?\s*(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const keywords: [RegExp, string][] = [
    [/lunch|dinner|food|eat|meal|order/, "food"],
    [/ride|taxi|uber|bolt|home|trip/, "rides"],
    [/coffee|latte|cafe/, "coffee"],
    [/grocer/, "groceries"],
  ];
  const cat = keywords.find(([re]) => re.test(t))?.[1];
  const habit = habits.find((h) => h.category === cat);
  return {
    merchant: habit?.merchants[0] ?? (cat ? `Demo ${cat} shop` : "Demo shop"),
    amount: amount || habit?.avgAmount || 10,
    habitId: habit?.id,
  };
}
