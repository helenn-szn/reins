import { kpass, passportEnabled, pick, sessionState } from "@/lib/passport";

const off = () => Response.json({ error: "Kite Agent Passport is only available when Reins runs on your own computer with PASSPORT_MODE=on." }, { status: 400 });
const num = (v: unknown, max: number) => { const n = Math.round(Number(v) * 100) / 100; return n > 0 && n <= max ? n : null; };
const TTLS = ["24h", "72h", "168h"];

// Create a Passport spending session from Reins' limits. Returns the link the user approves with their passkey.
export async function POST(req: Request) {
  if (!passportEnabled()) return off();
  const b = await req.json();
  const perTx = num(b.maxPerTx, 1000), total = num(b.maxTotal, 10_000);
  const ttl = TTLS.includes(b.ttl) ? b.ttl : "24h";
  if (!perTx || !total || perTx > total) return Response.json({ error: "Limits must be above $0, and the per-payment limit can't be more than the total." }, { status: 400 });
  // Plain words only: on Windows kpass runs through the shell, so nothing that could be read as a command
  const summary = String(b.summary || "Reins: pay my switched-on habits within these limits").replace(/[^\w\s.,:$/()-]/g, "").slice(0, 160) || "Reins spending session";
  try {
    const j = await kpass(["agent:session", "create", "--task-summary", summary, "--max-amount-per-tx", String(perTx),
      "--max-total-amount", String(total), "--ttl", ttl, "--assets", "USDC", "--payment-approach", "x402_http"], 45_000);
    const requestId = pick.requestId(j), approvalUrl = pick.approvalUrl(j);
    if (!requestId && !approvalUrl) return Response.json({ error: "kpass replied without an approval link.", raw: j }, { status: 502 });
    return Response.json({ requestId, approvalUrl, state: sessionState(pick.status(j)), maxPerTx: perTx, maxTotal: total, ttl, raw: j });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

// Has the user approved it yet?
export async function GET(req: Request) {
  if (!passportEnabled()) return off();
  const id = new URL(req.url).searchParams.get("requestId");
  if (!id || !/^[\w-]{4,128}$/.test(id)) return Response.json({ error: "Missing session request id." }, { status: 400 });
  try {
    const j = await kpass(["agent:session", "status", "--request-id", id], 20_000);
    const status = pick.status(j);
    return Response.json({ state: sessionState(status), status: status ?? null, expiresAt: pick.expiresAt(j) ?? null, raw: j });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
