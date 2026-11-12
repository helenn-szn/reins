"use client";

import { useEffect, useRef, useState } from "react";
import type { Decision, EngineState, Habit, LogEntry, Mode, Payment, PurchaseRequest } from "@/lib/types";
import { describeCadence, describeLimit } from "@/lib/habits";
import { isDue, periodCap, periodKey, safeModeStatus, TRUST_LADDER_STEPS } from "@/lib/engine";
import { addDays, pretty } from "@/lib/dates";

type WalletRead = { symbol: string; balance: number; native: number; explorer: string };

type AppState = {
  habits: Habit[];
  statement?: { transactions: number; from: string; to: string; reviewedBy: "serv" | "rules"; usualWeek?: number[] };
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
    const r = await post<{ habits: Habit[]; transactions: number; from: string; to: string; reviewedBy: "serv" | "rules"; usualWeek: number[] }>("/api/statement", { csv });
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
  const categoryOf = (habitId?: string) => s.habits.find((h) => h.id === habitId)?.category ?? "other";

  if (!s.habits.length) {
    return (
      <div className="min-h-screen bg-night text-white">
        <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5 py-10">
          {error && <ErrorBox error={error} onClose={() => setError(null)} />}
          <Upload busy={busy} onCsv={(csv) => run("Reading your statement…", () => loadStatement(csv))} />
        </div>
      </div>
    );
  }

  // Next 7 days of switched-on habits, and what Reins will do with each
  const upcoming: { date: string; habit: Habit; plan: "auto" | "asks" | "paused" }[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(s.today, i);
    for (const h of s.habits) {
      if (!h.enabled || !isDue(h, date)) continue;
      const plan = safe?.active ? (h.kind === "lifestyle" ? "paused" : "asks")
        : s.mode === "full_autopilot" || (s.mode === "trust_ladder" && h.autopilot) ? "auto" : "asks";
      upcoming.push({ date, habit: h, plan });
    }
  }
  const enabled = s.habits.filter((h) => h.enabled);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const nav: { id: Page; label: string; icon: IconName; badge?: number }[] = [
    { id: "overview", label: "Overview", icon: "home", badge: waiting.length || undefined },
    { id: "habits", label: "Habits", icon: "habits", badge: enabled.length || undefined },
    { id: "activity", label: "Activity", icon: "activity" },
    { id: "settings", label: "Settings", icon: "settings" },
  ];

  const demo = (
    <details className="rounded-xl border border-white/10 px-3 py-2.5 text-sm text-white/70">
      <summary className="cursor-pointer">Demo clock: {pretty(s.today)}</summary>
      <div className="mt-3 space-y-3">
        <div className="flex gap-2">
          <Button className="flex-1" disabled={!!busy} onClick={() => run("Running the day…", () => runDays(1))}>+1 day</Button>
          <Button className="flex-1" variant="ghost" disabled={!!busy} onClick={() => run("Running the week…", () => runDays(7))}>+1 week</Button>
        </div>
        <label className="block text-xs">
          Demo wallet {usd(s.demoBalance)}
          <input type="range" min={0} max={300} step={5} value={s.demoBalance} className="mt-1 w-full accent-brand-500"
            onChange={(e) => update((p) => ({ ...p, useDemoBalance: true, demoBalance: Number(e.target.value) }))} />
        </label>
      </div>
    </details>
  );

  return (
    <div className="min-h-screen lg:flex">
      {/* Sidebar (desktop) */}
      <aside className="hidden bg-night text-white/75 lg:fixed lg:inset-y-0 lg:flex lg:w-64 lg:flex-col lg:px-4 lg:py-6">
        <div className="flex items-center gap-2 px-2">
          <Logo size={40} tile={false} />
          <span className="font-display text-2xl text-white">Reins</span>
        </div>
        <nav className="mt-10 space-y-1">
          {nav.map((n) => (
            <button key={n.id} onClick={() => go(n.id)}
              className={`relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] transition ${page === n.id ? "bg-night-2 text-white" : "hover:bg-white/5 hover:text-white"}`}>
              {page === n.id && <span className="absolute inset-y-2 left-0 w-1 rounded-r bg-accent" />}
              <Icon name={n.icon} />
              <span className="flex-1 text-left">{n.label}</span>
              {n.badge !== undefined && (
                <span className={`min-w-6 rounded-full px-1.5 text-center text-xs leading-5 ${n.id === "overview" ? "bg-brand-500 text-white" : "bg-white/10"}`}>{n.badge}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-3">
          <div className="rounded-xl bg-night-2 px-3 py-3 text-sm">
            <p className="flex items-center gap-2 text-white">
              <span className={`h-2 w-2 rounded-full ${safe?.active ? "bg-brand-500 ring-2 ring-white/40" : "bg-white"}`} />
              {safe?.active ? "Safe Mode is on" : "Reins is riding"}
            </p>
            <p className="mt-1 text-xs text-white/55">{modeLabel}</p>
          </div>
          {demo}
        </div>
      </aside>

      {/* Top bar + tabs (phone) */}
      <div className="sticky top-0 z-10 bg-night px-4 pt-4 text-white lg:hidden">
        <div className="flex items-center gap-2"><Logo size={32} tile={false} /><span className="font-display text-xl">Reins</span></div>
        <nav className="-mx-1 mt-3 flex gap-1 overflow-x-auto pb-3">
          {nav.map((n) => (
            <button key={n.id} onClick={() => go(n.id)}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm ${page === n.id ? "bg-brand-500 text-white" : "text-white/70"}`}>
              {n.label}{n.id === "overview" && n.badge ? ` (${n.badge})` : ""}
            </button>
          ))}
        </nav>
      </div>

      <main className="min-w-0 flex-1 lg:pl-64">
        <div className="mx-auto max-w-5xl px-4 py-6 lg:px-10 lg:py-9">
          {error && <ErrorBox error={error} onClose={() => setError(null)} />}

          {page === "overview" && (
            <div className="space-y-5">
              <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="text-sm text-ink/60">{pretty(s.today)}</p>
                  <h1 className="font-display text-3xl sm:text-4xl">{greeting}.</h1>
                </div>
                <form className="flex w-full gap-2 sm:w-96" onSubmit={(e) => { e.preventDefault(); if (request.trim()) run("Asking Reins…", onDemand); }}>
                  <input className="min-w-0 flex-1 rounded-full border border-ink/15 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand-500"
                    value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Ask Reins to pay for something" aria-label="Ask Reins to pay for something" />
                  <Button type="submit" className="rounded-full px-5" disabled={!!busy || !request.trim()}>Ask</Button>
                </form>
              </header>
              {busy && <p className="text-sm text-ink/60">{busy}</p>}

              {safe && <ReinMeter wallet={walletBalance(s)} needed={safe.needed} upcomingTotal={safe.upcoming.total} floor={s.safetyFloor}
                pot={s.potBalance} active={safe.active} onTopUp={() => topUp(40)} />}

              {waiting.length > 0 && (
                <Panel title={`Needs your OK (${waiting.length})`} tone="cognac"
                  action={approvable.length > 1 && <button className="text-sm font-semibold text-brand-700 disabled:opacity-50" disabled={!!busy} onClick={() => run("Paying…", approveAll)}>Approve all</button>}>
                  <ul className="divide-y divide-ink/10">
                    {waiting.slice(0, 3).map((l) => (
                      <li key={l.id} className="flex items-center gap-3 py-3">
                        <CategoryIcon category={categoryOf(l.request.habitId)} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{l.request.merchant}, {usd(l.request.amount)}</p>
                          <p className="text-xs text-ink/60">{l.request.amount > s.potBalance ? "Top up the pot first." : l.decision.reason}</p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <Button onClick={() => run("Paying…", () => approve(l))} disabled={!!busy || l.request.amount > s.potBalance}>Approve</Button>
                          <Button variant="secondary" onClick={() => decline(l)}>Decline</Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {waiting.length > 3 && <p className="pt-1 text-xs text-ink/60">{waiting.length - 3} more waiting</p>}
                </Panel>
              )}

              {ready.map((h) => (
                <div key={h.id} className="flex flex-wrap items-center gap-4 rounded-2xl border border-brand-500/40 bg-white px-5 py-4">
                  <CategoryIcon category={h.category} />
                  <p className="flex-1 text-sm">You approved <b>{h.name}</b> {h.approvalsInARow} times in a row. Let Reins handle it from now on?</p>
                  <div className="flex gap-2">
                    <Button onClick={() => setHabit(h.id, { autopilot: true })}>Hand it over</Button>
                    <Button variant="secondary" onClick={() => setHabit(h.id, { approvalsInARow: 0 })}>Not yet</Button>
                  </div>
                </div>
              ))}

              <div className="grid gap-5 lg:grid-cols-5">
                <Panel title="Coming up this week" className="lg:col-span-3">
                  {!upcoming.length ? (
                    <EmptyNote text="Nothing scheduled yet. Switch on a habit and it shows up here." action="Choose habits" onClick={() => go("habits")} />
                  ) : (
                    <ul className="divide-y divide-ink/10">
                      {upcoming.slice(0, 6).map((u) => (
                        <li key={`${u.habit.id}-${u.date}`} className="flex items-center gap-3 py-2.5">
                          <DateBadge date={u.date} />
                          <CategoryIcon category={u.habit.category} />
                          <p className="min-w-0 flex-1 truncate text-sm">{u.habit.name}</p>
                          <span className="text-sm font-medium">{usd(u.habit.avgAmount)}</span>
                          <PlanTag plan={u.plan} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {upcoming.length > 6 && <p className="pt-1 text-xs text-ink/60">{upcoming.length - 6} more this week</p>}
                </Panel>

                <Panel title="Your usual week" className="lg:col-span-2">
                  <UsualWeek values={s.statement?.usualWeek} today={s.today} />
                  <p className="mt-2 text-xs text-ink/55">Average everyday spending by day, from your last 3 months.</p>
                </Panel>
              </div>

              <div className="grid gap-5 lg:grid-cols-5">
                <Panel title="Limits this period" className="lg:col-span-2">
                  {!enabled.length ? (
                    <EmptyNote text="Each habit you switch on gets a hard limit. You'll see how close it is here." action="Choose habits" onClick={() => go("habits")} />
                  ) : (
                    <ul className="space-y-4 pt-1">
                      {enabled.slice(0, 5).map((h) => {
                        const spent = s.spent[`${h.id}:${periodKey(h, s.today)}`] ?? 0;
                        const cap = periodCap(h);
                        return (
                          <li key={h.id}>
                            <div className="flex items-baseline justify-between gap-2 text-sm">
                              <span className="font-medium">{h.name}</span>
                              <span className="text-ink/60">{usd(spent)} of ${cap}</span>
                            </div>
                            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-ink/10">
                              <div className="rein-fill h-full rounded-full bg-[#141414]" style={{ width: `${Math.min(100, (spent / cap) * 100)}%` }} />
                            </div>
                            <p className="mt-1 text-xs text-ink/55">
                              {h.autopilot || s.mode === "full_autopilot" ? "Paid automatically" : s.mode === "trust_ladder" ? <Ladder steps={h.approvalsInARow} /> : "Asks every time"}
                            </p>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </Panel>

                <Panel title="Recent activity" className="lg:col-span-3" action={done.length > 5 && <button className="text-sm font-semibold text-brand-700" onClick={() => go("activity")}>See all</button>}>
                  <ActivityList entries={done.slice(0, 5)} categoryOf={categoryOf} />
                </Panel>
              </div>

              <div className="rounded-2xl bg-night p-3 lg:hidden">{demo}</div>
            </div>
          )}

          {page === "habits" && (
            <div className="space-y-5">
              <header>
                <h1 className="font-display text-3xl">Your habits</h1>
                <p className="mt-1 text-sm text-ink/60">Found in {s.statement?.transactions ?? 0} transactions. Switch on only what Reins may pay for.</p>
              </header>
              <Panel>
                <ul className="divide-y divide-ink/10">
                  {s.habits.map((h) => (
                    <li key={h.id} className="py-3">
                      <div className="flex items-center gap-3">
                        <CategoryIcon category={h.category} />
                        <button className="min-w-0 flex-1 text-left" onClick={() => setOpenHabit(openHabit === h.id ? null : h.id)} aria-expanded={openHabit === h.id}>
                          <span className="block text-sm font-medium">{h.name}{h.note && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand-500 align-middle" />}</span>
                          <span className="block text-xs text-ink/60">{usd(h.avgAmount)}, {describeCadence(h.cadence)}</span>
                        </button>
                        {h.enabled && h.autopilot && <Chip tone="good">Auto</Chip>}
                        <Toggle on={h.enabled} onClick={() => toggleHabit(h)} label={`Switch ${h.name}`} />
                      </div>
                      {openHabit === h.id && (
                        <div className="ml-12 mt-3 space-y-2 rounded-xl bg-linen p-3 text-xs text-ink/70">
                          {h.note && <p className="text-brand-700">{h.note}</p>}
                          <p>Seen {h.count} times at {h.merchants.join(", ")}.</p>
                          <label className="flex items-center gap-2">
                            Hard limit $
                            <input type="number" className="w-16 rounded-lg border border-ink/20 bg-white px-2 py-1 text-right text-ink" value={h.capPerPurchase}
                              onChange={(e) => setHabit(h.id, { capPerPurchase: Number(e.target.value) || 0 })} />
                            <span>{describeLimit(h)}</span>
                          </label>
                          {h.enabled && !h.autopilot && s.mode === "trust_ladder" && <Ladder steps={h.approvalsInARow} />}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          )}

          {page === "activity" && (
            <div className="space-y-5">
              <h1 className="font-display text-3xl">Activity</h1>
              <Panel><ActivityList entries={done} categoryOf={categoryOf} /></Panel>
            </div>
          )}

          {page === "settings" && (
            <div className="max-w-2xl space-y-5">
              <h1 className="font-display text-3xl">Settings</h1>
              <Panel title="How much should Reins ask?">
                <div className="space-y-2">
                  {MODES.map((m) => (
                    <label key={m.id} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${s.mode === m.id ? "border-brand-500 bg-brand-50" : "border-ink/15"}`}>
                      <input type="radio" className="mt-1 accent-brand-500" checked={s.mode === m.id} onChange={() => update((p) => ({ ...p, mode: m.id }))} />
                      <span><span className="block text-sm font-medium">{m.label}</span><span className="text-xs text-ink/60">{m.hint}</span></span>
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-xs text-ink/60">Safe Mode overrides this whenever money runs low.</p>
              </Panel>

              <Panel title="Wallet (read-only)">
                <div className="flex gap-2">
                  <input className="min-w-0 flex-1 rounded-lg border border-ink/20 px-3 py-1.5 text-sm" placeholder="0x… address" value={s.walletAddress}
                    onChange={(e) => update((p) => ({ ...p, walletAddress: e.target.value }))} aria-label="Wallet address" />
                  <Button variant="secondary" disabled={!!busy || !s.walletAddress} onClick={() => run("Reading wallet…", readWallet)}>Connect</Button>
                </div>
                {s.walletRead && (
                  <p className="mt-2 text-xs text-ink/60">
                    Kite testnet: {s.walletRead.balance} {s.walletRead.symbol}.{" "}
                    <a className="text-brand-700 underline" href={s.walletRead.explorer} target="_blank" rel="noreferrer">View on KiteScan</a>
                  </p>
                )}
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input type="checkbox" className="accent-brand-500" checked={s.useDemoBalance} onChange={(e) => update((p) => ({ ...p, useDemoBalance: e.target.checked }))} />
                  Use the demo balance instead
                </label>
              </Panel>

              <Panel title="Safety floor">
                <label className="flex items-center gap-2 text-sm">
                  $<input type="number" className="w-24 rounded-lg border border-ink/20 px-2 py-1" value={s.safetyFloor}
                    onChange={(e) => update((p) => ({ ...p, safetyFloor: Number(e.target.value) || 0 }))} aria-label="Safety floor in dollars" />
                </label>
                <p className="mt-1 text-xs text-ink/60">Safe Mode switches on when your wallet can&apos;t cover the next 2 weeks of bills plus this amount.</p>
              </Panel>

              <div className="space-y-2 px-1 text-xs text-ink/60">
                <p>SERV: {status?.serv.mode === "live" ? `live (${status.serv.model})` : "mock mode"}. Payments: {status?.payments ?? "…"}.</p>
                <button className="font-medium text-red-700" onClick={() => { if (confirm("Start over with a new statement?")) { update(() => INITIAL); go("overview"); } }}>Start over</button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ---------------- Pieces ----------------

type Page = "overview" | "habits" | "activity" | "settings";
type IconName = "home" | "habits" | "activity" | "settings";

// The signature piece: a stitched leather strap. Cognac fill = your wallet. Brass buckle = where Safe Mode starts.
function ReinMeter({ wallet, needed, upcomingTotal, floor, pot, active, onTopUp }:
  { wallet: number; needed: number; upcomingTotal: number; floor: number; pot: number; active: boolean; onTopUp: () => void }) {
  const max = Math.max(wallet, needed * 2, 50) * 1.08;
  const fill = Math.min(100, (wallet / max) * 100);
  const buckle = Math.min(100, (needed / max) * 100);
  const slack = wallet - needed;
  const muted = active ? "text-black/70" : "text-white/65";
  const mood = active ? "Safe Mode is on" : slack < needed * 0.5 ? "Getting tight" : "Plenty of slack";
  return (
    <section className={`overflow-hidden rounded-3xl p-6 sm:p-8 ${active ? "bg-brand-500 text-black" : "bg-night text-white"}`}>
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className={`text-sm ${muted}`}>Your wallet</p>
          <p className="font-display text-5xl leading-tight sm:text-6xl">{usd(wallet)}</p>
          <p className={`mt-1 text-sm ${active ? "text-black/80" : "text-white/75"}`}>
            {active ? `${usd(-slack)} short of what the next 2 weeks need.` : `${usd(slack)} of slack before Safe Mode.`}
          </p>
        </div>
        <div className={`rounded-2xl px-4 py-3 ${active ? "bg-black/10" : "bg-white/10"}`}>
          <p className={`text-xs ${muted}`}>Spending pot (Kite Passport)</p>
          <p className="font-display text-2xl">{usd(pot)}</p>
          <button className={`mt-1 text-sm font-semibold underline-offset-2 hover:underline ${active ? "text-black underline" : "text-accent"}`} onClick={onTopUp}>Top up $40</button>
        </div>
      </div>

      <div className="mt-8">
        <div className="mb-2 flex justify-between text-sm">
          <span className="font-semibold">{mood}</span>
          <span className={muted}>Safe Mode below {usd(needed)}</span>
        </div>
        <div className="relative h-7" role="img" aria-label={`Wallet ${usd(wallet)}; Safe Mode starts below ${usd(needed)}`}>
          <div className={`absolute inset-0 rounded-full ${active ? "bg-black/15" : "bg-white/15"}`} />
          <div className={`rein-fill absolute inset-y-0 left-0 rounded-full ${active ? "bg-black" : "bg-brand-500"}`} style={{ width: `${fill}%` }} />
          <div className="absolute inset-x-3 top-1/2 -translate-y-1/2 border-t-2 border-dashed border-white/40" />
          <div className="absolute -inset-y-1.5 w-4 -translate-x-1/2 rounded-sm border-[3px] border-white bg-transparent" style={{ left: `${buckle}%` }}>
            <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 bg-white" />
          </div>
        </div>
        <p className={`mt-3 text-xs ${muted}`}>Bills due in the next 2 weeks {usd(upcomingTotal)}, plus your {usd(floor)} safety floor.</p>
      </div>
    </section>
  );
}

function UsualWeek({ values, today }: { values?: number[]; today: string }) {
  if (!values?.length) return <p className="text-sm text-ink/60">Upload a statement to see your usual week.</p>;
  const max = Math.max(...values, 1);
  const todayIdx = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <div className="flex h-44 items-end gap-2 pt-2" role="img" aria-label={`Usual daily spending: ${days.map((d, i) => `${d} ${usd(values[i])}`).join(", ")}`}>
      {values.map((v, i) => (
        <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
          <span className={`text-[11px] ${i === todayIdx ? "font-semibold text-brand-700" : "text-ink/50"}`}>${Math.round(v)}</span>
          <div className={`w-full rounded-t-md ${i === todayIdx ? "bg-brand-500" : "bg-[#dcdcdc]"}`} style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />
          <span className={`text-xs ${i === todayIdx ? "font-semibold text-ink" : "text-ink/55"}`}>{days[i].slice(0, 1)}</span>
        </div>
      ))}
    </div>
  );
}

function Ladder({ steps }: { steps: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {[0, 1, 2].map((i) => <span key={i} className={`h-2 w-2 rounded-full ${i < steps ? "bg-brand-500" : "bg-ink/15"}`} />)}
      <span>{steps} of 3 approvals to earn autopilot</span>
    </span>
  );
}

function PlanTag({ plan }: { plan: "auto" | "asks" | "paused" }) {
  const t = { auto: ["Auto", "bg-[#f0f0f0] text-[#141414]"], asks: ["Asks you", "bg-brand-50 text-brand-700"], paused: ["Paused", "bg-black text-white"] }[plan];
  return <span className={`w-20 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-medium ${t[1]}`}>{t[0]}</span>;
}

function DateBadge({ date }: { date: string }) {
  const d = new Date(`${date}T00:00:00Z`);
  return (
    <span className="w-10 shrink-0 text-center leading-tight">
      <span className="block text-[11px] text-ink/55">{d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })}</span>
      <span className="block font-display text-lg">{d.getUTCDate()}</span>
    </span>
  );
}

function EmptyNote({ text, action, onClick }: { text: string; action: string; onClick: () => void }) {
  return (
    <div className="py-4">
      <p className="text-sm text-ink/60">{text}</p>
      <button className="mt-2 text-sm font-semibold text-brand-700" onClick={onClick}>{action}</button>
    </div>
  );
}

const CATEGORY_ICONS: Record<string, { d: string; bg: string }> = {
  coffee: { d: "M5 9h11v4a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM16 10h1.5a2.5 2.5 0 0 1 0 5H16M9 4v2M12.5 4v2", bg: "bg-[#f0f0f0] text-[#141414]" },
  nightlife: { d: "M6 4h12l-6 8zM12 12v7M8.5 20h7", bg: "bg-[#f0f0f0] text-[#141414]" },
  rides: { d: "M5 16v-4l2-5h10l2 5v4M4 16h16M7.5 19v-3M16.5 19v-3M8 12.5h.01M16 12.5h.01", bg: "bg-[#f0f0f0] text-[#141414]" },
  food: { d: "M3.5 11h17a8.5 8.5 0 0 1-17 0zM9 7.5c0-1 .8-2 1.8-2M13.5 7.5c0-1 .8-2 1.8-2", bg: "bg-[#f0f0f0] text-[#141414]" },
  groceries: { d: "M5 9h14l-1.2 11H6.2zM9 9V7a3 3 0 0 1 6 0v2", bg: "bg-[#f0f0f0] text-[#141414]" },
  subscriptions: { d: "M20 12a8 8 0 1 1-2.4-5.7M20 4.5V9h-4.5M10.5 9.5v5l4-2.5z", bg: "bg-[#f0f0f0] text-[#141414]" },
  phone: { d: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2", bg: "bg-[#f0f0f0] text-[#141414]" },
  rent: { d: "M3.5 11 12 4l8.5 7M5.5 9.5V20h13V9.5M10 20v-5h4v5", bg: "bg-[#f0f0f0] text-[#141414]" },
  other: { d: "M4 12V4h8l8 8-8 8zM8 8h.01", bg: "bg-[#f0f0f0] text-[#141414]" },
};

function CategoryIcon({ category }: { category: string }) {
  const c = CATEGORY_ICONS[category] ?? CATEGORY_ICONS.other;
  return (
    <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${c.bg}`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={c.d} /></svg>
    </span>
  );
}

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

function ActivityList({ entries, categoryOf }: { entries: LogEntry[]; categoryOf: (habitId?: string) => string }) {
  if (!entries.length) return <p className="py-4 text-sm text-ink/60">Nothing paid yet. Approve a payment or move the demo clock forward.</p>;
  return (
    <ul className="divide-y divide-ink/10">
      {entries.map((l) => (
        <li key={l.id} className="flex items-center gap-3 py-2.5" title={l.decision.reason}>
          <CategoryIcon category={categoryOf(l.request.habitId)} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{l.request.merchant}</p>
            <p className="truncate text-xs text-ink/55">{l.outcome === "paid" ? pretty(l.date) : l.decision.reason}</p>
          </div>
          <span className="text-sm font-medium">{usd(l.request.amount)}</span>
          <Outcome outcome={l.outcome} />
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

function Logo({ size = 36, tile = true }: { size?: number; tile?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <defs><clipPath id="reins-logo-clip"><rect width="100" height="100" rx="23" /></clipPath></defs>
      {tile && <rect width="100" height="100" rx="23" fill="#141414" />}
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
    <div className="text-center">
      <div className="flex justify-center"><Logo size={96} tile={false} /></div>
      <h1 className="mt-6 font-display text-4xl sm:text-5xl">Spend on autopilot.<br />Keep the reins.</h1>
      <p className="mx-auto mt-4 max-w-md text-white/70">Upload a bank statement. Reins finds your regular spending, and nothing runs until you switch it on.</p>
      <div className="mt-8 flex flex-col items-center gap-3">
        <label className="cursor-pointer rounded-full bg-brand-500 px-6 py-3 font-semibold text-white hover:bg-brand-600 focus-within:outline-2 focus-within:outline-white">
          Upload statement (CSV)
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={async (e) => { const f = e.target.files?.[0]; if (f) onCsv(await f.text()); }} />
        </label>
        <button className="text-sm text-accent underline underline-offset-4" disabled={!!busy}
          onClick={async () => onCsv(await (await fetch("/sample_bank_statement.csv")).text())}>
          Try it with a sample statement
        </button>
        {busy && <p className="text-sm text-white/70">{busy}</p>}
      </div>
    </div>
  );
}

function Panel({ title, action, tone, className = "", children }: { title?: string; action?: React.ReactNode; tone?: "cognac"; className?: string; children: React.ReactNode }) {
  return (
    <section className={`rounded-2xl bg-white px-5 py-4 ${tone === "cognac" ? "border-l-4 border-brand-500" : ""} ${className}`}>
      {(title || action) && (
        <div className="mb-2 flex items-baseline justify-between gap-2">
          {title && <h2 className="font-display text-lg">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function Button({ variant = "primary", className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  const look = {
    primary: "bg-brand-500 text-white hover:bg-brand-600",
    secondary: "border border-ink/20 bg-white text-ink hover:bg-linen",
    ghost: "border border-white/25 text-white hover:bg-white/10",
  }[variant];
  return <button {...props} className={`rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-50 ${look} ${className}`} />;
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={onClick}
      className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-brand-500" : "bg-ink/20"}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-5" : "left-0.5"}`} />
    </button>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone: "good" | "muted" | "warn" | "bad" }) {
  const t = { good: "bg-[#f0f0f0] text-[#141414]", muted: "bg-ink/5 text-ink/60", warn: "bg-brand-50 text-brand-700", bad: "bg-red-50 text-red-700" }[tone];
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${t}`}>{children}</span>;
}

function Outcome({ outcome }: { outcome: LogEntry["outcome"] }) {
  const map = { paid: ["Paid", "good"], waiting: ["Waiting", "warn"], blocked: ["Blocked", "bad"], declined: ["Declined", "muted"], failed: ["Failed", "bad"] } as const;
  const [label, tone] = map[outcome];
  return <Chip tone={tone}>{label}</Chip>;
}
