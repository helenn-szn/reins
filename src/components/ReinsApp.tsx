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
  const [page, setPage] = useState<Page>("overview");
  const [openHabit, setOpenHabit] = useState<string | null>(null);
  const modeLabel = MODES.find((m) => m.id === s.mode)?.label;
  const done = s.log.filter((l) => !(l.outcome === "waiting" && l.decision.action === "ask")); // waiting ones live in "Needs your OK"
  const approvable = waiting.filter((l) => l.request.amount <= s.potBalance);
  async function approveAll() {
    for (const l of approvable) {
      const current = ref.current.log.find((x) => x.id === l.id);
      if (current && l.request.amount <= ref.current.potBalance) await approve(current);
    }
  }
  const go = (p: Page) => { setPage(p); window.scrollTo(0, 0); };

  if (!s.habits.length) {
    return (
      <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4 py-10">
        {error && <ErrorBox error={error} onClose={() => setError(null)} />}
        <Upload busy={busy} onCsv={(csv) => run("Reading statement…", () => loadStatement(csv))} />
      </div>
    );
  }

  const nav: { id: Page; label: string; icon: IconName; badge?: number }[] = [
    { id: "overview", label: "Overview", icon: "home", badge: waiting.length || undefined },
    { id: "habits", label: "Habits", icon: "habits", badge: s.habits.filter((h) => h.enabled).length || undefined },
    { id: "activity", label: "Activity", icon: "activity" },
    { id: "settings", label: "Settings", icon: "settings" },
  ];

  const demo = (
    <details className="rounded-xl border border-white/10 px-3 py-2.5 text-sm">
      <summary className="cursor-pointer text-stone-400">Demo · {pretty(s.today)}</summary>
      <div className="mt-3 space-y-3">
        <div className="flex gap-2">
          <Button className="flex-1" disabled={!!busy} onClick={() => run("Running the day…", () => runDays(1))}>+1 day</Button>
          <Button className="flex-1" variant="ghost" disabled={!!busy} onClick={() => run("Running the week…", () => runDays(7))}>+1 week</Button>
        </div>
        <label className="block text-xs text-stone-400">
          Demo wallet: {usd(s.demoBalance)}
          <input type="range" min={0} max={300} step={5} value={s.demoBalance} className="mt-1 w-full accent-brand-500"
            onChange={(e) => update((p) => ({ ...p, useDemoBalance: true, demoBalance: Number(e.target.value) }))} />
        </label>
      </div>
    </details>
  );

  return (
    <div className="min-h-screen lg:flex">
      {/* Sidebar (desktop) */}
      <aside className="hidden bg-ink text-stone-300 lg:fixed lg:inset-y-0 lg:flex lg:w-64 lg:flex-col lg:px-4 lg:py-6">
        <div className="flex items-center gap-2.5 px-2">
          <Logo size={34} />
          <span className="text-lg font-semibold tracking-tight text-white">Reins</span>
        </div>
        <nav className="mt-8 space-y-1">
          {nav.map((n) => (
            <button key={n.id} onClick={() => go(n.id)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${page === n.id ? "bg-white/10 text-white" : "hover:bg-white/5 hover:text-white"}`}>
              <Icon name={n.icon} />
              <span className="flex-1 text-left">{n.label}</span>
              {n.badge !== undefined && (
                <span className={`rounded-full px-2 text-xs ${n.id === "overview" ? "bg-brand-500 text-white" : "bg-white/10"}`}>{n.badge}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-3">
          <div className="rounded-xl bg-white/5 px-3 py-2.5 text-xs">
            <p className="flex items-center gap-2 text-stone-200">
              <span className={`h-2 w-2 rounded-full ${safe?.active ? "bg-safe-600" : "bg-emerald-500"}`} />
              {safe?.active ? "Safe Mode on" : "All good"}
            </p>
            <p className="mt-1 text-stone-500">{modeLabel}</p>
          </div>
          {demo}
        </div>
      </aside>

      {/* Top bar + tabs (phone) */}
      <div className="sticky top-0 z-10 border-b border-stone-200 bg-[#faf8f6]/95 px-4 pt-4 backdrop-blur lg:hidden">
        <div className="flex items-center gap-2.5"><Logo size={30} /><span className="text-lg font-semibold">Reins</span></div>
        <nav className="-mx-1 mt-3 flex gap-1 overflow-x-auto pb-2">
          {nav.map((n) => (
            <button key={n.id} onClick={() => go(n.id)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-sm ${page === n.id ? "bg-ink text-white" : "text-stone-600"}`}>
              {n.label}{n.badge !== undefined && n.id === "overview" ? ` · ${n.badge}` : ""}
            </button>
          ))}
        </nav>
      </div>

      <main className="flex-1 lg:pl-64">
        <div className="mx-auto max-w-3xl px-4 py-6 lg:px-10 lg:py-10">
          <h1 className="mb-6 hidden text-2xl font-semibold tracking-tight lg:block">{nav.find((n) => n.id === page)?.label}</h1>
          {error && <ErrorBox error={error} onClose={() => setError(null)} />}
          {busy && <p className="mb-3 text-sm text-stone-500">{busy}</p>}

          {page === "overview" && (
            <div className="space-y-4">
              <section className={`rounded-2xl p-6 ${safe?.active ? "bg-safe-600 text-white" : "border border-stone-200 bg-white"}`}>
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
                <div className={`mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-sm ${safe?.active ? "border-white/20" : "border-stone-100"}`}>
                  {safe?.active ? (
                    <p><b>Safe Mode is on.</b> Bills in the next 2 weeks plus your floor need {usd(safe.needed)}. Lifestyle habits are paused; everything else asks first.</p>
                  ) : (
                    <p className="flex items-center gap-2 text-stone-600"><span className="h-2 w-2 rounded-full bg-emerald-500" />All good · {modeLabel}</p>
                  )}
                  <Button variant={safe?.active ? "light" : "secondary"} onClick={() => topUp(40)}>Top up pot $40</Button>
                </div>
              </section>

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

              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (request.trim()) run("Asking Reins…", onDemand); }}>
                <input className="min-w-0 flex-1 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand-500"
                  value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Ask Reins to pay for something…" />
                <Button type="submit" className="px-4" disabled={!!busy || !request.trim()}>Ask</Button>
              </form>

              <Card title="Recent activity" right={done.length > 5 && <button className="text-sm text-brand-600" onClick={() => go("activity")}>View all</button>}>
                <ActivityList entries={done.slice(0, 5)} />
              </Card>

              <div className="rounded-2xl bg-ink p-3 lg:hidden">{demo}</div>
            </div>
          )}

          {page === "habits" && (
            <Card title="Your habits" right={<span className="text-xs text-stone-500">Switch on what Reins may pay for</span>}>
              <ul className="divide-y divide-stone-100">
                {s.habits.map((h) => (
                  <li key={h.id} className="py-3">
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
              {s.statement && <p className="mt-2 text-xs text-stone-400">From {s.statement.transactions} transactions, {s.statement.from} to {s.statement.to}. Tap a habit for details.</p>}
            </Card>
          )}

          {page === "activity" && (
            <Card title={`All activity · ${done.length}`}><ActivityList entries={done} /></Card>
          )}

          {page === "settings" && (
            <div className="space-y-4">
              <Card title="How much should Reins ask?">
                <div className="mt-2 space-y-2">
                  {MODES.map((m) => (
                    <label key={m.id} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${s.mode === m.id ? "border-brand-500 bg-brand-50" : "border-stone-200"}`}>
                      <input type="radio" className="mt-1 accent-brand-500" checked={s.mode === m.id} onChange={() => update((p) => ({ ...p, mode: m.id }))} />
                      <span><span className="block text-sm font-medium">{m.label}</span><span className="text-xs text-stone-500">{m.hint}</span></span>
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-xs text-stone-500">Safe Mode overrides this whenever money runs low.</p>
              </Card>

              <Card title="Wallet (read-only)">
                <div className="mt-2 flex gap-2">
                  <input className="min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-1.5 text-sm" placeholder="0x… address" value={s.walletAddress}
                    onChange={(e) => update((p) => ({ ...p, walletAddress: e.target.value }))} />
                  <Button variant="secondary" disabled={!!busy || !s.walletAddress} onClick={() => run("Reading wallet…", readWallet)}>Connect</Button>
                </div>
                {s.walletRead && (
                  <p className="mt-2 text-xs text-stone-500">
                    Kite testnet: {s.walletRead.balance} {s.walletRead.symbol} ·{" "}
                    <a className="text-brand-600 underline" href={s.walletRead.explorer} target="_blank" rel="noreferrer">view</a>
                  </p>
                )}
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input type="checkbox" className="accent-brand-500" checked={s.useDemoBalance} onChange={(e) => update((p) => ({ ...p, useDemoBalance: e.target.checked }))} />
                  Use demo balance instead
                </label>
              </Card>

              <Card title="Safety floor">
                <label className="mt-2 flex items-center gap-2 text-sm">
                  $<input type="number" className="w-24 rounded-lg border border-stone-300 px-2 py-1" value={s.safetyFloor}
                    onChange={(e) => update((p) => ({ ...p, safetyFloor: Number(e.target.value) || 0 }))} />
                </label>
                <p className="mt-1 text-xs text-stone-500">Safe Mode switches on when your wallet can&apos;t cover the next 2 weeks of bills plus this amount.</p>
              </Card>

              <div className="space-y-2 px-1 text-xs text-stone-500">
                <p>SERV: {status?.serv.mode === "live" ? `live (${status.serv.model})` : "mock mode"} · Payments: {status?.payments ?? "…"}</p>
                <button className="text-red-600" onClick={() => { if (confirm("Start over with a new statement?")) { update(() => INITIAL); go("overview"); } }}>Start over</button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ---------------- Small UI pieces ----------------

type Page = "overview" | "habits" | "activity" | "settings";
type IconName = "home" | "habits" | "activity" | "settings";

function Icon({ name }: { name: IconName }) {
  const d = {
    home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
    habits: "M4 7h10M4 12h16M4 17h7M17 4.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM14 14.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z",
    activity: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
    settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  }[name];
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function ActivityList({ entries }: { entries: LogEntry[] }) {
  if (!entries.length) return <p className="py-2 text-sm text-stone-500">Nothing yet. Switch on a habit, or ask Reins to pay for something.</p>;
  return (
    <ul className="divide-y divide-stone-100">
      {entries.map((l) => (
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
  );
}

function ErrorBox({ error, onClose }: { error: string; onClose: () => void }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      {error}<button onClick={onClose} aria-label="Dismiss">✕</button>
    </div>
  );
}

function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <defs><clipPath id="reins-logo-clip"><rect width="100" height="100" rx="23" /></clipPath></defs>
      <rect width="100" height="100" rx="23" fill="#1C1917" />
      <g clipPath="url(#reins-logo-clip)">
        <path d="M51 11 C52 8 53 6 55 4 C56 9 56 13 55 18 L52 17 Z" fill="#C9530F" />
        <path d="M53 17 C59 15 65 17 69 21 C66 22 66 24 69 26 C74 29 77 34 79 39 C76 39 76 41 78 44 C81 49 83 55 84 62 L80 46 C76 32 66 22 53 18 Z" fill="#C9530F" />
        <path d="M46 6 C47 10 49 14 53 18 C64 20 76 30 81 46 C85 60 86 80 86 100 L52 100 C53 88 54 76 51 66 C49 61 47 58 45 56 C43 60 40 63 36 65 C32 67 28 70 24 72 C20 74 15 73 13 69 C11 65 12 61 14 58 C20 47 27 36 35 25 C38 20 41 15 43 12 C44 10 45 8 46 6 Z" fill="#F26B1D" />
        <path d="M58 22 C66 27 72 35 75 44 M62 21 C69 25 74 31 77 38" fill="none" stroke="#C9530F" strokeWidth="1.1" strokeLinecap="round" />
        <path d="M46 55 C43 49 38 47 34 51" fill="none" stroke="#C9530F" strokeWidth="1.3" strokeLinecap="round" />
        <ellipse cx="37.5" cy="30" rx="2.4" ry="1.5" transform="rotate(-35 37.5 30)" fill="#F5E6D8" />
        <path d="M19 55 C23 59 27 62 31 64 M31 64 L49 16 M44 14 L52 19" fill="none" stroke="#F5E6D8" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="25" cy="68" r="1.8" fill="none" stroke="#F5E6D8" strokeWidth="1.3" />
        <path d="M26 69 C45 88 74 85 104 66" fill="none" stroke="#F5E6D8" strokeWidth="2.2" strokeLinecap="round" />
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

function Button({ variant = "primary", className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "light" | "ghost" }) {
  const look = {
    primary: "bg-brand-500 text-white hover:bg-brand-600",
    secondary: "border border-stone-300 bg-white text-stone-800 hover:bg-stone-50",
    light: "bg-white text-safe-700 hover:bg-white/90",
    ghost: "border border-white/20 text-stone-200 hover:bg-white/10",
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
