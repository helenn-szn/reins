import type { Decision, EngineState, Habit, Payment } from "@/lib/types";

export const maxDuration = 120;

// End-to-end check of the live app, server side: statement -> habits (SERV review) ->
// "Buy my usual coffee" (SERV parse) -> decision (rules + SERV) -> payment on Kite.
// Also checks that Safe Mode and an unusual purchase are stopped. Guarded by KITE_TEST_KEY.
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!process.env.KITE_TEST_KEY || url.searchParams.get("key") !== process.env.KITE_TEST_KEY) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const origin = url.origin;
  const post = async <T,>(path: string, body: unknown): Promise<T> => {
    const t = Date.now();
    const r = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    steps.push({ path, ms: Date.now() - t, status: r.status });
    if (!r.ok) throw new Error(`${path}: ${j.error ?? r.status}`);
    return j as T;
  };
  const steps: { path: string; ms: number; status: number }[] = [];
  const out: Record<string, unknown> = { steps };

  try {
    // 1. Learn habits from the sample statement
    const csv = await fetch(`${origin}/sample_bank_statement.csv`).then((r) => r.text());
    const st = await post<{ habits: Habit[]; transactions: number; reviewedBy: string; to: string }>("/api/statement", { csv });
    out.statement = { transactions: st.transactions, reviewedBy: st.reviewedBy, habits: st.habits.map((h) => `${h.name} (${h.kind}) ~$${h.avgAmount} ${h.usualTime ?? ""}${h.note ? ` — ${h.note}` : ""}`) };

    const habits = st.habits.map((h) => ({ ...h, enabled: true }));
    const today = st.to;
    const state = (over: Partial<EngineState> = {}): EngineState => ({
      today, mode: "full_autopilot", habits, walletBalance: 300, safetyFloor: 20, potBalance: 100, onDemandAutoLimit: 15, spent: {}, ...over,
    });

    // 2. A normal request, parsed by SERV
    const parsed = await post<{ merchant: string; amount: number; habitId?: string }>("/api/parse-request", { text: "Buy my usual coffee", habits });
    out.parsed = parsed;
    const request = { id: "t1", date: today, description: "Buy my usual coffee", ...parsed };

    // 3. Decision: rules, then SERV's "is this usual?" check
    const decision = await post<Decision>("/api/decide", { request, state: state() });
    out.decision = decision;

    // 4. Pay on Kite if allowed
    if (decision.action === "allow") {
      const habit = habits.find((h) => h.id === parsed.habitId);
      const payment = await post<Payment>("/api/pay", { merchant: parsed.merchant, amount: parsed.amount, date: today, category: habit?.category, memo: "Selftest: usual coffee" });
      out.payment = { shop: payment.shop, onchain: payment.onchain, order: payment.orderId, explorer: payment.explorerUrl, provider: payment.provider };
    }

    // 5. Guards: Safe Mode blocks lifestyle; an odd purchase gets flagged
    const coffee = habits.find((h) => h.category === "coffee");
    out.safeMode = await post<Decision>("/api/decide", { request: { ...request, id: "t2", habitId: coffee?.id }, state: state({ walletBalance: 10 }) });
    out.unusual = await post<Decision>("/api/decide", {
      request: { id: "t3", date: today, merchant: coffee?.merchants[0] ?? "Coffee shop", amount: 14.5, habitId: coffee?.id, description: "Buy 3 bags of coffee beans at 2am" },
      state: state(),
    });
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = e instanceof Error ? e.message : String(e);
  }
  return Response.json(out);
}
