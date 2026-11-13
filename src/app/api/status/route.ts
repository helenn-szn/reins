import { servConfigured, servModel } from "@/lib/serv";
import { paymentsMode } from "@/lib/payments";
import { PAY_SCALE, SHOP_PAY_TO, tokenDecimals } from "@/lib/shops";
import { WALLET_TOKEN } from "@/lib/wallet";
import { walletFor } from "@/lib/wallets";

export async function GET(req: Request) {
  const mode = paymentsMode();
  const w = mode === "kite" ? walletFor(req) : null;
  return Response.json({
    serv: servConfigured() ? { mode: "live", model: servModel() } : { mode: "mock" },
    payments: mode,
    ...(mode === "passport" ? { shopPayTo: SHOP_PAY_TO, payScale: PAY_SCALE } : {}),
    ...(mode === "kite" ? { agent: w?.address ?? null, owner: !!w?.owner, shopPayTo: SHOP_PAY_TO, payScale: PAY_SCALE, token: WALLET_TOKEN, tokenDecimals: await tokenDecimals().catch(() => 18) } : {}),
  });
}
