import { getPaymentProvider, type PayInput } from "@/lib/payments";

export const maxDuration = 60; // a Kite payment waits for the transaction to land

export async function POST(req: Request) {
  const input = (await req.json()) as PayInput;
  try {
    const payment = await getPaymentProvider().pay({ ...input, origin: new URL(req.url).origin });
    return Response.json(payment);
  } catch (e) {
    console.error("payment failed", e);
    return Response.json({ error: e instanceof Error ? e.message.split("\n")[0] : "Payment failed" }, { status: 502 });
  }
}
