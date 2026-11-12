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
  forceSafeMode: boolean;
};

const INITIAL: AppState = {
  habits: [], mode: "trust_ladder", today: "", walletAddress: "", useDemoBalance: true,
  demoBalance: 150, safetyFloor: 20, potBalance: 100, onDemandAutoLimit: 15, spent: {}, log: [], forceSafeMode: false,
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

  // Theme: follow the system by default, or a choice the user made in Settings
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    try { const t = localStorage.getItem("reins-theme"); if (t === "light" || t === "dark") setTheme(t); } catch { /* ignore */ }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const isDark = theme === "dark" || (theme === "system" && systemDark);
  useEffect(() => { document.documentElement.classList.toggle("dark", isDark); }, [isDark]);
  const chooseTheme = (t: "system" | "light" | "dark") => {
    setTheme(t);
    try { localStorage.setItem("reins-theme", t); } catch { /* ignore */ }
  };

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
    safetyFloor: st.safetyFloor, potBalance: st.potBalance, onDemandAutoLimit: st.onDemandAutoLimit, spent: st.spent, forceSafeMode: st.forceSafeMode,
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
  // Learn habits from a wallet's on-chain history, and keep reading its balance
  async function loadWallet(address: string) {
    const r = await post<{ habits: Habit[]; transactions: number; from: string; to: string; reviewedBy: "serv" | "rules" }>("/api/statement", { address });
    update((p) => ({ ...p, walletAddress: address, habits: r.habits, statement: r, today: addDays(r.to, 1), log: [], spent: {} }));
    try { await readWallet(); } catch { /* balance can be read later from Connect wallet */ }
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
  const [page, setPage] = useState<Page>("dashboard");
  const [notifOpen, setNotifOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [addressDraft, setAddressDraft] = useState("");
  const hasData = s.habits.length > 0;
  const go = (p: Page) => { setPage(p); setNotifOpen(false); window.scrollTo(0, 0); };
  const done = s.log.filter((l) => !(l.outcome === "waiting" && l.decision.action === "ask"));
  const latest = s.log[0];
  const approvable = waiting.filter((l) => l.request.amount <= s.potBalance);
  async function approveAll() {
    for (const l of approvable) {
      const current = ref.current.log.find((x) => x.id === l.id);
      if (current && l.request.amount <= ref.current.potBalance) await approve(current);
    }
  }
  async function connectWallet() {
    update((p) => ({ ...p, walletAddress: addressDraft.trim() }));
    await readWallet();
    setWalletOpen(false);
  }
  const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  const notifications: { id: string; text: string; tone: "brand" | "safe" | "muted"; to?: Page }[] = [
    ...(safe?.active ? [{ id: "safe", text: safe.auto ? "Safe Mode switched on: your wallet is running low." : "Safe Mode is on.", tone: "safe" as const }] : []),
    ...(waiting.length ? [{ id: "wait", text: `${waiting.length} payment${waiting.length > 1 ? "s" : ""} waiting for your approval.`, tone: "brand" as const, to: "approvals" as Page }] : []),
    ...ready.map((h) => ({ id: `ready-${h.id}`, text: `${h.name} is ready for autopilot.`, tone: "brand" as const, to: "approvals" as Page })),
    ...done.slice(0, 3).map((l) => ({ id: l.id, text: `${l.request.merchant}: ${usd(l.request.amount)} ${l.outcome}.`, tone: "muted" as const, to: "activity" as Page })),
  ];
  const alertCount = (safe?.active ? 1 : 0) + waiting.length + ready.length;

  const nav: { id: Page; label: string; icon: IconName; badge?: number }[] = [
    { id: "dashboard", label: "Dashboard", icon: "home" },
    { id: "approvals", label: "Approvals", icon: "check", badge: waiting.length || undefined },
    { id: "activity", label: "Activity", icon: "activity" },
    { id: "settings", label: "Settings", icon: "settings" },
  ];

  if (!hasData) {
    return (
      <Landing busy={busy} error={error}
        onCsv={(csv) => run("Reading your statement…", () => loadStatement(csv))}
        onWallet={(address) => run("Reading your wallet's payments…", () => loadWallet(address))} />
    );
  }

  return (
    <div className="min-h-screen lg:flex">
      {/* Sidebar */}
      <aside className="hidden bg-[#1c1917] text-[#d6d3d1] lg:fixed lg:inset-y-0 lg:flex lg:w-60 lg:flex-col lg:px-4 lg:py-6">
        <div className="flex items-center gap-3 px-2">
          <Logo size={36} />
          <span className="text-lg font-semibold text-white">Reins</span>
        </div>
        <nav className="mt-8 space-y-1">
          {nav.map((n) => (
            <button key={n.id} onClick={() => go(n.id)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${page === n.id ? "bg-white/10 text-white" : "hover:bg-white/5 hover:text-white"}`}>
              <Icon name={n.icon} />
              <span className="flex-1 text-left">{n.label}</span>
              {n.badge !== undefined && <span className="rounded-full bg-brand-500 px-2 text-xs text-white">{n.badge}</span>}
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-3 text-xs">
          <div className={`rounded-xl px-3 py-2.5 ${safe?.active ? "bg-safe-600 text-white" : "bg-white/5"}`}>
            <p className="flex items-center gap-2 font-medium text-white">
              <span className={`h-2 w-2 rounded-full ${safe?.active ? "bg-[#fff]" : "bg-emerald-400"}`} />
              {safe?.active ? "Safe Mode is on" : "All good"}
            </p>
            <p className={`mt-0.5 ${safe?.active ? "text-white/80" : "text-[#78716c]"}`}>{MODES.find((m) => m.id === s.mode)?.label}</p>
          </div>
          <div className="flex flex-wrap gap-1.5 px-1">
            <span className="rounded-full bg-white/10 px-2 py-0.5">SERV: {status?.serv.mode === "live" ? "live" : "mock"}</span>
            <span className="rounded-full bg-white/10 px-2 py-0.5">Payments: {status?.payments ?? "…"}</span>
          </div>
        </div>
      </aside>

      <div className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-5 sm:px-6 lg:ml-60 lg:px-8">
        {/* Header: menu (phone), welcome, notifications, connect wallet (desktop) */}
        <header className="relative mb-6 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <button onClick={() => setMenuOpen(true)} aria-label="Open menu" aria-expanded={menuOpen}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-stone-200 bg-white text-stone-700 hover:bg-stone-50 lg:hidden">
              <Icon name="menu" />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold tracking-tight">Welcome back</h1>
              <p className="truncate text-sm text-stone-500">Spend on autopilot. Keep the reins.</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button onClick={() => setNotifOpen((o) => !o)} aria-label={`Notifications (${alertCount})`} aria-expanded={notifOpen}
              className="relative grid h-10 w-10 place-items-center rounded-full border border-stone-200 bg-white text-stone-700 hover:bg-stone-50">
              <Icon name="bell" />
              {alertCount > 0 && <span className={`absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] font-semibold text-white ${safe?.active ? "bg-safe-600" : "bg-brand-500"}`}>{alertCount}</span>}
            </button>
            <div className="hidden lg:block">
            {s.walletRead && !s.useDemoBalance ? (
                <button onClick={() => { setAddressDraft(s.walletAddress); setWalletOpen(true); }}
                  className="flex items-center gap-2 rounded-full border border-stone-200 bg-white px-4 py-2 text-sm font-medium hover:bg-stone-50">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />{shortAddr(s.walletAddress)}
                </button>
              ) : (
                <button onClick={() => { setAddressDraft(s.walletAddress); setWalletOpen(true); }}
                  className="rounded-full bg-stone-900 px-4 py-2 text-sm font-semibold text-stone-50 hover:bg-stone-700">Connect wallet</button>
              )}
            </div>
          </div>

          {notifOpen && (
            <div className="absolute right-0 top-12 z-20 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-stone-200 bg-white p-2 shadow-lg">
              <p className="px-3 py-2 text-sm font-semibold">Notifications</p>
              {!notifications.length ? <p className="px-3 pb-3 text-sm text-stone-500">You&apos;re all caught up.</p> : (
                <ul>
                  {notifications.map((n) => (
                    <li key={n.id}>
                      <button disabled={!n.to} onClick={() => n.to && go(n.to)} className="flex w-full items-start gap-2.5 rounded-xl px-3 py-2 text-left text-sm hover:bg-stone-50 disabled:hover:bg-transparent">
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.tone === "safe" ? "bg-safe-600" : n.tone === "brand" ? "bg-brand-500" : "bg-stone-300"}`} />
                        <span className={n.tone === "muted" ? "text-stone-500" : ""}>{n.text}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </header>

        {/* Phone menu: the pages and Connect wallet, behind the hamburger */}
        {menuOpen && (
          <div className="fixed inset-0 z-30 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
            <div className="absolute inset-0 bg-black/40" onClick={() => setMenuOpen(false)} />
            <div className="relative flex h-full w-72 max-w-[85vw] flex-col bg-[#1c1917] px-4 py-5 text-[#d6d3d1] shadow-xl">
              <div className="flex items-center justify-between px-2">
                <div className="flex items-center gap-3"><Logo size={36} /><span className="text-lg font-semibold text-white">Reins</span></div>
                <button onClick={() => setMenuOpen(false)} aria-label="Close menu" className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10">✕</button>
              </div>
              <nav className="mt-8 space-y-1">
                {nav.map((n) => (
                  <button key={n.id} onClick={() => { go(n.id); setMenuOpen(false); }}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] transition ${page === n.id ? "bg-white/10 text-white" : "hover:bg-white/5 hover:text-white"}`}>
                    <Icon name={n.icon} />
                    <span className="flex-1 text-left">{n.label}</span>
                    {n.badge !== undefined && <span className="rounded-full bg-brand-500 px-2 text-xs text-white">{n.badge}</span>}
                  </button>
                ))}
              </nav>
              <div className="mt-6 px-1">
                {s.walletRead && !s.useDemoBalance ? (
                  <button onClick={() => { setMenuOpen(false); setAddressDraft(s.walletAddress); setWalletOpen(true); }}
                    className="flex w-full items-center justify-center gap-2 rounded-full border border-white/20 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/10">
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />{shortAddr(s.walletAddress)}
                  </button>
                ) : (
                  <button onClick={() => { setMenuOpen(false); setAddressDraft(s.walletAddress); setWalletOpen(true); }}
                    className="w-full rounded-full bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">Connect wallet</button>
                )}
              </div>
              <div className={`mt-auto rounded-xl px-3 py-2.5 text-xs ${safe?.active ? "bg-safe-600 text-white" : "bg-white/5"}`}>
                <p className="flex items-center gap-2 font-medium text-white">
                  <span className={`h-2 w-2 rounded-full ${safe?.active ? "bg-[#fff]" : "bg-emerald-400"}`} />
                  {safe?.active ? "Safe Mode is on" : "All good"}
                </p>
                <p className={`mt-0.5 ${safe?.active ? "text-white/80" : "text-[#78716c]"}`}>{MODES.find((m) => m.id === s.mode)?.label}</p>
              </div>
            </div>
          </div>
        )}


        {error && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

        {page === "dashboard" && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              {/* Main frame: Ask Reins */}
              <section className={`min-w-0 rounded-3xl p-6 text-white sm:p-7 ${safe?.active ? "bg-safe-600" : "bg-brand-500"}`}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Ask Reins</h2>
                    <p className="mt-1 text-sm text-white/85">Tell Reins what to pay for. It checks your limits and budget first.</p>
                  </div>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-full bg-white/15 py-1.5 pl-3 pr-1.5 text-sm font-medium">
                    Safe Mode
                    <Toggle on={!!safe?.active} label="Safe Mode" light
                      onClick={() => { if (!safe?.auto) update((p) => ({ ...p, forceSafeMode: !p.forceSafeMode })); }} />
                  </label>
                </div>

                <form className="mt-6 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (request.trim()) run("Asking Reins…", onDemand); }}>
                  <input className="min-w-0 flex-1 rounded-xl border-0 bg-[#fff] px-4 py-3 text-[#1c1917] outline-none placeholder:text-[#a8a29e] focus:ring-2 focus:ring-white/60"
                    value={request} onChange={(e) => setRequest(e.target.value)} placeholder="e.g. Order lunch under $15" aria-label="Ask Reins to pay for something" />
                  <button type="submit" disabled={!!busy || !request.trim()} className="rounded-xl bg-[#1c1917] px-5 font-semibold text-white hover:bg-[#292524] disabled:opacity-50">Ask</button>
                </form>
                <div className="mt-3 flex flex-wrap gap-2">
                  {["Order lunch under $15", "Get me a ride home", "Buy my usual coffee"].map((t) => (
                    <button key={t} onClick={() => setRequest(t)} className="rounded-full bg-white/15 px-3 py-1 text-xs hover:bg-white/25">{t}</button>
                  ))}
                </div>

                <div className="mt-5 min-h-10 border-t border-white/20 pt-4 text-sm">
                  {busy ? <p className="text-white/85">{busy}</p>
                    : safe?.active ? (
                      <p><b>Safe Mode is on.</b> {safe.auto ? `Your wallet can't cover the next 2 weeks of bills plus your floor (${usd(safe.needed)}).` : "You switched it on."} Lifestyle habits are paused and everything else asks first.</p>
                    ) : latest ? (
                      <p><b>Latest:</b> {latest.request.merchant}, {usd(latest.request.amount)}, {latest.outcome === "waiting" ? "waiting for your approval" : latest.outcome}.
                        {latest.outcome === "waiting" && <button className="ml-2 underline" onClick={() => go("approvals")}>Review</button>}</p>
                    ) : <p className="text-white/85">Reins is ready. Switch on your habits below.</p>}
                </div>
              </section>

              {/* Wallet frame */}
              <Card title="Wallet">
                <Stat label="Wallet balance" value={usd(walletBalance(s))} />
                <Stat label="Spending pot" value={usd(s.potBalance)} />
                {safe && (
                  <p className={`mt-3 text-xs ${safe.active ? "text-safe-700" : "text-stone-500"}`}>
                    {safe.auto ? "Below" : "Safe Mode switches on below"} {usd(safe.needed)}: bills due in 2 weeks ({usd(safe.upcoming.total)}) plus your {usd(s.safetyFloor)} floor.
                  </p>
                )}
                <Button className="mt-4 w-full" variant="secondary" onClick={() => topUp(40)}>Move $40 to spending pot</Button>
                <p className="mt-2 text-xs text-stone-500">{s.walletRead && !s.useDemoBalance ? `Reading ${shortAddr(s.walletAddress)} on Kite testnet.` : "Using the demo balance."}</p>
              </Card>
            </div>

            {/* Habit switchboard */}
            <Card title="Habit switchboard" right={s.statement && <span className="text-xs text-stone-500">{s.statement.transactions} transactions · {s.statement.from} to {s.statement.to} · reviewed by {s.statement.reviewedBy === "serv" ? "SERV" : "rules"}</span>}>
              <ul className="divide-y divide-stone-100">
                {s.habits.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-3 py-3">
                    <Toggle on={h.enabled} onClick={() => toggleHabit(h)} label={`Switch ${h.name}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {h.name} <span className="font-normal text-stone-500">· ~{usd(h.avgAmount)} {describeCadence(h.cadence, h.usualTime)}</span>
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
          </div>
        )}

        {page === "approvals" && (
          <div className="space-y-4">
            {ready.map((h) => (
              <div key={h.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-100 bg-brand-50 px-5 py-3">
                <p className="text-sm">You approved <b>{h.name}</b> {h.approvalsInARow} times in a row. Handle it automatically from now on?</p>
                <div className="flex gap-2">
                  <Button onClick={() => setHabit(h.id, { autopilot: true })}>Yes, autopilot</Button>
                  <Button variant="secondary" onClick={() => setHabit(h.id, { approvalsInARow: 0 })}>Not yet</Button>
                </div>
              </div>
            ))}
            <Card title={`Needs your approval (${waiting.length})`}
              right={approvable.length > 1 && <button className="text-sm font-medium text-brand-600 disabled:opacity-50" disabled={!!busy} onClick={() => run("Paying…", approveAll)}>Approve all</button>}>
              {!waiting.length ? <p className="text-sm text-stone-500">Nothing waiting. Reins will ask here when a payment needs your OK.</p> : (
                <ul className="divide-y divide-stone-100">
                  {waiting.map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{l.request.merchant} · {usd(l.request.amount)} <span className="font-normal text-stone-500">· {pretty(l.date)}</span></p>
                        <p className="text-xs text-stone-500">{l.request.amount > s.potBalance ? "Top up the spending pot first." : l.decision.reason}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button onClick={() => run("Paying…", () => approve(l))} disabled={!!busy || l.request.amount > s.potBalance}>Approve</Button>
                        <Button variant="secondary" onClick={() => decline(l)}>Decline</Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}

        {page === "activity" && (
          <Card title="Activity">
            {!done.length ? <p className="text-sm text-stone-500">Nothing yet. Ask Reins to pay for something, or move the demo clock forward in Settings.</p> : (
              <ul className="divide-y divide-stone-100">
                {done.map((l) => (
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
        )}

        {page === "settings" && (
          <div className="grid max-w-3xl gap-4">
            <Card title="Appearance">
              <div className="divide-y divide-stone-100">
                <label className="flex items-center justify-between gap-4 py-2.5">
                  <span><span className="block text-sm font-medium">Match system theme</span><span className="text-xs text-stone-500">Follow your phone or computer&apos;s light or dark setting.</span></span>
                  <Toggle on={theme === "system"} label="Match system theme" onClick={() => chooseTheme(theme === "system" ? (systemDark ? "dark" : "light") : "system")} />
                </label>
                <label className="flex items-center justify-between gap-4 py-2.5">
                  <span><span className="block text-sm font-medium">Dark mode</span><span className="text-xs text-stone-500">{theme === "system" ? "Set by your system right now. Switch it to choose yourself." : "Your choice, regardless of system setting."}</span></span>
                  <Toggle on={isDark} label="Dark mode" onClick={() => chooseTheme(isDark ? "light" : "dark")} />
                </label>
              </div>
            </Card>

            <Card title="Control mode">
              <div className="space-y-2">
                {MODES.map((m) => (
                  <label key={m.id} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${s.mode === m.id ? "border-brand-500 bg-brand-50" : "border-stone-200"}`}>
                    <input type="radio" className="mt-1 accent-brand-500" checked={s.mode === m.id} onChange={() => update((p) => ({ ...p, mode: m.id }))} />
                    <span><span className="block text-sm font-medium">{m.label}</span><span className="text-xs text-stone-500">{m.hint}</span></span>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-stone-500">Safe Mode overrides this whenever it&apos;s on.</p>
            </Card>

            <Card title="Habit limits">
              <ul className="divide-y divide-stone-100">
                {s.habits.filter((h) => h.enabled).map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <span>{h.name}</span>
                    <span className="flex items-center gap-2 text-xs text-stone-500">
                      limit $
                      <input type="number" className="w-16 rounded-lg border border-stone-300 px-2 py-1 text-right text-stone-900" value={h.capPerPurchase}
                        onChange={(e) => setHabit(h.id, { capPerPurchase: Number(e.target.value) || 0 })} aria-label={`${h.name} limit`} />
                      <span className="hidden sm:inline">({describeLimit(h)})</span>
                    </span>
                  </li>
                ))}
                {!s.habits.some((h) => h.enabled) && <li className="py-2 text-sm text-stone-500">Switch on a habit on the dashboard to set its limit.</li>}
              </ul>
            </Card>

            <Card title="Safety floor">
              <label className="flex items-center gap-2 text-sm">
                $<input type="number" className="w-24 rounded-lg border border-stone-300 px-2 py-1" value={s.safetyFloor}
                  onChange={(e) => update((p) => ({ ...p, safetyFloor: Number(e.target.value) || 0 }))} aria-label="Safety floor" />
              </label>
              <p className="mt-1 text-xs text-stone-500">Safe Mode switches on by itself when your wallet can&apos;t cover the next 2 weeks of bills plus this amount.</p>
            </Card>

            <Card title="Demo controls" right={<span className="text-xs text-stone-500">Simulated date: {pretty(s.today)}</span>}>
              <div className="flex flex-wrap gap-2">
                <Button disabled={!!busy} onClick={() => run("Running the day…", () => runDays(1))}>Fast-forward 1 day</Button>
                <Button variant="secondary" disabled={!!busy} onClick={() => run("Running the week…", () => runDays(7))}>Fast-forward 1 week</Button>
              </div>
              <label className="mt-4 flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-brand-500" checked={s.useDemoBalance} onChange={(e) => update((p) => ({ ...p, useDemoBalance: e.target.checked }))} />
                Use demo balance
              </label>
              {s.useDemoBalance && (
                <label className="mt-2 block text-sm text-stone-600">
                  Demo wallet balance: {usd(s.demoBalance)}
                  <input type="range" min={0} max={300} step={5} value={s.demoBalance} className="mt-1 w-full accent-brand-500"
                    onChange={(e) => update((p) => ({ ...p, demoBalance: Number(e.target.value) }))} />
                </label>
              )}
              {busy && <p className="mt-2 text-xs text-stone-500">{busy}</p>}
            </Card>

            <button className="justify-self-start px-1 text-sm text-red-600" onClick={() => { if (confirm("Start over with a new statement?")) { update(() => INITIAL); go("dashboard"); } }}>Start over</button>
          </div>
        )}
      </div>

      {walletOpen && (
        <div className="fixed inset-0 z-30 grid place-items-center bg-black/40 px-4" onClick={() => setWalletOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="Connect wallet" className="w-full max-w-md rounded-2xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">Connect wallet</h2>
            <p className="mt-1 text-sm text-stone-500">Paste your wallet address. Reins only reads the balance on Kite testnet. It never asks for your keys and can&apos;t move money from this wallet.</p>
            <input autoFocus className="mt-4 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm" placeholder="0x…" value={addressDraft} onChange={(e) => setAddressDraft(e.target.value)} />
            {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              {s.walletRead && !s.useDemoBalance && (
                <Button variant="secondary" onClick={() => { update((p) => ({ ...p, useDemoBalance: true })); setWalletOpen(false); }}>Disconnect</Button>
              )}
              <Button variant="secondary" onClick={() => setWalletOpen(false)}>Cancel</Button>
              <Button disabled={!!busy || !addressDraft.trim()} onClick={() => run("Reading wallet…", connectWallet)}>{busy === "Reading wallet…" ? "Connecting…" : "Connect"}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- Small UI pieces ----------------

type Page = "dashboard" | "approvals" | "activity" | "settings";


function Landing({ onCsv, onWallet, busy, error }: { onCsv: (csv: string) => void; onWallet: (address: string) => void; busy: string | null; error: string | null }) {
  const [address, setAddress] = useState("");
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#0c0a09] text-white">
      <HorseBackdrop />

      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col px-5 py-6 sm:px-8">
        <header className="flex items-center gap-3">
          <Logo size={40} />
          <span className="text-xl font-semibold">Reins</span>
        </header>

        <main className="flex w-full min-w-0 flex-1 flex-col justify-center py-12">
          <h1 className="max-w-2xl text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">Spend on autopilot. Keep the reins.</h1>
          <p className="mt-5 max-w-xl text-lg text-[#d6d3d1]">
            Reins learns your regular spending, pays for the habits you switch on within hard limits, and gets careful on its own when money runs low.
          </p>

          <div className="mt-10 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="min-w-0 rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
              <h2 className="font-semibold">Upload a bank statement</h2>
              <p className="mt-1 text-sm text-[#a8a29e]">A CSV from your bank. Reins finds what you pay for regularly, and when.</p>
              <label className="mt-4 inline-block cursor-pointer rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 focus-within:outline-2 focus-within:outline-white">
                Upload statement
                <input type="file" accept=".csv,text/csv" className="sr-only" disabled={!!busy}
                  onChange={async (e) => { const f = e.target.files?.[0]; if (f) onCsv(await f.text()); }} />
              </label>
            </div>

            <form className="min-w-0 rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur"
              onSubmit={(e) => { e.preventDefault(); if (address.trim()) onWallet(address.trim()); }}>
              <h2 className="font-semibold">Connect your wallet</h2>
              <p className="mt-1 text-sm text-[#a8a29e]">Reins reads your on-chain payments on Kite. Read-only: it can never move your money.</p>
              <div className="mt-4 flex gap-2">
                <input className="min-w-0 flex-1 rounded-xl border border-white/15 bg-black/30 px-3 py-2.5 text-sm text-white placeholder:text-[#78716c] outline-none focus:border-brand-500"
                  placeholder="0x… wallet address" value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Wallet address" />
                <button type="submit" disabled={!!busy || !address.trim()} className="rounded-xl bg-[#fff] px-4 text-sm font-semibold text-[#1c1917] hover:bg-[#e7e5e4] disabled:opacity-50">Connect</button>
              </div>
            </form>
          </div>

          <div className="mt-5 min-h-6 text-sm">
            {busy ? <p className="text-[#d6d3d1]">{busy}</p>
              : error ? <p className="max-w-3xl text-red-300">{error}</p>
              : (
                <button className="text-brand-500 underline underline-offset-4 hover:text-brand-100" disabled={!!busy}
                  onClick={async () => onCsv(await (await fetch("/sample_bank_statement.csv")).text())}>
                  No statement handy? Try the sample statement
                </button>
              )}
          </div>
        </main>

        <footer className="grid gap-6 border-t border-white/10 pt-6 text-sm text-[#a8a29e] sm:grid-cols-3">
          <p><span className="block font-medium text-white">Learns your habits</span>What you buy, how often, how much and at what time.</p>
          <p><span className="block font-medium text-white">Hard limits on Kite</span>Each habit you switch on gets its own spending limit.</p>
          <p><span className="block font-medium text-white">Safe Mode</span>When money runs low, Reins stops and asks before every payment.</p>
        </footer>
      </div>
    </div>
  );
}

// One large horse drawn in thin orange lines, slowly swaying, with the rein flowing
function HorseBackdrop() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden
      className="horse-sway pointer-events-none absolute right-[-30%] top-1/2 h-[min(82vh,760px)] w-auto -translate-y-1/2 opacity-25 sm:right-[2%] sm:opacity-70">
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M46 6 C47 10 49 14 53 18 C64 20 76 30 81 46 C85 60 86 80 86 100 L52 100 C53 88 54 76 51 66 C49 61 47 58 45 56 C43 60 40 63 36 65 C32 67 28 70 24 72 C20 74 15 73 13 69 C11 65 12 61 14 58 C20 47 27 36 35 25 C38 20 41 15 43 12 C44 10 45 8 46 6 Z"
          stroke="#F26B1D" strokeOpacity="0.55" strokeWidth="0.45" />
        <path d="M51 11 C52 8 53 6 55 4 C56 9 56 13 55 18" stroke="#F26B1D" strokeOpacity="0.35" strokeWidth="0.3" />
        <path d="M53 17 C59 15 65 17 69 21 C66 22 66 24 69 26 C74 29 77 34 79 39 C76 39 76 41 78 44 C81 49 83 55 84 62" stroke="#F26B1D" strokeOpacity="0.35" strokeWidth="0.3" />
        <path d="M58 22 C66 27 72 35 75 44 M62 21 C69 25 74 31 77 38 M46 55 C43 49 38 47 34 51" stroke="#F26B1D" strokeOpacity="0.25" strokeWidth="0.25" />
        <ellipse cx="37.5" cy="30" rx="1.4" ry="0.9" transform="rotate(-35 37.5 30)" fill="#F26B1D" fillOpacity="0.6" stroke="none" />
        <path d="M19 55 C23 59 27 62 31 64 M31 64 L49 16 M44 14 L52 19" stroke="#F5E6D8" strokeOpacity="0.35" strokeWidth="0.3" />
        <path className="rein-flow" d="M26 69 C45 88 74 85 120 62" stroke="#F26B1D" strokeOpacity="0.85" strokeWidth="0.6" />
      </g>
    </svg>
  );
}

function Card({ id, title, right, children }: { id?: string; title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
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

function Toggle({ on, onClick, label, light = false }: { on: boolean; onClick: () => void; label: string; light?: boolean }) {
  const track = light ? (on ? "bg-[#1c1917]" : "bg-white/35") : on ? "bg-brand-500" : "bg-stone-300";
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick}
      className={`relative h-6 w-11 shrink-0 rounded-full transition ${track}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-[#fff] shadow transition-all ${on ? "left-5" : "left-0.5"}`} />
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

type IconName = "home" | "check" | "habits" | "activity" | "settings" | "bell" | "menu";

function Icon({ name }: { name: IconName }) {
  const d = {
    home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
    check: "M9 12l2 2 4-4M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
    menu: "M4 7h16M4 12h16M4 17h16",
    bell: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0",
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

// The Reins horse: orange horse with a bridle and rein, on a dark tile
function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Reins logo" className="shrink-0">
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
