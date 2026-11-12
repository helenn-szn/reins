import { createWalletClient, createPublicClient, erc20Abi, http, formatUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Payment } from "./types";
import { kiteTestnet, WALLET_TOKEN } from "./wallet";
import { encodePayment, EXPLORER, onchainAmount, SHOPS, shopFor, type PaymentTerms } from "./shops";

// Payments go through one interface so the app works the same with fake payments
// and real payments on Kite. Switch with PAYMENTS_MODE=mock|kite.

export type PayInput = {
  merchant: string;
  amount: number;
  date: string;
  memo?: string;
  category?: string; // habit category, used to pick the shop
  origin?: string; // where the demo shops live (this app's own URL)
};

export interface PaymentProvider {
  name: Payment["provider"];
  pay(input: PayInput): Promise<Payment>;
}

class MockPaymentProvider implements PaymentProvider {
  name = "mock" as const;
  async pay(input: PayInput): Promise<Payment> {
    const hex = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    return { id: crypto.randomUUID(), date: input.date, merchant: input.merchant, amount: input.amount, status: "paid", txHash: `0x${hex}`, provider: "mock" };
  }
}

// Real payments on Kite's test network, x402-style:
//  1. ask the shop for the item -> 402 with the price, token and where to pay
//  2. check the price is what Reins already approved (never pay more)
//  3. send the token from the Reins agent wallet, wait for it to land
//  4. ask again with X-PAYMENT -> the shop verifies on-chain and confirms the order
// The agent wallet is Reins's spending pot: it only holds what the user moved into it.
// Next step: sign with a Kite Agent Passport session instead of a raw agent key.
export class KitePaymentProvider implements PaymentProvider {
  name = "kite" as const;

  async pay(input: PayInput): Promise<Payment> {
    const key = process.env.KITE_AGENT_PRIVATE_KEY as Hex | undefined;
    if (!key) throw new Error("Kite payments need KITE_AGENT_PRIVATE_KEY (the Reins agent wallet).");
    if (!input.origin) throw new Error("Shop address missing.");

    const shop = shopFor(input.category, `${input.merchant} ${input.memo ?? ""}`);
    const url = `${input.origin}/api/shops/${shop}?${new URLSearchParams({ item: input.memo || input.merchant, amount: input.amount.toFixed(2) })}`;

    // 1. Ask without paying
    const first = await fetch(url, { cache: "no-store" });
    if (first.status !== 402) throw new Error(`${SHOPS[shop].name} didn't ask for payment (${first.status}).`);
    const terms = (await first.json()) as PaymentTerms;
    const offer = terms.accepts?.[0];
    if (!offer) throw new Error(`${SHOPS[shop].name} sent no payment terms.`);

    // 2. Never pay more than approved, or in a token/network we didn't agree to
    const account = privateKeyToAccount(key);
    const pub = createPublicClient({ chain: kiteTestnet, transport: http() });
    const decimals = await pub.readContract({ address: WALLET_TOKEN, abi: erc20Abi, functionName: "decimals" });
    const price = BigInt(offer.maxAmountRequired);
    if (offer.asset.toLowerCase() !== WALLET_TOKEN.toLowerCase()) throw new Error("Shop asked for a different token.");
    if (Number(formatUnits(price, decimals)) > onchainAmount(input.amount) + 1e-6) throw new Error(`Shop asked for more than the approved $${input.amount.toFixed(2)}.`);

    const [balance, symbol] = await Promise.all([
      pub.readContract({ address: WALLET_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
      pub.readContract({ address: WALLET_TOKEN, abi: erc20Abi, functionName: "symbol" }),
    ]);
    if (balance < price) throw new Error(`The Reins agent wallet has ${formatUnits(balance, decimals)} ${symbol}, not enough for this. Top it up from the Kite faucet.`);

    // 3. Pay on Kite
    const wallet = createWalletClient({ account, chain: kiteTestnet, transport: http() });
    const txHash = await wallet.writeContract({ address: WALLET_TOKEN, abi: erc20Abi, functionName: "transfer", args: [offer.payTo as Address, price] });
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 45_000 });
    if (receipt.status !== "success") throw new Error("The payment failed on Kite.");

    // 4. Show the shop the payment and get the order
    const second = await fetch(url, { cache: "no-store", headers: { "X-PAYMENT": encodePayment(txHash) } });
    const body = (await second.json()) as { order?: { id: string }; error?: string };
    if (!second.ok) throw new Error(`Paid on Kite but ${SHOPS[shop].name} didn't confirm: ${body.error ?? second.status}`);

    return {
      id: crypto.randomUUID(),
      date: input.date,
      merchant: input.merchant,
      amount: input.amount,
      status: "paid",
      txHash,
      provider: "kite",
      shop: SHOPS[shop].name,
      orderId: body.order?.id,
      explorerUrl: `${EXPLORER}/tx/${txHash}`,
      onchain: `${formatUnits(price, decimals)} ${symbol}`,
    };
  }
}

export const paymentsMode = () => (process.env.PAYMENTS_MODE === "kite" ? "kite" : "mock");

export function getPaymentProvider(): PaymentProvider {
  return paymentsMode() === "kite" ? new KitePaymentProvider() : new MockPaymentProvider();
}

// The Reins agent wallet (spending pot on Kite), for showing its balance
export function agentAddress(): Address | null {
  const key = process.env.KITE_AGENT_PRIVATE_KEY as Hex | undefined;
  try { return key ? privateKeyToAccount(key).address : null; } catch { return null; }
}
