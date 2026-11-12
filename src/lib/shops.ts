import { createPublicClient, decodeEventLog, erc20Abi, http, parseUnits, type Address, type Hash } from "viem";
import { kiteTestnet, WALLET_TOKEN } from "./wallet";

// Demo shops that sell to AI agents over x402 on Kite's test network.
// Ask for something without paying -> "402 Payment Required" with the price and where to pay.
// Pay on-chain, ask again with an X-PAYMENT header carrying the transaction -> the shop checks
// the payment on Kite and serves the order.
//
// Payments here are plain token transfers that the shop verifies itself. With Kite Agent Passport,
// the same 402 reply is answered by a Passport-signed authorization and settled by Kite's
// facilitator instead; the shop side barely changes.

import { SHOPS, type ShopId } from "./shopsInfo";
export { SHOPS, type ShopId };

export const isShop = (s: string): s is ShopId => s in SHOPS;

// Which shop serves a habit category or request
export function shopFor(category?: string, text = ""): ShopId {
  const c = `${category ?? ""} ${text}`.toLowerCase();
  if (/coffee|caf[eé]|latte|espresso/.test(c)) return "coffee";
  if (/ride|taxi|uber|bolt|lyft|trip/.test(c)) return "rides";
  if (/food|lunch|dinner|meal|eat|deliver/.test(c)) return "eats";
  return "store";
}

// Where the shops receive money. A demo merchant wallet; override with SHOP_PAY_TO.
export const SHOP_PAY_TO = (process.env.SHOP_PAY_TO || "0x9B759784ca63D8b1013a55358E4D1dea9f8ec97d") as Address;
export const NETWORK = "kite-testnet";

// Test money is scarce (the faucet gives a couple of USDT), so on testnet each dollar of a
// purchase moves 1/100 of a token by default. Set KITE_PAY_SCALE=1 to pay full price.
export const PAY_SCALE = Number(process.env.KITE_PAY_SCALE || "0.01");
export const onchainAmount = (usd: number) => Math.round(usd * PAY_SCALE * 1e6) / 1e6;
export const EXPLORER = "https://testnet.kitescan.ai";

const client = createPublicClient({ chain: kiteTestnet, transport: http() });
let decimalsCache: number | undefined;
export async function tokenDecimals() {
  decimalsCache ??= await client.readContract({ address: WALLET_TOKEN, abi: erc20Abi, functionName: "decimals" });
  return decimalsCache;
}

export type PaymentTerms = {
  x402Version: 1;
  error: string;
  accepts: {
    scheme: "exact";
    network: string;
    maxAmountRequired: string; // in the token's smallest unit
    resource: string;
    description: string;
    merchantName: string;
    mimeType: "application/json";
    payTo: Address;
    maxTimeoutSeconds: number;
    asset: Address;
    extra: { amountUsd: number; payScale: number; item: string; settlement: "onchain-transfer" };
  }[];
};

export async function paymentTerms(shop: ShopId, item: string, amountUsd: number, resource: string): Promise<PaymentTerms> {
  const decimals = await tokenDecimals();
  return {
    x402Version: 1,
    error: "Payment required",
    accepts: [{
      scheme: "exact",
      network: NETWORK,
      maxAmountRequired: parseUnits(onchainAmount(amountUsd).toFixed(6), decimals).toString(),
      resource,
      description: `${item} from ${SHOPS[shop].name}`,
      merchantName: SHOPS[shop].name,
      mimeType: "application/json",
      payTo: SHOP_PAY_TO,
      maxTimeoutSeconds: 300,
      asset: WALLET_TOKEN,
      extra: { amountUsd, payScale: PAY_SCALE, item, settlement: "onchain-transfer" },
    }],
  };
}

// The X-PAYMENT header: base64 JSON pointing at the payment transaction
export type PaymentHeader = { x402Version: 1; scheme: "exact"; network: string; payload: { txHash: Hash } };
export const encodePayment = (txHash: Hash) =>
  Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: NETWORK, payload: { txHash } } satisfies PaymentHeader)).toString("base64");
export function decodePayment(header: string): PaymentHeader | null {
  try {
    const p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return /^0x[0-9a-fA-F]{64}$/.test(p?.payload?.txHash) ? p : null;
  } catch { return null; }
}

// Each payment can buy one order. Kept in memory: enough for a demo, a real shop would use a database.
const used = new Set<string>();

// Check on Kite that the transaction paid this shop at least the price, recently, in the right token.
export async function verifyPayment(txHash: Hash, required: bigint): Promise<{ ok: true; payer: Address; paid: bigint } | { ok: false; reason: string }> {
  if (used.has(txHash.toLowerCase())) return { ok: false, reason: "This payment was already used for an order." };
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return { ok: false, reason: "Payment transaction not found on Kite yet." };
  }
  if (receipt.status !== "success") return { ok: false, reason: "Payment transaction failed on-chain." };

  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (Date.now() / 1000 - Number(block.timestamp) > 15 * 60) return { ok: false, reason: "Payment is too old." };

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== WALLET_TOKEN.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (ev.eventName === "Transfer" && ev.args.to.toLowerCase() === SHOP_PAY_TO.toLowerCase() && ev.args.value >= required) {
        used.add(txHash.toLowerCase());
        return { ok: true, payer: ev.args.from, paid: ev.args.value };
      }
    } catch { /* not a Transfer */ }
  }
  return { ok: false, reason: "No payment to this shop for the full price in that transaction." };
}
