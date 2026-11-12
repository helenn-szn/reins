import { servConfigured, servModel } from "@/lib/serv";

export function GET() {
  return Response.json({
    serv: servConfigured() ? { mode: "live", model: servModel() } : { mode: "mock" },
    payments: process.env.PAYMENTS_MODE === "kite" ? "kite" : "mock",
  });
}
