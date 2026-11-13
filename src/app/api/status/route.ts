import { servConfigured, servModel } from "@/lib/serv";
import { agentAddress, paymentsMode } from "@/lib/payments";
import { PAY_SCALE, SHOP_PAY_TO, tokenDecimals } from "@/lib/shops";
import { WALLET_TOKEN } from "@/lib/wallet";

export async function GET() {
  const mode = paymentsMode();
  return Response.json({
    serv: servConfigured() ? { mode: "live", model: servModel() } : { mode: "mock" },
    payments: mode,
    ...(mode === "passport" ? { shopPayTo: SHOP_PAY_TO, payScale: PAY_SCALE } : {}),
    ...(mode === "kite" ? { agent: agentAddress(), shopPayTo: SHOP_PAY_TO, payScale: PAY_SCALE, token: WALLET_TOKEN, tokenDecimals: await tokenDecimals().catch(() => 18) } : {}),
  });
}
