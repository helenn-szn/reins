import { execFile } from "node:child_process";

// Kite Agent Passport, through Kite's `kpass` CLI on the computer running Reins.
// Reins turns its own limits into a Passport spending session (per-payment cap, total budget,
// time window). The user approves it once with their passkey, and from then on Kite enforces
// those limits. Passport is production-only and needs the user's own kpass login, so this only
// works when Reins runs on the user's computer (npm run dev), not on the hosted site.

const BIN = process.env.KPASS_BIN || "kpass";
export const passportEnabled = () => process.env.PASSPORT_MODE === "on";

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
  status: (j: Json) => (find(j, (k, v) => /^(status|state|approval_?status)$/i.test(k) && typeof v === "string") as string | undefined)?.toLowerCase(),
  email: (j: Json) => find(j, (k, v) => /email/i.test(k) && typeof v === "string") as string | undefined,
  expiresAt: (j: Json) => find(j, (k, v) => /expir/i.test(k) && (typeof v === "string" || typeof v === "number")) as string | number | undefined,
};

// Map kpass's wording onto three states the app understands
export function sessionState(status?: string): "pending" | "active" | "ended" {
  if (!status) return "pending";
  if (/approv|activ|grant|ready|success|complete/.test(status)) return "active";
  if (/reject|deni|declin|expir|cancel|revok|fail/.test(status)) return "ended";
  return "pending";
}
