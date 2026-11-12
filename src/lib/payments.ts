import type { Payment } from "./types";

// Payments go through one interface so the app works the same with fake payments
// today and real Kite Passport payments later. Switch with PAYMENTS_MODE=mock|kite.

export type PayInput = { merchant: string; amount: number; date: string; memo?: string };

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

// TODO (Teammate B): real payments through Kite Agent Passport.
// Plan: each demo shop is an x402 service (kite-x402-hono). Reins calls the shop,
// gets "402 Payment Required", and pays through the Passport session
// (kpass x402 execute, or Passport's direct wallet send as a fallback).
// Waiting on the Kite team: testnet sandbox + which test token (pieUSD vs Test USD).
class KitePaymentProvider implements PaymentProvider {
  name = "kite" as const;
  async pay(): Promise<Payment> {
    throw new Error("Kite payments are not connected yet. Set PAYMENTS_MODE=mock for now.");
  }
}

export function getPaymentProvider(): PaymentProvider {
  return process.env.PAYMENTS_MODE === "kite" ? new KitePaymentProvider() : new MockPaymentProvider();
}
