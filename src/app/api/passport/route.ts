import { kpass, passportEnabled, pick, readBalance, PASSPORT_DASHBOARD } from "@/lib/passport";

// Who is signed in to Kite Agent Passport here, and how much USDC is in the Passport wallet?
export async function GET() {
  if (!passportEnabled()) {
    return Response.json({ available: false, dashboard: PASSPORT_DASHBOARD, reason: "Kite Agent Passport runs through the kpass app on your own computer, so it isn't available on the hosted demo. Run Reins locally with PAYMENTS_MODE=passport to pay through it." });
  }
  try {
    const me = await kpass(["me"], 20_000);
    let balance: number | null = null;
    try { balance = readBalance(await kpass(["wallet", "balance"], 20_000)); } catch { /* shown as unknown */ }
    return Response.json({ available: true, signedIn: true, email: pick.email(me) ?? null, balance, dashboard: PASSPORT_DASHBOARD });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const notSignedIn = /login|log in|sign ?in|auth|token|unauthor/i.test(msg);
    return Response.json({ available: true, signedIn: false, dashboard: PASSPORT_DASHBOARD, reason: notSignedIn ? "kpass is installed but not signed in. Run: kpass login init --email you@example.com" : msg });
  }
}
