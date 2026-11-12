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
    update((p) => {
      const move = p.useDemoBalance ? Math.min(amount, p.demoBalance) : amount; // can't move more than the wallet holds
      return { ...p, potBalance: p.potBalance + move, demoBalance: p.useDemoBalance ? p.demoBalance - move : p.demoBalance };
    });
  }

  const waiting = s.log.filter((l) => l.outcome === "waiting" && l.decision.action === "ask");
  const ready = s.habits.filter((h) => h.enabled && !h.autopilot && h.approvalsInARow >= TRUST_LADDER_STEPS && s.mode === "trust_ladder");

  // ---------------- UI ----------------
  const [showSettings, setShowSettings] = useState(false);
  const [openHabit, setOpenHabit] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const modeLabel = MODES.find((m) => m.id === s.mode)?.label;
  const done = s.log.filter((l) => !(l.outcome === "waiting" && l.decision.action === "ask")); // waiting ones live in "Needs your OK"
  const activity = showAll ? done : done.slice(0, 5);
  const approvable = waiting.filter((l) => l.request.amount <= s.potBalance);
  async function approveAll() {
    for (const l of approvable) {
      const current = ref.current.log.find((x) => x.id === l.id);
      if (current && l.request.amount <= ref.current.potBalance) await approve(current);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Logo size={36} />
          <span className="text-xl font-semibold tracking-tight">Reins</span>
        </div>
        {s.habits.length > 0 && <Button variant="secondary" onClick={() => setShowSettings(true)}>Settings</Button>}
      </header>

      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}<button onClick={() => setError(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      {!s.habits.length ? (
        <Upload busy={busy} onCsv={(csv) => run("Reading statement…", () => loadStatement(csv))} />
      ) : (
        <div className="space-y-4">
          {/* Status */}
          <section className={`rounded-2xl p-5 ${safe?.active ? "bg-safe-600 text-white" : "border border-stone-200 bg-white"}`}>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className={`text-sm ${safe?.active ? "text-white/80" : "text-stone-500"}`}>Wallet</p>
                <p className="text-3xl font-semibold tracking-tight">{usd(walletBalance(s))}</p>
              </div>
              <div>
                <p className={`text-sm ${safe?.active ? "text-white/80" : "text-stone-500"}`}>Spending pot</p>
                <p className="text-3xl font-semibold tracking-tight">{usd(s.potBalance)}</p>
              </div>
            </div>
            <div className={`mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-sm ${safe?.active ? "border-white/20" : "border-stone-100"}`}>
              {safe?.active ? (
                <p><b>Safe Mode is on.</b> Bills in the next 2 weeks plus your floor need {usd(safe.needed)}. Lifestyle habits are paused; everything else asks first.</p>
              ) : (
                <p className="flex items-center gap-2 text-stone-600">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  All good · <button className="underline decoration-stone-300 underline-offset-2" onClick={() => setShowSettings(true)}>{modeLabel}</button>
                </p>
              )}
              <Button variant={safe?.active ? "light" : "secondary"} onClick={() => topUp(40)}>Top up pot $40</Button>
            </div>
          </section>

          {/* Approvals */}
          {waiting.length > 0 && (
            <Card title={`Needs your OK · ${waiting.length}`}
              right={approvable.length > 1 && <button className="text-sm font-medium text-brand-600 disabled:opacity-50" disabled={!!busy} onClick={() => run("Paying…", approveAll)}>Approve all</button>}>
              <ul className="divide-y divide-stone-100">
                {waiting.slice(0, 3).map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{l.request.merchant} · {usd(l.request.amount)}</p>
                      <p className="text-xs text-stone-500">{l.request.amount > s.potBalance ? "Top up the pot first." : l.decision.reason}</p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button onClick={() => run("Paying…", () => approve(l))} disabled={!!busy || l.request.amount > s.potBalance}>Approve</Button>
                      <Button variant="secondary" onClick={() => decline(l)}>Decline</Button>
                    </div>
                  </li>
                ))}
              </ul>
              {waiting.length > 3 && <p className="pt-1 text-xs text-stone-500">+{waiting.length - 3} more</p>}
            </Card>
          )}

          {ready.map((h) => (
            <div key={h.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-brand-50 px-5 py-4">
              <p className="text-sm">You approved <b>{h.name}</b> {h.approvalsInARow} times in a row. Handle it automatically from now on?</p>
              <div className="flex gap-2">
                <Button onClick={() => setHabit(h.id, { autopilot: true })}>Yes</Button>
                <Button variant="secondary" onClick={() => setHabit(h.id, { approvalsInARow: 0 })}>Not yet</Button>
              </div>
            </div>
          ))}

          {/* Ask Reins */}
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (request.trim()) run("Asking Reins…", onDemand); }}>
            <input className="min-w-0 flex-1 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand-500"
              value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Ask Reins to pay for something…" />
            <Button type="submit" className="px-4" disabled={!!busy || !request.trim()}>Ask</Button>
          </form>
          {busy && <p className="-mt-2 text-xs text-stone-500">{busy}</p>}

          {/* Habits */}
          <Card title="Your habits" right={<span className="text-xs text-stone-500">Switch on what Reins may pay for</span>}>
            <ul className="divide-y divide-stone-100">
              {s.habits.map((h) => (
                <li key={h.id} className="py-2.5">
                  <div className="flex items-center gap-3">
                    <Toggle on={h.enabled} onClick={() => toggleHabit(h)} label={`Switch ${h.name}`} />
                    <button className="min-w-0 flex-1 text-left" onClick={() => setOpenHabit(openHabit === h.id ? null : h.id)}>
                      <span className="text-sm font-medium">{h.name}</span>
                      <span className="text-sm text-stone-500"> · {usd(h.avgAmount)} {describeCadence(h.cadence)}</span>
                      {h.note && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand-500 align-middle" title={h.note} />}
                    </button>
                    {h.enabled && h.autopilot && <Chip tone="good">auto</Chip>}
                  </div>
                  {openHabit === h.id && (
                    <div className="ml-14 mt-2 space-y-2 text-xs text-stone-500">
                      {h.note && <p className="text-brand-700">{h.note}</p>}
                      <p>{h.kind} · seen {h.count} times · {h.merchants.join(", ")}</p>
                      <label className="flex items-center gap-2">
                        Limit $
                        <input type="number" className="w-16 rounded-lg border border-stone-300 px-2 py-1 text-right text-stone-900" value={h.capPerPurchase}
                          onChange={(e) => setHabit(h.id, { capPerPurchase: Number(e.target.value) || 0 })} />
                        <span>({describeLimit(h)})</span>
                      </label>
                      {h.enabled && !h.autopilot && s.mode === "trust_ladder" && <p>Trust ladder: {h.approvalsInARow}/{TRUST_LADDER_STEPS} approvals in a row</p>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          {/* Activity */}
          <Card title="Recent activity">
            {!done.length ? (
              <p className="text-sm text-stone-500">Nothing yet. Switch on a habit, or ask Reins to pay for something.</p>
            ) : (
              <>
                <ul className="divide-y divide-stone-100">
                  {activity.map((l) => (
                    <li key={l.id} className="flex items-center justify-between gap-3 py-2.5" title={l.decision.reason}>
                      <div className="min-w-0">
                        <p className="truncate text-sm">{l.request.merchant} <span className="text-stone-500">· {pretty(l.date)}</span></p>
                        {l.outcome !== "paid" && <p className="truncate text-xs text-stone-500">{l.decision.reason}</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-sm font-medium">{usd(l.request.amount)}</span>
                        <Outcome outcome={l.outcome} />
                      </div>
                    </li>
                  ))}
                </ul>
                {done.length > 5 && (
                  <button className="mt-2 text-sm text-brand-600" onClick={() => setShowAll(!showAll)}>{showAll ? "Show less" : `Show all ${done.length}`}</button>
                )}
              </>
            )}
          </Card>

          {/* Demo controls, tucked away */}
          <details className="rounded-2xl border border-dashed border-stone-300 px-5 py-3 text-sm">
            <summary className="cursor-pointer text-stone-500">Demo controls · {pretty(s.today)}</summary>
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button disabled={!!busy} onClick={() => run("Running the day…", () => runDays(1))}>Next day</Button>
                <Button variant="secondary" disabled={!!busy} onClick={() => run("Running the week…", () => runDays(7))}>Next week</Button>
              </div>
              <label className="block">
                <span className="text-stone-500">Demo wallet balance: {usd(s.demoBalance)}</span>
                <input type="range" min={0} max={300} step={5} value={s.demoBalance} className="mt-1 w-full accent-brand-500"
                  onChange={(e) => update((p) => ({ ...p, useDemoBalance: true, demoBalance: Number(e.target.value) }))} />
              </label>
            </div>
          </details>
        </div>
      )}

      {showSettings && (
        <div className="fixed inset-0 z-10 flex justify-end bg-black/30" onClick={() => setShowSettings(false)}>
          <aside className="h-full w-full max-w-sm space-y-6 overflow-y-auto bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Settings</h2>
              <button className="text-stone-500" onClick={() => setShowSettings(false)} aria-label="Close">✕</button>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium">How much should Reins ask?</h3>
              <div className="space-y-2">
                {MODES.map((m) => (
                  <label key={m.id} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${s.mode === m.id ? "border-brand-500 bg-brand-50" : "border-stone-200"}`}>
                    <input type="radio" className="mt-1 accent-brand-500" checked={s.mode === m.id} onChange={() => update((p) => ({ ...p, mode: m.id }))} />
                    <span><span className="block text-sm font-medium">{m.label}</span><span className="text-xs text-stone-500">{m.hint}</span></span>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-stone-500">Safe Mode overrides this whenever money runs low.</p>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium">Wallet (read-only)</h3>
              <div className="flex gap-2">
                <input className="min-w-0 flex-1 rounded-lg border border-stone-300 px-2 py-1.5 text-sm" placeholder="0x… address" value={s.walletAddress}
                  onChange={(e) => update((p) => ({ ...p, walletAddress: e.target.value }))} />
                <Button variant="secondary" disabled={!!busy || !s.walletAddress} onClick={() => run("Reading wallet…", readWallet)}>Connect</Button>
              </div>
              {s.walletRead && (
                <p className="mt-2 text-xs text-stone-500">
                  Kite testnet: {s.walletRead.balance} {s.walletRead.symbol} ·{" "}
                  <a className="text-brand-600 underline" href={s.walletRead.explorer} target="_blank" rel="noreferrer">view</a>
                </p>
              )}
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-brand-500" checked={s.useDemoBalance} onChange={(e) => update((p) => ({ ...p, useDemoBalance: e.target.checked }))} />
                Use demo balance instead
              </label>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium">Safety floor</h3>
              <label className="flex items-center gap-2 text-sm">
                $<input type="number" className="w-24 rounded-lg border border-stone-300 px-2 py-1" value={s.safetyFloor}
                  onChange={(e) => update((p) => ({ ...p, safetyFloor: Number(e.target.value) || 0 }))} />
              </label>
              <p className="mt-1 text-xs text-stone-500">Safe Mode switches on when your wallet can&apos;t cover the next 2 weeks of bills plus this amount.</p>
            </div>

            <div className="space-y-2 border-t border-stone-100 pt-4 text-xs text-stone-500">
              <p>SERV: {status?.serv.mode === "live" ? `live (${status.serv.model})` : "mock mode"} · Payments: {status?.payments ?? "…"}</p>
              <button className="text-red-600" onClick={() => { if (confirm("Start over with a new statement?")) { update(() => INITIAL); setShowSettings(false); } }}>Start over</button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

// ---------------- Small UI pieces ----------------

function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs><clipPath id="reins-logo-clip"><rect width="64" height="64" rx="15" /></clipPath></defs>
      <rect width="64" height="64" rx="15" fill="#F26B1D" />
      <g clipPath="url(#reins-logo-clip)">
        <path d="M37 7 L41 16 C49 20 54 30 55 44 L56 64 L30 64 C30 54 30 48 27 44 C24 41 21 41 18 42 C14 43 10 41 9 37 C8 33 10 30 13 28 L26 15 C28 13 30 11 32 11 Z" fill="#fff" />
        <circle cx="28" cy="22" r="1.9" fill="#F26B1D" />
        <path d="M15 36 C24 44 42 45 62 34" fill="none" stroke="#5A2209" strokeWidth="2.6" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function Upload({ onCsv, busy }: { onCsv: (csv: string) => void; busy: string | null }) {
  return (
    <div className="rounded-3xl border border-stone-200 bg-white p-8 text-center">
      <div className="flex justify-center"><Logo size={64} /></div>
      <h2 className="mt-4 text-2xl font-semibold">Spend on autopilot. Keep the reins.</h2>
      <p className="mt-2 text-stone-500">Upload a bank statement. Reins finds your regular spending, and nothing runs until you switch it on.</p>
      <div className="mt-6 flex flex-col items-center gap-3">
        <label className="cursor-pointer rounded-xl bg-brand-500 px-5 py-2.5 font-medium text-white hover:bg-brand-600">
          Upload statement (CSV)
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) onCsv(await f.text()); }} />
        </label>
        <button className="text-sm text-brand-600 underline" disabled={!!busy}
          onClick={async () => onCsv(await (await fetch("/sample_bank_statement.csv")).text())}>
          or try the sample statement
        </button>
        {busy && <p className="text-sm text-stone-500">{busy}</p>}
      </div>
    </div>
  );
}

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-stone-200 bg-white px-5 py-4">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Button({ variant = "primary", className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "light" }) {
  const look = {
    primary: "bg-brand-500 text-white hover:bg-brand-600",
    secondary: "border border-stone-300 bg-white text-stone-800 hover:bg-stone-50",
    light: "bg-white text-safe-700 hover:bg-white/90",
  }[variant];
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

function Chip({ children, tone }: { children: React.ReactNode; tone: "good" | "muted" | "warn" | "bad" }) {
  const t = { good: "bg-emerald-100 text-emerald-800", muted: "bg-stone-100 text-stone-600", warn: "bg-amber-100 text-amber-800", bad: "bg-red-100 text-red-800" }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t}`}>{children}</span>;
}

function Outcome({ outcome }: { outcome: LogEntry["outcome"] }) {
  const map = { paid: ["paid", "good"], waiting: ["waiting", "warn"], blocked: ["blocked", "bad"], declined: ["declined", "muted"], failed: ["failed", "bad"] } as const;
  const [label, tone] = map[outcome];
  return <Chip tone={tone}>{label}</Chip>;
}
