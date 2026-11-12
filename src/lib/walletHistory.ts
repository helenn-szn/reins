import { isAddress } from "viem";
import type { Transaction } from "./types";

// Reads a wallet's on-chain payment history from KiteScan (a Blockscout explorer), read-only.
// Outgoing token transfers become spending; incoming ones become money in. The result goes
// through the same habit detection as a bank statement.

const EXPLORER_API = process.env.KITE_EXPLORER_API || "https://testnet.kitescan.ai/api/v2";
const MAX_PAGES = 5; // up to ~250 transfers is plenty to spot habits

type BlockscoutTransfer = {
  timestamp: string;
  from: { hash: string; name?: string | null };
  to: { hash: string; name?: string | null };
  total: { value: string; decimals: string | null };
  token: { symbol: string | null; name: string | null };
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export async function fetchWalletTransactions(address: string): Promise<Transaction[]> {
  if (!isAddress(address)) throw new Error("That doesn't look like a wallet address.");
  const me = address.toLowerCase();
  const out: Transaction[] = [];
  let params = "";

  for (let page = 0; page < MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetch(`${EXPLORER_API}/addresses/${address}/token-transfers?type=ERC-20${params}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
    } catch {
      throw new Error("Couldn't reach KiteScan to read this wallet. Check your connection and try again.");
    }
    if (!res.ok) throw new Error(`Couldn't read this wallet's history from KiteScan (${res.status}).`);
    const data = (await res.json()) as { items: BlockscoutTransfer[]; next_page_params: Record<string, string | number> | null };

    for (const t of data.items) {
      const value = Number(t.total.value) / 10 ** Number(t.total.decimals ?? 18);
      if (!value) continue;
      const outgoing = t.from.hash.toLowerCase() === me;
      const other = outgoing ? t.to : t.from;
      const iso = new Date(t.timestamp).toISOString();
      out.push({
        date: iso.slice(0, 10),
        time: iso.slice(11, 16),
        description: other.name || `${outgoing ? "Payment to" : "Received from"} ${short(other.hash)}`,
        amount: Math.round((outgoing ? -value : value) * 100) / 100,
      });
    }

    if (!data.next_page_params) break;
    params = "&" + new URLSearchParams(Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)])).toString();
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
}
