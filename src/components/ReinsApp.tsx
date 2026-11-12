"use client";

import { useEffect, useRef, useState } from "react";
import type { Decision, EngineState, Habit, LogEntry, Mode, Payment, PurchaseRequest } from "@/lib/types";
import { describeCadence, describeLimit } from "@/lib/habits";
import { isDue, periodKey, safeModeStatus, TRUST_LADDER_STEPS } from "@/lib/engine";
import { addDays, pretty } from "@/lib/dates";

type WalletRead = { symbol: string; balance: number; native: number; explorer: string };

type AppState = {
  habits: Habit[];
  statement?: { transactions: number; from: string; to: string; reviewedBy: "serv" | "rules" };
  mode: Mode;
  today: string;
  walletAddress: string;
  walletRead?: WalletRead;
  useDemoBalance: boolean;
  demoBalance: number;
  safetyFloor: number;
  potBalance: number;
  onDemandAutoLimit: number;
  spent: Record<string, number>;
  log: LogEntry[];
};

const INITIAL: AppState = {
  habits: [], mode: "trust_ladder", today: "", walletAddress: "", useDemoBalance: true,
  demoBalance: 150, safetyFloor: 20, potBalance: 100, onDemandAutoLimit: 15, spent: {}, log: [],
};

const STORAGE_KEY = "reins-state-v1";
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "ask_every_time", label: "Ask me every time", hint: "Nothing is paid without your OK." },
  { id: "trust_ladder", label: "Trust ladder", hint: "Habits earn autopilot after 3 approvals in a row." },
  { id: "full_autopilot", label: "Full autopilot", hint: "Regular spending runs on its own, inside every limit." },
];

const usd = (n: number) => `$${n.toFixed(2)}`;
const uid = () => crypto.randomUUID();

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "Request failed");
  return data as T;
}

export default function ReinsApp() {
  const [s, setS] = useState<AppState>(INITIAL);
  const ref = useRef<AppState>(INITIAL);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ serv: { mode: string; model?: string }; payments: string } | null>(null);
  const [request, setRequest] = useState("Order lunch under $15");

  // Always work from the latest state, even inside long async loops
  const update = (fn: (prev: AppState) => AppState) => {
    ref.current = fn(ref.current);
    setS(ref.current);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ref.current)); } catch { /* storage unavailable */ }
  };

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) { ref.current = { ...INITIAL, ...JSON.parse(saved) }; setS(ref.current); }
    } catch { /* ignore */ }
    fetch("/api/status").then((r) => r.json()).then(setStatus).catch(() => {});
  }, []);

  const walletBalance = (st: AppState) => (st.useDemoBalance || !st.walletRead ? st.demoBalance : st.walletRead.balance);
  const engineState = (st: AppState): EngineState => ({
    today: st.today, mode: st.mode, habits: st.habits, walletBalance: walletBalance(st),
    safetyFloor: st.safetyFloor, potBalance: st.potBalance, onDemandAutoLimit: st.onDemandAutoLimit, spent: st.spent,
  });
  const safe = s.today ? safeModeStatus(engineState(s)) : null;

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  // ---- Statement ----
  async function loadStatement(csv: string) {
    const r = await post<{ habits: Habit[]; transactions: number; from: string; to: string; reviewedBy: "serv" | "rules" }>("/api/statement", { csv });
    update((p) => ({ ...p, habits: r.habits, statement: r, today: addDays(r.to, 1), log: [], spent: {} }));
  }

  // ---- Payments and decisions ----
  async function pay(entry: LogEntry) {
    try {
      const payment = await post<Payment>("/api/pay", { merchant: entry.request.merchant, amount: entry.request.amount, date: entry.request.date });
      update((p) => {
        const h = p.habits.find((x) => x.id === entry.request.habitId);
        const key = h ? `${h.id}:${periodKey(h, entry.request.date)}` : null;
        return {
          ...p,
          potBalance: Math.round((p.potBalance - entry.request.amount) * 100) / 100,
          spent: key ? { ...p.spent, [key]: (p.spent[key] ?? 0) + entry.request.amount } : p.spent,
          log: p.log.map((l) => (l.id === entry.id ? { ...l, outcome: "paid", payment } : l)),
        };
      });
    } catch (e) {
      update((p) => ({ ...p, log: p.log.map((l) => (l.id === entry.id ? { ...l, outcome: "failed", decision: { ...l.decision, reason: String(e) } } : l)) }));
    }
  }

  async function processRequest(req: PurchaseRequest) {
    const decision = await post<Decision>("/api/decide", { request: req, state: engineState(ref.current) });
    const entry: LogEntry = {
      id: uid(), date: req.date, request: req, decision,
      outcome: decision.action === "allow" ? "waiting" : decision.action === "ask" ? "waiting" : "blocked",
    };
    update((p) => ({ ...p, log: [entry, ...p.log] }));
    if (decision.action === "allow") await pay(entry);
  }

  async function runDays(n: number) {
    for (let i = 0; i < n; i++) {
      const today = ref.current.today;
      for (const h of ref.current.habits.filter((x) => x.enabled && isDue(x, today))) {
        await processRequest({ id: uid(), date: today, merchant: h.merchants[0], amount: h.avgAmount, habitId: h.id });
      }
      update((p) => ({ ...p, today: addDays(p.today, 1) }));
    }
  }

  async function onDemand() {
    const parsed = await post<{ merchant: string; amount: number; habitId?: string }>("/api/parse-request", { text: request, habits: ref.current.habits });
    await processRequest({ id: uid(), date: ref.current.today, description: request, ...parsed });
  }

  async function approve(entry: LogEntry) {
    if (entry.request.amount > ref.current.potBalance) { setError("Not enough in your spending pot. Top it up first."); return; }
    update((p) => ({ ...p, log: p.log.map((l) => (l.id === entry.id ? { ...l, outcome: "waiting" } : l)) }));
    await pay(entry);
    if (entry.request.habitId) {
      update((p) => ({ ...p, habits: p.habits.map((h) => (h.id === entry.request.habitId ? { ...h, approvalsInARow: h.approvalsInARow + 1 } : h)) }));
    }
  }

  function decline(entry: LogEntry) {
    update((p) => ({
      ...p,
      log: p.log.map((l) => (l.id === entry.id ? { ...l, outcome: "declined" } : l)),
      habits: p.habits.map((h) => (h.id === entry.request.habitId ? { ...h, approvalsInARow: 0 } : h)),
    }));
  }

  // ---- Habits ----
  const setHabit = (id: string, patch: Partial<Habit>) =>
    update((p) => ({ ...p, habits: p.habits.map((h) => (h.id === id ? { ...h, ...patch } : h)) }));
  const toggleHabit = (h: Habit) =>
    setHabit(h.id, h.enabled ? { enabled: false, autopilot: false, approvalsInARow: 0 } : { enabled: true });

  // ---- Wallet ----
  async function readWallet() {
    const r = await fetch(`/api/wallet?address=${encodeURIComponent(ref.current.walletAddress.trim())}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    update((p) => ({ ...p, useDemoBalance: false, walletRead: { symbol: data.token.symbol, balance: data.token.balance, native: data.native.balance, explorer: data.explorer } }));
  }
  function topUp(amount: number) {
    update((p) => ({ ...p, potBalance: p.potBalance + amount, demoBalance: p.useDemoBalance ? Math.max(0, p.demoBalance - amount) : p.demoBalance }));
  }

  const waiting = s.log.filter((l) => l.outcome === "waiting" && l.decision.action === "ask");
  const ready = s.habits.filter((h) => h.enabled && !h.autopilot && h.approvalsInARow >= TRUST_LADDER_STEPS && s.mode === "trust_ladder");

  // ---------------- UI ----------------
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand-500 text-lg font-bold text-white">R</div>
          <div>
            <h1 className="text-xl font-semibold leading-tight">Reins</h1>
            <p className="text-sm text-stone-500">Spend on autopilot. Keep the reins.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Chip tone={status?.serv.mode === "live" ? "good" : "muted"}>SERV: {status?.serv.mode === "live" ? `live (${status.serv.model})` : "mock"}</Chip>
          <Chip tone={status?.payments === "kite" ? "good" : "muted"}>Payments: {status?.payments ?? "…"}</Chip>
          {s.habits.length > 0 && (
            <button className="rounded-lg px-2 py-1 text-stone-500 hover:bg-stone-200" onClick={() => { if (confirm("Start over?")) update(() => INITIAL); }}>Reset</button>
          )}
        </div>
      </header>

      {error && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      {!s.habits.length ? (
        <Upload busy={busy} onCsv={(csv) => run("Reading statement…", () => loadStatement(csv))} />
      ) : (
        <>
          {safe?.active && (
            <div className="mb-4 rounded-2xl bg-safe-600 px-5 py-4 text-white">
              <p className="font-semibold">Safe Mode is on</p>
              <p className="text-sm text-white/90">
                Your wallet has {usd(walletBalance(s))}, but the next two weeks need {usd(safe.upcoming.total)} for bills plus your {usd(s.safetyFloor)} safety floor.
                Lifestyle habits are paused and every other payment needs your approval until the balance recovers.
              </p>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
            {/* Left column */}
            <div className="space-y-4">
              <Card title="Control mode">
                <div className="space-y-2">
                  {MODES.map((m) => (
                    <label key={m.id} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${s.mode === m.id ? "border-brand-500 bg-brand-50" : "border-stone-200"}`}>
                      <input type="radio" className="mt-1 accent-brand-500" checked={s.mode === m.id} onChange={() => update((p) => ({ ...p, mode: m.id }))} />
                      <span><span className="block text-sm font-medium">{m.label}</span><span className="text-xs text-stone-500">{m.hint}</span></span>
                    </label>
                  ))}
                </div>
                {safe?.active && <p className="mt-2 text-xs text-safe-700">Safe Mode is overriding this right now.</p>}
              </Card>

              <Card title="Wallet (read-only)">
                <div className="flex gap-2">
                  <input className="min-w-0 flex-1 rounded-lg border border-stone-300 px-2 py-1.5 text-sm" placeholder="0x… wallet address" value={s.walletAddress}
                    onChange={(e) => update((p) => ({ ...p, walletAddress: e.target.value }))} />
                  <Button variant="secondary" disabled={!!busy || !s.walletAddress} onClick={() => run("Reading wallet…", readWallet)}>Read</Button>
                </div>
                {s.walletRead && (
                  <p className="mt-2 text-xs text-stone-500">
                    On Kite testnet: {s.walletRead.balance} {s.walletRead.symbol}, {s.walletRead.native} KITE ·{" "}
                    <a className="text-brand-600 underline" href={s.walletRead.explorer} target="_blank" rel="noreferrer">view</a>
                  </p>
                )}
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input type="checkbox" className="accent-brand-500" checked={s.useDemoBalance} onChange={(e) => update((p) => ({ ...p, useDemoBalance: e.target.checked }))} />
                  Use demo balance
                </label>
                {s.useDemoBalance && (
                  <div className="mt-1">
                    <input type="range" min={0} max={300} step={5} value={s.demoBalance} className="w-full accent-brand-500"
                      onChange={(e) => update((p) => ({ ...p, demoBalance: Number(e.target.value) }))} />
                  </div>
                )}
                <Stat label="Wallet balance" value={usd(walletBalance(s))} />
                <div className="mt-2 flex items-center justify-between text-sm">
                  <span className="text-stone-500">Safety floor</span>
                  <input type="number" className="w-20 rounded-lg border border-stone-300 px-2 py-1 text-right" value={s.safetyFloor}
                    onChange={(e) => update((p) => ({ ...p, safetyFloor: Number(e.target.value) || 0 }))} />
                </div>
                {safe && (
                  <p className={`mt-2 text-xs ${safe.active ? "text-safe-700" : "text-stone-500"}`}>
                    {safe.active ? "Safe Mode on." : "Safe Mode off."} It switches on below {usd(safe.needed)} (bills due in 14 days {usd(safe.upcoming.total)} + floor).
                  </p>
                )}
              </Card>

              <Card title="Spending pot (Kite Passport)">
                <Stat label="Pot balance" value={usd(s.potBalance)} />
                <p className="mt-1 text-xs text-stone-500">Reins only ever pays from this pot, never from your main wallet.</p>
                <Button className="mt-3 w-full" variant="secondary" onClick={() => topUp(40)}>Move $40 from wallet to pot</Button>
              </Card>
            </div>

            {/* Main column */}
            <div className="space-y-4">
              <Card title={`Today: ${pretty(s.today)}`} right={<span className="text-xs text-stone-500">Simulated clock</span>}>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={!!busy} onClick={() => run("Running the day…", () => runDays(1))}>Fast-forward 1 day</Button>
                  <Button variant="secondary" disabled={!!busy} onClick={() => run("Running the week…", () => runDays(7))}>Fast-forward 1 week</Button>
                </div>
                <div className="mt-4 flex gap-2">
                  <input className="min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-2 text-sm" value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Ask Reins to pay for something…" />
                  <Button disabled={!!busy || !request.trim()} onClick={() => run("Asking Reins…", onDemand)}>Ask Reins</Button>
                </div>
                {busy && <p className="mt-2 text-xs text-stone-500">{busy}</p>}
              </Card>

              {waiting.length > 0 && (
                <Card title={`Needs your approval (${waiting.length})`}>
                  <ul className="divide-y divide-stone-100">
                    {waiting.map((l) => (
                      <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{l.request.merchant} · {usd(l.request.amount)}</p>
                          <p className="text-xs text-stone-500">{l.decision.reason}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {l.request.amount > s.potBalance && <span className="text-xs text-stone-500">Top up the pot first</span>}
                          <Button onClick={() => run("Paying…", () => approve(l))} disabled={!!busy || l.request.amount > s.potBalance}>Approve</Button>
                          <Button variant="secondary" onClick={() => decline(l)}>Decline</Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              {ready.map((h) => (
                <div key={h.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-100 bg-brand-50 px-5 py-3">
                  <p className="text-sm">You approved <b>{h.name}</b> {h.approvalsInARow} times in a row. Shall I just handle it from now on?</p>
                  <div className="flex gap-2">
                    <Button onClick={() => setHabit(h.id, { autopilot: true })}>Yes, autopilot</Button>
                    <Button variant="secondary" onClick={() => setHabit(h.id, { approvalsInARow: 0 })}>Not yet</Button>
                  </div>
                </div>
              ))}

              <Card title="Habit switchboard" right={s.statement && <span className="text-xs text-stone-500">{s.statement.transactions} transactions · {s.statement.from} to {s.statement.to} · reviewed by {s.statement.reviewedBy === "serv" ? "SERV" : "rules"}</span>}>
                <ul className="divide-y divide-stone-100">
                  {s.habits.map((h) => (
                    <li key={h.id} className="flex flex-wrap items-center gap-3 py-3">
                      <Toggle on={h.enabled} onClick={() => toggleHabit(h)} label={`Switch ${h.name}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          {h.name} <span className="font-normal text-stone-500">· ~{usd(h.avgAmount)} {describeCadence(h.cadence)}</span>
                        </p>
                        <p className="text-xs text-stone-500">
                          {h.kind} · seen {h.count}× · {h.merchants.join(", ")}
                          {h.note && <span className="text-brand-700"> · {h.note}</span>}
                        </p>
                      </div>
                      {h.enabled && (
                        <div className="flex items-center gap-2 text-xs">
                          {h.autopilot ? <Chip tone="good">autopilot</Chip> : s.mode === "trust_ladder" && <Chip tone="muted">{h.approvalsInARow}/{TRUST_LADDER_STEPS}</Chip>}
                          <span className="text-stone-500">limit $</span>
                          <input type="number" className="w-16 rounded-lg border border-stone-300 px-2 py-1 text-right" value={h.capPerPurchase}
                            onChange={(e) => setHabit(h.id, { capPerPurchase: Number(e.target.value) || 0 })} />
                          <span className="hidden text-stone-400 sm:inline">({describeLimit(h)})</span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>

              <Card title="Activity">
                {!s.log.length ? (
                  <p className="text-sm text-stone-500">Switch on a habit, then fast-forward a day or ask Reins to pay for something.</p>
                ) : (
                  <ul className="divide-y divide-stone-100">
                    {s.log.map((l) => (
                      <li key={l.id} className="py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-medium">{l.request.merchant} · {usd(l.request.amount)} <span className="font-normal text-stone-500">· {pretty(l.date)}</span></p>
                          <div className="flex gap-1.5">
                            <Chip tone="muted">{l.decision.source === "serv" ? "SERV" : "rules"}</Chip>
                            <Outcome outcome={l.outcome} />
                          </div>
                        </div>
                        <p className="text-xs text-stone-500">{l.request.description ? `“${l.request.description}” · ` : ""}{l.decision.reason}</p>
                        {l.payment?.txHash && <p className="mt-0.5 font-mono text-[11px] text-stone-400">{l.payment.provider} tx {l.payment.txHash.slice(0, 18)}…</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------- Small UI pieces ----------------

function Upload({ onCsv, busy }: { onCsv: (csv: string) => void; busy: string | null }) {
  return (
    <div className="mx-auto max-w-xl rounded-3xl border border-stone-200 bg-white p-8 text-center shadow-sm">
      <h2 className="text-2xl font-semibold">Let Reins learn your habits</h2>
      <p className="mt-2 text-stone-500">Upload a bank statement (CSV). Reins finds your recurring spending, and nothing runs until you switch it on.</p>
      <div className="mt-6 flex flex-col items-center gap-3">
        <label className="cursor-pointer rounded-xl bg-brand-500 px-5 py-2.5 font-medium text-white hover:bg-brand-600">
          Upload statement
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) onCsv(await f.text()); }} />
        </label>
        <button className="text-sm text-brand-600 underline" disabled={!!busy}
          onClick={async () => onCsv(await (await fetch("/sample_bank_statement.csv")).text())}>
          or use the sample statement
        </button>
        {busy && <p className="text-sm text-stone-500">{busy}</p>}
      </div>
    </div>
  );
}

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Button({ variant = "primary", className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  const look = variant === "primary" ? "bg-brand-500 text-white hover:bg-brand-600" : "border border-stone-300 bg-white hover:bg-stone-50";
  return <button {...props} className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${look} ${className}`} />;
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={onClick}
      className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-brand-500" : "bg-stone-300"}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${on ? "left-5" : "left-0.5"}`} />
    </button>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone: "good" | "muted" | "warn" | "bad" | "safe" }) {
  const t = { good: "bg-emerald-100 text-emerald-800", muted: "bg-stone-100 text-stone-600", warn: "bg-amber-100 text-amber-800", bad: "bg-red-100 text-red-800", safe: "bg-safe-50 text-safe-700" }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t}`}>{children}</span>;
}

function Outcome({ outcome }: { outcome: LogEntry["outcome"] }) {
  const map = { paid: ["paid", "good"], waiting: ["waiting", "warn"], blocked: ["blocked", "bad"], declined: ["declined", "muted"], failed: ["failed", "bad"] } as const;
  const [label, tone] = map[outcome];
  return <Chip tone={tone}>{label}</Chip>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-3 flex items-baseline justify-between">
      <span className="text-sm text-stone-500">{label}</span>
      <span className="text-lg font-semibold">{value}</span>
    </div>
  );
}
