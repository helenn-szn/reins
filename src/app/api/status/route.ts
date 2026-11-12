import { servConfigured, servModel } from "@/lib/serv";
import { agentAddress, paymentsMode } from "@/lib/payments";
import { PAY_SCALE, SHOP_PAY_TO } from "@/lib/shops";

export function GET() {
  const mode = paymentsMode();
  return Response.json({
    serv: servConfigured() ? { mode: "live", model: servModel() } : { mode: "mock" },
    payments: mode,
    ...(mode === "kite" ? { agent: agentAddress(), shopPayTo: SHOP_PAY_TO, payScale: PAY_SCALE } : {}),
  });
}
