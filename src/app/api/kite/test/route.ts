import { KitePaymentProvider } from "@/lib/payments";

export const maxDuration = 60;

// Smoke test for live payments: buys a $0.01 coffee from the demo shop.
// Only runs with ?key= matching KITE_TEST_KEY, so it can't be used to drain the agent wallet.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = process.env.KITE_TEST_KEY;
  if (!key || url.searchParams.get("key") !== key) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    const payment = await new KitePaymentProvider().pay({
      merchant: "Reins Coffee", amount: 0.01, date: new Date().toISOString().slice(0, 10),
      category: "coffee", memo: "Test espresso", origin: url.origin,
    });
    return Response.json(payment);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
