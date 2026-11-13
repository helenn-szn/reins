import { kpass, passportEnabled, pick } from "@/lib/passport";

// Is Passport available here, and who is signed in to kpass?
export async function GET() {
  if (!passportEnabled()) {
    return Response.json({ available: false, reason: "Kite Agent Passport runs through the kpass app on your own computer, so it isn't available on the hosted demo. Run Reins locally with PASSPORT_MODE=on to use it." });
  }
  try {
    const me = await kpass(["me"], 20_000);
    return Response.json({ available: true, signedIn: true, email: pick.email(me) ?? null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const notSignedIn = /login|log in|sign ?in|auth|token|unauthor/i.test(msg);
    return Response.json({ available: true, signedIn: false, reason: notSignedIn ? "kpass is installed but not signed in. Run: kpass login init --email you@example.com" : msg });
  }
}
