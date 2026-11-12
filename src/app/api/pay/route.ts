import { getPaymentProvider, type PayInput } from "@/lib/payments";

export async function POST(req: Request) {
  const input = (await req.json()) as PayInput;
  try {
    const payment = await getPaymentProvider().pay(input);
    return Response.json(payment);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Payment failed" }, { status: 502 });
  }
}
