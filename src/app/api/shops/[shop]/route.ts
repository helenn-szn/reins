import { decodePayment, EXPLORER, isShop, paymentTerms, SHOPS, verifyPayment } from "@/lib/shops";

export const maxDuration = 30;

// GET /api/shops/coffee?item=Flat%20white&amount=4.50
// No X-PAYMENT header -> 402 with payment terms. Valid X-PAYMENT -> the order.
export async function GET(req: Request, ctx: { params: Promise<{ shop: string }> }) {
  const { shop } = await ctx.params;
  if (!isShop(shop)) return Response.json({ error: "No such shop." }, { status: 404 });

  const url = new URL(req.url);
  const item = (url.searchParams.get("item") || SHOPS[shop].sells).slice(0, 80);
  const amountUsd = Math.round(Number(url.searchParams.get("amount")) * 100) / 100;
  if (!(amountUsd > 0) || amountUsd > 1000) return Response.json({ error: "Give an amount between $0.01 and $1,000." }, { status: 400 });

  let terms;
  try {
    terms = await paymentTerms(shop, item, amountUsd, `${url.origin}${url.pathname}`);
  } catch {
    return Response.json({ error: "The shop can't reach Kite right now." }, { status: 503 });
  }

  const header = req.headers.get("x-payment");
  if (!header) return Response.json(terms, { status: 402 });

  const payment = decodePayment(header);
  if (!payment) return Response.json({ ...terms, error: "Couldn't read the X-PAYMENT header." }, { status: 402 });

  const check = await verifyPayment(payment.payload.txHash, BigInt(terms.accepts[0].maxAmountRequired));
  if (!check.ok) return Response.json({ ...terms, error: check.reason }, { status: 402 });

  const receipt = { success: true, txHash: payment.payload.txHash, network: payment.network, payer: check.payer };
  return Response.json(
    {
      order: {
        id: `ord_${payment.payload.txHash.slice(2, 12)}`,
        shop: SHOPS[shop].name,
        item,
        amountUsd,
        status: "confirmed",
      },
      payment: { ...receipt, explorer: `${EXPLORER}/tx/${payment.payload.txHash}` },
    },
    { headers: { "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify(receipt)).toString("base64") } },
  );
}
