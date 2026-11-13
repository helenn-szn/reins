import { getPaymentProvider, paymentsMode, type PayInput } from "@/lib/payments";
import { walletFor } from "@/lib/wallets";

export const maxDuration = 60; // a Kite payment waits for the transaction to land

export async function POST(req: Request) {
  const { agentKey: _ignored, ...input } = (await req.json()) as PayInput; // never accept a key from the browser
  void _ignored;
  let agentKey;
  if (paymentsMode() === "kite") {
    const w = walletFor(req);
    if (!w) return Response.json({ error: "Missing your Reins wallet id. Reload the page and try again." }, { status: 400 });
    agentKey = w.key;
  }
  try {
    const payment = await getPaymentProvider().pay({ ...input, agentKey, origin: new URL(req.url).origin });
    return Response.json(payment);
  } catch (e) {
    console.error("payment failed", e);
    return Response.json({ error: e instanceof Error ? e.message.split("\n")[0] : "Payment failed" }, { status: 502 });
  }
}
