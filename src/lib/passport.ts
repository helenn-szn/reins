import { execFile } from "node:child_process";

// Kite Agent Passport, through Kite's `kpass` CLI on the computer running Reins.
// With PAYMENTS_MODE=passport, Reins pays from the user's Passport wallet and Kite enforces the
// limit: the spending allowance the user set once in the Passport dashboard. Passport is
// production-only (real USDC) and needs the user's own kpass login, so it only works when Reins
// runs on the user's computer (npm run dev), not on the hosted site.

const BIN = process.env.KPASS_BIN || "kpass";
export const passportEnabled = () => process.env.PAYMENTS_MODE === "passport";
export const PASSPORT_DASHBOARD = "https://agentpassport.ai/overview";

type Json = Record<string, unknown>;

export function kpass(args: string[], timeoutMs = 30_000): Promise<Json> {
  return new Promise((resolve, reject) => {
    execFile(/* turbopackIgnore: true */ BIN, [...args, "--output", "json"], { timeout: timeoutMs, shell: process.platform === "win32", windowsHide: true },
      (err, stdout, stderr) => {
        const text = (stdout || "").trim();
        let parsed: Json | null = null;
        try { parsed = text ? JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) : null; } catch { /* not JSON */ }
        if (err && !parsed) {
          const msg = (stderr || err.message || "").trim();
          if ((err as NodeJS.ErrnoException).code === "ENOENT" || /not recognized|not found/i.test(msg)) {
            return reject(new Error(`Couldn't find the kpass app. Install it from Kite's Passport guide, or set KPASS_BIN to where it is.`));
          }
          return reject(new Error(msg.split("\n").slice(-3).join(" ") || "kpass failed"));
        }
        // kpass wraps every reply in { status, hint, next_command, ... }; "error" means the command failed
        if (parsed && typeof parsed.status === "string" && /^(error|fail)/i.test(parsed.status)) {
          return reject(new Error(String(parsed.hint || parsed.message || parsed.error || "kpass reported an error")));
        }
        resolve(parsed ?? { raw: text });
      });
  });
}

// kpass's JSON shapes aren't published yet, so look for the fields we need by name, anywhere in the reply
function find(obj: unknown, test: (k: string, v: unknown) => boolean): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  for (const [k, v] of Object.entries(obj as Json)) if (test(k, v)) return v;
  for (const v of Object.values(obj as Json)) { const r = find(v, test); if (r !== undefined) return r; }
  return undefined;
}
const isUrl = (v: unknown) => typeof v === "string" && /^https?:\/\//.test(v);
export const pick = {
  approvalUrl: (j: Json) => (find(j, (k, v) => /approv|link|url/i.test(k) && isUrl(v)) ?? find(j, (_k, v) => isUrl(v))) as string | undefined,
  requestId: (j: Json) => find(j, (k, v) => /request_?id/i.test(k) && typeof v === "string") as string | undefined
    ?? (find(j, (k, v) => /^(id|session_?id)$/i.test(k) && typeof v === "string") as string | undefined),
  // The top-level "status" is kpass's own envelope ("success" = the command ran), not the session's state.
  // Look for the session's state in its own fields, or in a nested object.
  status: (j: Json) => {
    const own = find(j, (k, v) => /^(session_?status|approval_?status|session_?state|state)$/i.test(k) && typeof v === "string") as string | undefined;
    if (own) return own.toLowerCase();
    for (const [k, v] of Object.entries(j)) if (k !== "status" && v && typeof v === "object") {
      const inner = find(v, (kk, vv) => /^status$/i.test(kk) && typeof vv === "string") as string | undefined;
      if (inner) return inner.toLowerCase();
    }
    return undefined;
  },
  hint: (j: Json) => (typeof j.hint === "string" ? j.hint : undefined),
  email: (j: Json) => find(j, (k, v) => /email/i.test(k) && typeof v === "string") as string | undefined,
  expiresAt: (j: Json) => find(j, (k, v) => /expir/i.test(k) && (typeof v === "string" || typeof v === "number")) as string | number | undefined,
};

// Map kpass's wording onto three states the app understands
export function sessionState(status?: string): "pending" | "active" | "ended" {
  if (!status) return "pending";
  if (/reject|deni|declin|disapprov|expir|cancel|revok|fail/.test(status)) return "ended";
  if (/^(approved|active|granted|authori[sz]ed)$|approved|activ/.test(status)) return "active";
  return "pending";
}

// USDC balance of the Passport wallet. kpass's balance shape isn't published, so take the USDC
// entry if there is one, else the first number under a balance-like name.
export function readBalance(j: Json): number | null {
  const usdc = find(j, (k, v) => /usdc/i.test(k) && (typeof v === "number" || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v))));
  const any = usdc ?? find(j, (k, v) => /balance|available|amount/i.test(k) && (typeof v === "number" || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v))));
  const n = Number(any);
  return Number.isFinite(n) ? n : null;
}

// Pay through Passport: a direct USDC send that Kite checks against the user's allowance
export async function passportSend(to: string, amount: number) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("Bad shop address.");
  const amt = amount.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const j = await kpass(["wallet", "send", "--to", to, "--amount", amt, "--asset", "USDC"], 90_000);
  const hash = find(j, (k, v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) as string | undefined;
  return { hash, hint: pick.hint(j), raw: j };
}
