# Reins

**Spend on autopilot. Keep the reins.**

Reins is an AI agent that learns your spending habits from a bank statement, pays for the ones you switch on within hard limits, and switches into **Safe Mode** by itself when your wallet runs low. Built for the SERV Hackathon (Kite track) with **SERV Reasoning** and **Kite Agent Passport**.

## Run it

```bash
npm install
cp .env.example .env.local   # Windows PowerShell: copy .env.example .env.local
npm run dev
```

Open http://localhost:3000 and click **use the sample statement**.

Without a `SERV_API_KEY` the app runs in **mock mode** (no credits used). Add your key to `.env.local` and restart to use SERV for real.

## What works today

- Upload a CSV statement → recurring spending is detected (weekday coffee, Friday nights, monthly bills…)
- **Habit switchboard**: nothing runs until you switch it on; each habit has a hard per-purchase limit
- **Control modes**: Ask me every time · Trust ladder (autopilot after 3 approvals in a row) · Full autopilot
- **Safe Mode**: switches on when the wallet can't cover the next 14 days of bills + your safety floor; pauses lifestyle habits and asks before everything else
- **On-demand requests**: "Order lunch under $15"
- **Simulated clock**: fast-forward a day or a week to see habits get paid
- **Read-only wallet**: reads a Kite testnet balance by address (never holds keys)
- Payments are **mock** for now (fake transaction hashes)

## How decisions work

1. **Rules first** (`src/lib/engine.ts`): limits, pot balance, Safe Mode and the user's mode. All money math is plain code, so it is exact.
2. **SERV second** (`src/app/api/decide/route.ts`): if the rules say "allow", SERV checks whether the purchase looks usual for this person. SERV can turn *allow* into *ask*, never the other way round.

SERV is also used to review detected habits (names, bill vs lifestyle, "forgotten subscription?") and to understand on-demand requests.

## Project map

| Path | What it does | Owner |
| --- | --- | --- |
| `src/lib/statement.ts` | Reads bank statement CSVs | A |
| `src/lib/habits.ts` | Finds recurring spending | A |
| `src/lib/engine.ts` | Rules, limits, Safe Mode | A |
| `src/lib/serv.ts` | SERV Reasoning client | A |
| `src/app/api/*` | Statement, decide, parse-request, pay, wallet, status | A / B |
| `src/lib/payments.ts` | Payment provider (mock now, Kite next) | B |
| `src/lib/wallet.ts` | Read-only Kite testnet wallet | B |
| `src/components/ReinsApp.tsx` | All screens | B |

## Next steps

- [ ] Wire `KitePaymentProvider` to Kite Passport (x402 demo shops via `kite-x402-hono`)
- [ ] Demo shops: coffee, rides, food
- [ ] Logo (orange horse with reins) and polish
- [ ] Deploy to Vercel, record the 90-second demo

## Honest limits

- Spending history comes from an uploaded statement; live bank balances are a future feature.
- Real-world apps (Uber, food delivery) need to accept agent payments first; the demo uses x402 demo shops.
- App state is saved in your browser for now (no database yet).
