# Reins

**Spend on autopilot. Keep the reins.**

Reins is an AI agent that learns your spending habits, pays for the ones you switch on within hard limits you set, and gets careful on its own when money runs low. It uses **SERV Reasoning** for judgment and pays shops over **x402 on Kite**.

**Live demo:** [reins-zeta.vercel.app](https://reins-zeta.vercel.app). Click *Try the sample statement* to start.

Built for the OpenServ SERV Hackathon, Edition 02 (Kite track).

## Demo videos

- [**Reins demo**](demo/reins-demo.mp4) (2:13): learning habits from a statement, the habit switchboard, asking SERV, approving, x402 payments on Kite with KiteScan receipts, Safe Mode and autopilot.
- [**Kite Agent Passport update**](demo/reins-kite-passport-update.mp4) (2:05): funding by deposit address, setting a Passport allowance with a passkey, per-habit limits inside it, fast-forwarding a week, and connecting a wallet read-only.

## What it does

1. **Learns your habits.** Upload a bank statement (CSV) or connect a wallet read-only. Reins finds your recurring spending: what, how much, which day and the usual time ("Coffee: about $4.13 most weekdays at 8:10 am").
2. **You choose what it may pay.** Every habit starts switched off. Switch on the ones you want handled and set a hard limit for each.
3. **You choose how much it asks.** *Ask me every time*, *Trust ladder* (a habit earns autopilot after 3 approvals in a row) or *Full autopilot*.
4. **Safe Mode.** If your wallet can't cover the next 2 weeks of bills plus your safety floor, Reins pauses lifestyle spending and asks before everything else. You can also switch it on yourself.
5. **Ask for anything.** "Get me a ride home" or "Order lunch under $15" goes through the same checks.
6. **Pays on Kite.** Approved purchases are paid over x402 to demo shops on Kite's test network, and every payment links to KiteScan.
7. **You fund it, it never pulls.** Reins never spends from your own wallet; it only reads it for Safe Mode, and shows $0.00 until you connect one. Reins spends from its Kite Passport. To add money you send to the Passport's deposit address (copy it or scan the QR) from any wallet, and Reins confirms when it arrives on-chain.

## How a purchase is decided

```mermaid
flowchart LR
  R[Purchase request] --> Rules[Rules: limits, pot, Safe Mode, mode]
  Rules -->|block| B[Blocked]
  Rules -->|ask| A[Waits for your OK]
  Rules -->|allow| S[SERV: is this usual for you?]
  S -->|looks odd| A
  S -->|usual| P[Pay over x402 on Kite]
  A -->|you approve| P
```

- **Rules first** (`src/lib/engine.ts`). Limits, pot balance, Safe Mode and your control mode. All money math is plain code, so it's exact.
- **SERV second** (`src/app/api/decide/route.ts`). If the rules allow a purchase, SERV checks whether it looks usual for this person. SERV can only make a decision stricter, turning *allow* into *ask*, never the other way round.
- SERV also reviews detected habits (clear names, bill vs lifestyle, "forgotten subscription?") and turns plain requests like "Buy my usual coffee" into a merchant, amount and habit.

## How a payment works (x402 on Kite)

1. Reins asks the shop for the item.
2. The shop replies **402 Payment Required** with the price, token and where to pay.
3. Reins checks the price is no more than what was approved, then pays from its agent wallet on Kite.
4. Reins asks again with an `X-PAYMENT` header; the shop verifies the payment on-chain and confirms the order.

Four demo shops (Reins Coffee, Rides, Eats and Store) live at `/api/shops/[shop]`. The **Shops** page shows the orders each one received and the money in the shops' wallet. On testnet each payment is 1/100 of the price (`KITE_PAY_SCALE`), so a little faucet money covers a whole demo.

## Kite Agent Passport

With Kite Agent Passport, you set one spending allowance (up to $100 a week, every 2 weeks or a month), approve it with your passkey, and Kite checks every payment your agents make against it. In Reins, the allowance is what Reins can spend: every payment comes out of it, and anything over what's left is refused ("Kite Passport refused it: $4.13 is more than the $1.35 left of your $30.00 allowance per week"). Your per-habit limits still apply inside it, so Coffee can't go over $5 a day even with $30 left this week.

**Demo (works everywhere):** Settings → Kite Agent Passport → set an amount and period → Approve allowance → Use passkey. This simulates the Passport allowance, so you can see how it works without real USDC; payments still run on Kite testnet. The dashboard's Kite Passport box shows what Reins can spend, with a bar, and when it refills.

**Real Passport (your own computer):** with Kite's `kpass` app installed and signed in, set `PAYMENTS_MODE=passport` in `.env.local` and run `npm run dev`. Reins then pays from your Passport wallet with `kpass wallet send`, and Kite enforces the allowance you set in the [Passport dashboard](https://agentpassport.ai/overview). This moves real USDC (at the demo's 1/100 scale, about 4 cents per coffee).

## Demo controls

Settings → Demo controls moves the simulated date forward. **Fast-forward 1 day** or **1 week** runs every switched-on habit that falls due, and assumes you approved anything that asked along the way, so approvals still count towards each habit's trust ladder. Anything over a habit limit, the Passport allowance or blocked by Safe Mode is still refused. **Use demo balance** gives your own wallet a demo balance with a slider, to show Safe Mode switching on.

## Run it locally

```bash
npm install
cp .env.example .env.local   # Windows PowerShell: copy .env.example .env.local
npm run dev
```

Open http://localhost:3000 and click **Try the sample statement**.

With no keys set, everything runs in mock mode: SERV answers are simulated and payments are fake, so nothing costs money. Add a `SERV_API_KEY` to use SERV for real. For live Kite payments, set `PAYMENTS_MODE=kite` and an agent wallet key, then fund that wallet with test USDT and a little KITE for fees from [faucet.gokite.ai](https://faucet.gokite.ai). See `.env.example` for every setting.

## Project map

| Path | What it does |
| --- | --- |
| `src/components/ReinsApp.tsx` | All screens: landing, dashboard, approvals, activity, shops, settings |
| `src/lib/statement.ts` | Reads bank statement CSVs, including transaction times |
| `src/lib/walletHistory.ts` | Reads a wallet's on-chain payments from KiteScan |
| `src/lib/habits.ts` | Finds recurring spending, its cadence and usual time |
| `src/lib/engine.ts` | Rules, limits, trust ladder, Safe Mode |
| `src/lib/serv.ts` | SERV Reasoning client |
| `src/lib/payments.ts` | Payment providers: mock, and x402 on Kite |
| `src/lib/shops.ts` | Demo shops: payment terms and on-chain verification |
| `src/lib/wallet.ts` | Kite testnet chain and read-only balances |
| `src/app/api/statement` | Statement or wallet → habits (with SERV review) |
| `src/app/api/parse-request` | Plain-language request → purchase (SERV) |
| `src/app/api/decide` | Rules + SERV decision |
| `src/app/api/pay` | Pays a purchase |
| `src/app/api/shops/[shop]` | The x402 demo shops |
| `src/app/api/wallet`, `status` | Balances and which modes are live |
| `src/app/api/selftest` | Protected end-to-end check of the live app |

Built with Next.js 16, React 19, TypeScript, Tailwind CSS v4 and viem.

## Honest limits and what's next

- **One shared demo pot.** Everyone trying the demo spends from the same agent wallet. Reins can already pay through a real Kite Agent Passport on your own computer, and the hosted demo simulates the Passport allowance (see above). Next: Passport payments on the hosted app, so every user's allowance is enforced by Kite.
- **Funding.** Today you deposit test USDT on Kite. Next: automatic top-ups within a weekly cap, deposits from other chains (Passport already offers deposit addresses on Base, Solana, Polygon, Avalanche and more), and card or bank top-ups for people who don't hold crypto.
- **Real merchants.** Uber, airlines and food apps don't accept agent payments yet, so the demo uses x402 shops. Reins works with any merchant that accepts x402.
- **Your data stays in your browser.** There are no accounts yet, so Reins only runs while the page is open. Next: sign-in, so it can pay on schedule with the browser closed.
