"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Decision, EngineState, Habit, LogEntry, Mode, Payment, PurchaseRequest } from "@/lib/types";
import { describeCadence, describeLimit } from "@/lib/habits";
import { isDue, periodKey, safeModeStatus, TRUST_LADDER_STEPS } from "@/lib/engine";
import { addDays, daysBetween, pretty } from "@/lib/dates";
import { SHOPS } from "@/lib/shopsInfo";
import QRCode from "qrcode";

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
  passportDemo?: PassportAllowance;
};

// Demo of Kite Agent Passport's allowance: an amount per week, two weeks or month, approved once
// with a passkey, that every agent payment must fit inside. Simulated so it runs anywhere with no
// real USDC; the real thing runs through kpass (PAYMENTS_MODE=passport, see src/lib/passport.ts).
type PassportAllowance = { amount: number; period: "week" | "2weeks" | "month"; start: string; spent: Record<string, number>; on: boolean };
const PERIOD_DAYS = { week: 7, "2weeks": 14, month: 30 } as const;
const PERIOD_LABEL = { week: "per week", "2weeks": "every 2 weeks", month: "per month" } as const;
function allowanceWindow(a: PassportAllowance, today: string) {
  const n = Math.max(0, Math.floor(daysBetween(a.start, today) / PERIOD_DAYS[a.period]));
  const from = addDays(a.start, n * PERIOD_DAYS[a.period]);
  return { key: from, resets: addDays(from, PERIOD_DAYS[a.period]) };
}
function allowanceLeft(a: PassportAllowance, today: string) {
  return Math.max(0, Math.round((a.amount - (a.spent[allowanceWindow(a, today).key] ?? 0)) * 100) / 100);
}
function allowanceRefusal(a: PassportAllowance | undefined, today: string, amount: number): string | null {
  if (!a?.on) return null;
  const left = allowanceLeft(a, today);
  return amount > left ? `Kite Passport refused it: ${usd(amount)} is more than the ${usd(left)} left of your ${usd(a.amount)} allowance ${PERIOD_LABEL[a.period]}.` : null;
}

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
  const [status, setStatus] = useState<{ serv: { mode: string; model?: string }; payments: string; agent?: string | null; shopPayTo?: string; payScale?: number; token?: string; tokenDecimals?: number } | null>(null);
  const [fundOpen, setFundOpen] = useState(false);
  const [agentWallet, setAgentWallet] = useState<{ balance: number; symbol: string; gas: number } | null>(null);
  const [shopWallet, setShopWallet] = useState<{ balance: number; symbol: string } | null>(null);
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
      if (saved) {
        const st: AppState = { ...INITIAL, ...JSON.parse(saved) };
        st.safetyFloor = Math.max(0, st.safetyFloor);
        st.habits = st.habits.map((h) => ({ ...h, capPerPurchase: Math.max(0, h.capPerPurchase) }));
        // A payment cut off by a reload never got its answer: show it as needing a check, not as waiting
        st.log = st.log.map((l) => (l.outcome === "paying" || (l.outcome === "waiting" && l.decision.action !== "ask"))
          ? { ...l, outcome: "failed", decision: { ...l.decision, reason: "The page closed while this was paying. Check the agent wallet on KiteScan before trying again." } } : l);
        ref.current = st; setS(st);
      }
    } catch { /* ignore */ }
    fetch("/api/status").then((r) => r.json()).then(setStatus).catch(() => {});
  }, []);

  // In live Kite mode, show what's in the Reins agent wallet (the spending pot on-chain)
  const readAgentWallet = useCallback(async () => {
    if (status?.payments !== "kite" || !status.agent) return;
    try {
      const r = await fetch(`/api/wallet?address=${status.agent}`).then((x) => x.json());
      if (r.token) {
        setAgentWallet({ balance: r.token.balance, symbol: r.token.symbol, gas: r.native.balance });
        // Live mode: the spending pot IS the agent wallet on Kite (in dollars, using the testnet scale)
        const pot = Math.round((r.token.balance / (status.payScale || 1)) * 100) / 100;
        update((p) => (p.potBalance === pot ? p : { ...p, potBalance: pot }));
      }
      if (status.shopPayTo) {
        const sh = await fetch(`/api/wallet?address=${status.shopPayTo}`).then((x) => x.json());
        if (sh.token) setShopWallet({ balance: sh.token.balance, symbol: sh.token.symbol });
      }
    } catch { /* shown as unknown */ }
  }, [status]);
  useEffect(() => { readAgentWallet(); }, [readAgentWallet]);

  // A connected wallet's tokens use the same testnet scale as payments (1 USDT = $100 at 1/100)
  const liveScale = status?.payments === "kite" ? status.payScale || 1 : 1;
  const walletBalance = (st: AppState) => (st.useDemoBalance || !st.walletRead ? st.demoBalance : Math.round((st.walletRead.balance / liveScale) * 100) / 100);
  const engineState = (st: AppState): EngineState => ({
    today: st.today, mode: st.mode, habits: st.habits, walletBalance: walletBalance(st),
    passportLimits: status?.payments === "passport" || !!st.passportDemo?.on,
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
    if (ref.current.walletAddress) { try { await readWallet(); } catch { /* keep the demo balance */ } }
  }
  // Learn habits from a wallet's on-chain history, and keep reading its balance
  async function loadWallet(address: string) {
    const r = await post<{ habits: Habit[]; transactions: number; from: string; to: string; reviewedBy: "serv" | "rules" }>("/api/statement", { address });
    if (!r.habits.length) {
      // Keep the address so the balance can still be shown once a statement is loaded
      update((p) => ({ ...p, walletAddress: address }));
      throw new Error(r.transactions
        ? `Found ${r.transactions} payment${r.transactions === 1 ? "" : "s"} in this wallet, not enough to spot habits yet. Reins needs a few weeks of regular payments. Try the sample statement, or upload a bank statement.`
        : "No payments found in this wallet on Kite testnet yet. Try the sample statement, or upload a bank statement.");
    }
    update((p) => ({ ...p, walletAddress: address, habits: r.habits, statement: r, today: addDays(r.to, 1), log: [], spent: {} }));
    try { await readWallet(); } catch { /* balance can be read later from Connect wallet */ }
  }

  // ---- Payments and decisions ----
  async function pay(entry: LogEntry) {
    try {
      const habit = ref.current.habits.find((x) => x.id === entry.request.habitId);
      const payment = await post<Payment>("/api/pay", {
        merchant: entry.request.merchant, amount: entry.request.amount, date: entry.request.date,
        category: habit?.category, memo: entry.request.description || habit?.name,
      });
      readAgentWallet();
      update((p) => {
        const h = p.habits.find((x) => x.id === entry.request.habitId);
        const key = h ? `${h.id}:${periodKey(h, entry.request.date)}` : null;
        return {
          ...p,
          potBalance: Math.round((p.potBalance - entry.request.amount) * 100) / 100,
          spent: key ? { ...p.spent, [key]: (p.spent[key] ?? 0) + entry.request.amount } : p.spent,
          passportDemo: p.passportDemo?.on ? (() => {
            const k = allowanceWindow(p.passportDemo!, entry.request.date).key;
            return { ...p.passportDemo!, spent: { ...p.passportDemo!.spent, [k]: Math.round(((p.passportDemo!.spent[k] ?? 0) + entry.request.amount) * 100) / 100 } };
          })() : p.passportDemo,
          log: p.log.map((l) => (l.id === entry.id ? { ...l, outcome: "paid", payment } : l)),
        };
      });
    } catch (e) {
      update((p) => ({ ...p, log: p.log.map((l) => (l.id === entry.id ? { ...l, outcome: "failed", decision: { ...l.decision, reason: String(e) } } : l)) }));
    }
  }

  async function processRequest(req: PurchaseRequest) {
    let decision = await post<Decision>("/api/decide", { request: req, state: engineState(ref.current) });
    const refused = decision.action !== "block" ? allowanceRefusal(ref.current.passportDemo, req.date, req.amount) : null;
    if (refused) decision = { ...decision, action: "block", reason: refused, source: "rules" };
    const entry: LogEntry = {
      id: uid(), date: req.date, request: req, decision,
      outcome: decision.action === "allow" ? "paying" : decision.action === "ask" ? "waiting" : "blocked",
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
    if (entry.request.amount > ref.current.potBalance) { setError("Not enough in your Kite Passport. Add funds first."); return; }
    const refused = allowanceRefusal(ref.current.passportDemo, entry.request.date, entry.request.amount);
    if (refused) { setError(refused); return; }
    update((p) => ({ ...p, log: p.log.map((l) => (l.id === entry.id ? { ...l, outcome: "paying" } : l)) }));
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
  async function connectWallet(address = addressDraft) {
    update((p) => ({ ...p, walletAddress: address.trim() }));
    await readWallet();
    setWalletOpen(false);
  }
  async function connectBrowserWallet() {
    const address = await browserWalletAddress();
    setAddressDraft(address);
    await connectWallet(address);
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
    { id: "shops", label: "Shops", icon: "store" },
    { id: "settings", label: "Settings", icon: "settings" },
  ];

  if (!hasData) {
    return (
      <Landing busy={busy} error={error}
        onCsv={(csv) => run("Reading your statement…", () => loadStatement(csv))}
        onBrowserWallet={() => run("Waiting for MetaMask…", async () => loadWallet(await browserWalletAddress()))}
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
                      <p><b>Latest:</b> {latest.request.merchant}, {usd(latest.request.amount)}, {latest.outcome === "waiting" ? "waiting for your approval" : latest.outcome === "paying" ? "paying…" : latest.outcome}.
                        {latest.outcome === "waiting" && <button className="ml-2 underline" onClick={() => go("approvals")}>Review</button>}
                        {(latest.outcome === "paid" || latest.outcome === "failed") && <button className="ml-2 underline" onClick={() => go("activity")}>View</button>}</p>
                    ) : <p className="text-white/85">Reins is ready. Switch on your habits below.</p>}
                </div>
              </section>

              {/* Wallet frame */}
              <Card title="Wallet">
                {/* Your own wallet: Reins only watches it, for Safe Mode */}
                <Stat label="Your wallet" value={usd(walletBalance(s))} />
                <p className="text-xs text-stone-500">{s.walletRead && !s.useDemoBalance ? `Reading ${shortAddr(s.walletAddress)} on Kite testnet, read-only.` : "Demo balance."} Reins never spends from it.</p>
                {safe && (
                  <p className={`mt-2 text-xs ${safe.active ? "text-safe-700" : "text-stone-500"}`}>
                    {safe.auto ? "Below" : "Safe Mode switches on below"} {usd(safe.needed)}: bills due in 2 weeks ({usd(safe.upcoming.total)}) plus your {usd(s.safetyFloor)} floor.
                  </p>
                )}

                {/* Kite Passport: the money Reins spends, and the allowance Kite holds it to */}
                <div className="mt-4 rounded-xl border border-stone-200 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Kite Passport</span>
                    {status?.payments !== "passport" && <Chip tone="muted">demo</Chip>}
                  </div>
                  {(() => {
                    // One number: what Reins can spend now = the lower of the money in the Passport and the allowance left
                    const allowance = status?.payments !== "passport" && s.passportDemo?.on ? allowanceLeft(s.passportDemo, s.today) : null;
                    const canSpend = allowance === null ? s.potBalance : Math.min(s.potBalance, allowance);
                    const limitedBy = allowance === null ? null : s.potBalance < allowance ? "balance" : "allowance";
                    return (<>
                      <Stat label="Reins can spend" value={usd(canSpend)} />
                      {allowance !== null && s.passportDemo && (
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-stone-100">
                          <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.min(100, (canSpend / s.passportDemo.amount) * 100)}%` }} />
                        </div>
                      )}
                      <p className="mt-1.5 text-xs text-stone-500">
                        {status?.payments === "passport" ? <>Balance {usd(s.potBalance)} · allowance set in your Passport dashboard.</>
                          : allowance !== null && s.passportDemo ? <>
                            Balance {usd(s.potBalance)} · allowance {usd(allowance)} of {usd(s.passportDemo.amount)} left, resets {pretty(allowanceWindow(s.passportDemo, s.today).resets)}.
                            {limitedBy === "balance" && <span className="text-brand-700"> Add funds to use your full allowance.</span>}
                          </> : <>Balance {usd(s.potBalance)}. No allowance yet: set one so Kite holds every payment to it.</>}
                      </p>
                    </>);
                  })()}
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {status?.payments === "passport" ? (<>
                      <a className="rounded-xl border border-stone-300 px-3 py-2 text-center text-sm font-medium hover:bg-stone-50" href="https://agentpassport.ai/overview" target="_blank" rel="noreferrer">Add funds</a>
                      <a className="rounded-xl border border-stone-300 px-3 py-2 text-center text-sm font-medium hover:bg-stone-50" href="https://agentpassport.ai/overview" target="_blank" rel="noreferrer">Set allowance</a>
                    </>) : (<>
                      <Button variant="secondary" onClick={() => (status?.payments === "kite" && status.agent ? setFundOpen(true) : topUp(40))}>Add funds</Button>
                      <Button variant="secondary" onClick={() => go("settings")}>{s.passportDemo?.on ? "Change allowance" : "Set allowance"}</Button>
                    </>)}
                  </div>
                  {status?.payments === "kite" && status.agent && (
                    <p className="mt-2 text-xs text-stone-500">
                      Pays on Kite testnet from{" "}
                      <a className="underline" href={`https://testnet.kitescan.ai/address/${status.agent}`} target="_blank" rel="noreferrer">{shortAddr(status.agent)}</a>
                      {agentWallet ? ` (${agentWallet.balance.toFixed(2)} ${agentWallet.symbol})` : ""}.
                      {status.payScale && status.payScale !== 1 ? ` Test payments are 1/${Math.round(1 / status.payScale)} of the price.` : ""}
                    </p>
                  )}
                </div>
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
                        {status?.payments === "passport" || s.passportDemo?.on ? <span className="text-xs text-stone-500">limit set by Kite Passport</span> : (<>
                        <span className="text-stone-500">limit $</span>
                        <input type="number" min={0} className="w-16 rounded-lg border border-stone-300 px-2 py-1 text-right" value={h.capPerPurchase}
                          onChange={(e) => setHabit(h.id, { capPerPurchase: Math.max(0, Number(e.target.value) || 0) })} />
                        <span className="hidden text-stone-400 sm:inline">({describeLimit(h)})</span></>)}
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
                        <p className="text-xs text-stone-500">{l.request.amount > s.potBalance ? "Add funds to your Kite Passport first." : l.decision.reason}</p>
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
                    {l.payment?.provider === "passport" && !l.payment.explorerUrl ? (
                      <p className="mt-0.5 text-[11px] text-stone-500">Paid {l.payment.shop} {l.payment.onchain} through Kite Passport</p>
                    ) : l.payment?.explorerUrl ? (
                      <p className="mt-0.5 text-[11px] text-stone-500">Paid {l.payment.shop} {l.payment.onchain} {l.payment.provider === "passport" ? "through Kite Passport" : "on Kite"} ·{" "}
                        <a className="font-mono underline" href={l.payment.explorerUrl} target="_blank" rel="noreferrer">{l.payment.txHash?.slice(0, 12)}…</a></p>
                    ) : l.payment?.txHash && <p className="mt-0.5 font-mono text-[11px] text-stone-400">demo payment {l.payment.txHash.slice(0, 12)}…</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {page === "shops" && (
          <ShopsPage
            orders={s.log.filter((l) => l.outcome === "paid" && (l.payment?.provider === "kite" || l.payment?.provider === "passport") && l.payment.shop)}
            live={status?.payments === "kite" || status?.payments === "passport"} shopPayTo={status?.shopPayTo} shopWallet={shopWallet} payScale={status?.payScale}
            onRefresh={readAgentWallet} onTry={() => { setRequest("Buy my usual coffee"); go("dashboard"); }} />
        )}

        {page === "settings" && (
          <div className="grid max-w-3xl gap-4">
            {status?.payments !== "passport" && (
              <PassportDemoCard allowance={s.passportDemo} today={s.today} onChange={(passportDemo) => update((p) => ({ ...p, passportDemo }))} />
            )}
            {status?.payments === "passport" && <PassportCard live={status?.payments === "passport"} payScale={status?.payScale}
              onBalance={(usdc) => update((p) => { const pot = Math.round((usdc / (status?.payScale || 1)) * 100) / 100; return p.potBalance === pot ? p : { ...p, potBalance: pot }; })} />}

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
                    {status?.payments === "passport" || s.passportDemo?.on ? <span className="text-xs text-stone-500">set by Kite Passport</span> : <span className="flex items-center gap-2 text-xs text-stone-500">
                      limit $
                      <input type="number" min={0} className="w-16 rounded-lg border border-stone-300 px-2 py-1 text-right text-stone-900" value={h.capPerPurchase}
                        onChange={(e) => setHabit(h.id, { capPerPurchase: Math.max(0, Number(e.target.value) || 0) })} aria-label={`${h.name} limit`} />
                      <span className="hidden sm:inline">({describeLimit(h)})</span>
                    </span>}
                  </li>
                ))}
                {!s.habits.some((h) => h.enabled) && <li className="py-2 text-sm text-stone-500">Switch on a habit on the dashboard to set its limit.</li>}
              </ul>
            </Card>

            <Card title="Safety floor">
              <label className="flex items-center gap-2 text-sm">
                $<input type="number" min={0} className="w-24 rounded-lg border border-stone-300 px-2 py-1" value={s.safetyFloor}
                  onChange={(e) => update((p) => ({ ...p, safetyFloor: Math.max(0, Number(e.target.value) || 0) }))} aria-label="Safety floor" />
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

      {fundOpen && status?.agent && (
        <AddMoneyDialog address={status.agent} payScale={status.payScale || 1} onClose={() => setFundOpen(false)} onReceived={readAgentWallet} />
      )}

      {walletOpen && (
        <div className="fixed inset-0 z-30 grid place-items-center bg-black/40 px-4" onClick={() => setWalletOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="Connect wallet" className="w-full max-w-md rounded-2xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">Connect wallet</h2>
            <p className="mt-1 text-sm text-stone-500">Reins only reads your balance on Kite testnet. It never asks for your keys and can&apos;t move money from this wallet.</p>
            <Button className="mt-4 w-full" disabled={!!busy} onClick={() => run("Waiting for MetaMask…", connectBrowserWallet)}>
              {busy === "Waiting for MetaMask…" ? "Check MetaMask…" : "Connect with MetaMask"}
            </Button>
            <p className="mt-4 text-xs text-stone-500">Or paste an address</p>
            <input className="mt-1 w-full rounded-lg border border-stone-300 bg-transparent px-3 py-2 text-sm" placeholder="0x…" value={addressDraft} onChange={(e) => setAddressDraft(e.target.value)} aria-label="Wallet address" />
            {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              {s.walletRead && !s.useDemoBalance && (
                <Button variant="secondary" onClick={() => { update((p) => ({ ...p, useDemoBalance: true })); setWalletOpen(false); }}>Disconnect</Button>
              )}
              <Button variant="secondary" onClick={() => setWalletOpen(false)}>Cancel</Button>
              <Button variant="secondary" disabled={!!busy || !addressDraft.trim()} onClick={() => run("Reading wallet…", () => connectWallet())}>{busy === "Reading wallet…" ? "Connecting…" : "Connect address"}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Ask the browser wallet (MetaMask etc.) which address to use. Read-only: we only take the address.
type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown>; isMetaMask?: boolean; providers?: Eip1193[] };
function browserWallet(): Eip1193 {
  // With several wallet extensions installed, window.ethereum may not be MetaMask: prefer it when it's there
  const injected = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  const eth = injected?.providers?.find((x) => x.isMetaMask) ?? injected;
  if (!eth) throw new Error("No browser wallet found. Install MetaMask, or paste your address instead.");
  return eth;
}

async function browserWalletAddress(): Promise<string> {
  const eth = browserWallet();
  try {
    const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts?.[0]) throw new Error("No account was shared.");
    return accounts[0];
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 4001) throw new Error("You closed MetaMask without connecting.");
    if (code === -32002) throw new Error("MetaMask is already asking. Open it from your browser toolbar.");
    throw e instanceof Error ? e : new Error("Couldn't connect to your wallet.");
  }
}

// ---------------- Small UI pieces ----------------

type Page = "dashboard" | "approvals" | "activity" | "shops" | "settings";


function Landing({ onCsv, onWallet, onBrowserWallet, busy, error }: { onCsv: (csv: string) => void; onWallet: (address: string) => void; onBrowserWallet: () => void; busy: string | null; error: string | null }) {
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
              <button type="button" disabled={!!busy} onClick={onBrowserWallet}
                className="mt-4 rounded-xl bg-[#fff] px-5 py-2.5 text-sm font-semibold text-[#1c1917] hover:bg-[#e7e5e4] disabled:opacity-50">Connect with MetaMask</button>
              <div className="mt-3 flex gap-2">
                <input className="min-w-0 flex-1 rounded-xl border border-white/15 bg-black/30 px-3 py-2.5 text-sm text-white placeholder:text-[#78716c] outline-none focus:border-brand-500"
                  placeholder="or paste an address" value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Wallet address" />
                <button type="submit" disabled={!!busy || !address.trim()} className="rounded-xl border border-white/20 px-4 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-50">Connect</button>
              </div>
            </form>
          </div>

          <div className="mt-5 min-h-6 text-sm">
            {busy ? <p className="text-[#d6d3d1]">{busy}</p> : (
              <>
                {error && <p className="mb-2 max-w-3xl text-red-300">{error}</p>}
                <button className="text-brand-500 underline underline-offset-4 hover:text-brand-100"
                  onClick={async () => onCsv(await (await fetch("/sample_bank_statement.csv")).text())}>
                  No statement handy? Try the sample statement
                </button>
              </>
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

// Demo of Kite Agent Passport's allowance, modelled on the Passport dashboard's "Set up allowance"
function PassportDemoCard({ allowance, today, onChange }: { allowance?: PassportAllowance; today: string; onChange: (a: PassportAllowance | undefined) => void }) {
  const [amount, setAmount] = useState(allowance?.amount ?? 50);
  const [period, setPeriod] = useState<PassportAllowance["period"]>(allowance?.period ?? "week");
  const [covers, setCovers] = useState(true);
  const [editing, setEditing] = useState(false);
  const [passkey, setPasskey] = useState<"idle" | "asking" | "verifying">("idle");
  const approve = () => {
    setPasskey("verifying");
    setTimeout(() => {
      onChange({ amount, period, start: today, spent: allowance?.spent ?? {}, on: true });
      setPasskey("idle"); setEditing(false);
    }, 1300);
  };
  const on = allowance?.on && !editing;
  return (
    <Card title="Kite Agent Passport" right={<span className="flex gap-1.5">{on && <Chip tone="good">allowance on</Chip>}<Chip tone="muted">demo</Chip></span>}>
      <p className="text-sm text-stone-600">With Kite Agent Passport, you set one spending allowance and approve it with your passkey. Kite then checks every payment your agents make against it and refuses anything over it. Reins&apos; own per-habit limits step aside: the allowance is the limit.</p>
      <p className="mt-1 text-xs text-stone-500">This is a simulation so you can see how it works without real USDC. Payments still run on Kite testnet.</p>

      {on && allowance ? (
        <div className="mt-3 rounded-xl bg-emerald-100 p-3 text-sm text-emerald-800">
          <p><span className="font-medium">{usd(allowance.amount)} {PERIOD_LABEL[allowance.period]}</span>, covering Reins and future agents. {usd(allowanceLeft(allowance, today))} left, resets {pretty(allowanceWindow(allowance, today).resets)}.</p>
          <p className="mt-1 text-xs">
            <button className="underline" onClick={() => { setAmount(allowance.amount); setPeriod(allowance.period); setEditing(true); }}>Change</button>
            {" · "}<button className="underline" onClick={() => onChange({ ...allowance, on: false })}>Turn off</button>
          </p>
        </div>
      ) : (
        <div className="mt-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-stone-600">Amount (USD, max 100)
              <input type="number" min={1} max={100} className="mt-1 w-full rounded-lg border border-stone-300 px-2 py-1 text-sm text-stone-900" value={amount}
                onChange={(e) => setAmount(Math.min(100, Math.max(1, Number(e.target.value) || 1)))} />
            </label>
            <label className="text-xs text-stone-600">Resets
              <select className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-900" value={period} onChange={(e) => setPeriod(e.target.value as PassportAllowance["period"])}>
                <option value="week">Weekly</option><option value="2weeks">Every 2 weeks</option><option value="month">Monthly</option>
              </select>
            </label>
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" className="accent-brand-500" checked={covers} onChange={(e) => setCovers(e.target.checked)} />Covers my current and future agents</label>
          <div className="mt-3 flex gap-2">
            <Button disabled={!covers || !today} onClick={() => setPasskey("asking")}>Approve allowance</Button>
            {editing && <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>}
          </div>
          {!today && <p className="mt-1 text-xs text-stone-500">Load a statement first.</p>}
        </div>
      )}

      {passkey !== "idle" && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 px-4" onClick={() => passkey === "asking" && setPasskey("idle")}>
          <div role="dialog" aria-modal="true" aria-label="Confirm with passkey" className="w-full max-w-sm rounded-2xl bg-white p-6 text-center" onClick={(e) => e.stopPropagation()}>
            <svg viewBox="0 0 24 24" className="mx-auto h-12 w-12 text-brand-500" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M12 11c0 3-1 6-3 8M15 12c0 3-.6 5.5-2 7.5M9 14c-.3 1.8-1 3.3-2 4.5M6.5 9.5A6 6 0 0 1 18 12c0 1.5-.1 3-.5 4.5M5 13c.1-.6.2-1.2.4-1.7M12 7.5A3.5 3.5 0 0 1 15.5 11" />
            </svg>
            <h2 className="mt-3 text-lg font-semibold">Confirm with your passkey</h2>
            <p className="mt-1 text-sm text-stone-500">Kite Agent Passport · allow agents to spend up to {usd(amount)} {PERIOD_LABEL[period]}.</p>
            <p className="mt-1 text-[11px] text-stone-400">Demo: no real passkey or money is used.</p>
            <div className="mt-5 flex justify-center gap-2">
              {passkey === "asking" ? <>
                <Button variant="secondary" onClick={() => setPasskey("idle")}>Cancel</Button>
                <Button onClick={approve}>Use passkey</Button>
              </> : <p className="flex items-center gap-2 text-sm text-stone-600"><span className="h-2 w-2 animate-pulse rounded-full bg-brand-500" />Verifying…</p>}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

// Kite Agent Passport: Reins pays from the user's Passport wallet, and Kite enforces the
// spending allowance the user set once in the Passport dashboard.
function PassportCard({ live, payScale, onBalance }: { live: boolean; payScale?: number; onBalance: (usdc: number) => void }) {
  const [info, setInfo] = useState<{ available: boolean; signedIn?: boolean; email?: string | null; balance?: number | null; reason?: string; dashboard?: string } | null>(null);
  const cb = useRef(onBalance);
  useEffect(() => { cb.current = onBalance; });
  const refresh = useCallback(() => {
    fetch("/api/passport").then((r) => r.json()).then((j) => { setInfo(j); if (typeof j.balance === "number") cb.current(j.balance); })
      .catch(() => setInfo({ available: false, reason: "Couldn't check Passport." }));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const dash = info?.dashboard ?? "https://agentpassport.ai/overview";
  return (
    <Card title="Kite Agent Passport" right={live && info?.signedIn ? <Chip tone="good">paying</Chip> : undefined}>
      <p className="text-sm text-stone-600">Reins pays from your Kite Agent Passport, and Kite holds the limit: the spending allowance you set once in your Passport dashboard. Anything over it, Kite refuses.</p>
      {!info ? <p className="mt-3 text-xs text-stone-500">Checking for Kite Passport…</p>
        : !info.available || !info.signedIn ? (
          <p className="mt-3 rounded-xl bg-stone-50 p-3 text-xs text-stone-600">{info.reason}</p>
        ) : (
          <div className="mt-3 grid gap-2 text-sm">
            <p>Signed in as <span className="font-medium">{info.email ?? "your Passport account"}</span>.</p>
            <p>Passport balance: <span className="font-medium">{typeof info.balance === "number" ? `${info.balance} USDC` : "unknown"}</span>
              {payScale && payScale !== 1 && typeof info.balance === "number" ? <span className="text-stone-500"> (a {usd(info.balance / payScale)} pot at the demo&apos;s 1/{Math.round(1 / payScale)} scale)</span> : null}
              {" "}<button className="text-xs underline" onClick={refresh}>Refresh</button></p>
            <div className="mt-1 flex flex-wrap gap-2">
              <a className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600" href={dash} target="_blank" rel="noreferrer">Set allowance in Passport</a>
              <a className="rounded-xl border border-stone-300 px-4 py-2 text-sm font-medium hover:bg-stone-50" href={dash} target="_blank" rel="noreferrer">Add funds</a>
            </div>
            <p className="text-xs text-stone-500">Payments are real USDC sent to the demo shops&apos; wallet. Your per-habit limits step aside, since Kite&apos;s allowance is the limit.</p>
          </div>
        )}
    </Card>
  );
}

// Fund the spending pot like a Kite Passport: show its deposit address, the user sends from any wallet,
// and Reins watches the chain for the money to arrive. Reins never asks to pull from the user's wallet.
const NETWORKS = [
  { name: "KiteAI Testnet", live: true },
  { name: "Base" }, { name: "Solana" }, { name: "Polygon" }, { name: "Avalanche" }, { name: "Card" },
];
function AddMoneyDialog({ address, payScale, onClose, onReceived }: { address: string; payScale: number; onClose: () => void; onReceived: () => void }) {
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  const [received, setReceived] = useState<{ amount: number; symbol: string } | null>(null);
  const [symbol, setSymbol] = useState("USDT");
  useEffect(() => { QRCode.toDataURL(address, { margin: 1, width: 360, color: { dark: "#1c1917", light: "#ffffff" } }).then(setQr).catch(() => {}); }, [address]);

  // Watch the pot's balance on Kite; anything above where it started is a deposit
  useEffect(() => {
    let start: number | null = null, stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/wallet?address=${address}`).then((x) => x.json());
        if (stop || !r.token) return;
        setSymbol(r.token.symbol);
        if (start === null) start = r.token.balance;
        else if (r.token.balance > start + 1e-9) {
          setReceived({ amount: Math.round((r.token.balance - start) * 1e6) / 1e6, symbol: r.token.symbol });
          onReceived();
        }
      } catch { /* try again next tick */ }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { stop = true; clearInterval(id); };
  }, [address, onReceived]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-black/40 px-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Add money" className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Add funds to your Kite Passport</h2>
        <p className="mt-1 text-sm text-stone-500">Send {symbol} from any wallet to this address. Reins only spends what you put here, and never pulls from your own wallet.</p>

        <div className="mt-4 flex flex-wrap gap-1.5" aria-label="Network">
          {NETWORKS.map((n) => (
            <span key={n.name} className={`rounded-full px-2.5 py-1 text-xs ${n.live ? "bg-brand-500 font-medium text-white" : "bg-stone-100 text-stone-400"}`}>{n.name}</span>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-stone-500">Base, Solana, Polygon, Avalanche and card come with Kite Agent Passport.</p>

        <div className="mt-4 grid place-items-center rounded-xl bg-[#fff] p-3">
          {qr ? <img src={qr} alt={`QR code for ${address}`} width={180} height={180} /> : <div className="h-[180px] w-[180px]" />}
        </div>
        <p className="mt-3 text-xs text-stone-500">Deposit address · {symbol} on KiteAI Testnet</p>
        <div className="mt-1 flex items-center gap-2 rounded-lg border border-stone-200 p-2">
          <code className="min-w-0 flex-1 break-all text-[13px]">{address}</code>
          <Button variant="secondary" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
        </div>
        <p className="mt-2 text-xs text-amber-800">Send only {symbol} on KiteAI Testnet. Other tokens or networks sent here will be lost.</p>
        {payScale !== 1 && <p className="mt-1 text-xs text-stone-500">On testnet, 1 {symbol} adds ${Math.round(1 / payScale)} to your pot.</p>}

        <div className={`mt-4 rounded-xl p-3 text-sm ${received ? "bg-emerald-100 text-emerald-800" : "bg-stone-50 text-stone-600"}`} aria-live="polite">
          {received ? (
            <>Received {received.amount} {received.symbol}: {usd(received.amount / payScale)} added to your pot.{" "}
              <a className="underline" href={`https://testnet.kitescan.ai/address/${address}`} target="_blank" rel="noreferrer">View on KiteScan</a></>
          ) : (
            <span className="flex items-center gap-2"><span className="h-2 w-2 animate-pulse rounded-full bg-brand-500" />Waiting for your deposit…</span>
          )}
        </div>
        <div className="mt-5 flex justify-end"><Button variant="secondary" onClick={onClose}>{received ? "Done" : "Close"}</Button></div>
      </div>
    </div>
  );
}

// The merchant side of the demo: what each x402 shop received from Reins, and the real money in its Kite wallet
function ShopsPage({ orders, live, shopPayTo, shopWallet, payScale, onRefresh, onTry }: {
  orders: LogEntry[]; live: boolean; shopPayTo?: string; shopWallet: { balance: number; symbol: string } | null; payScale?: number;
  onRefresh: () => void; onTry: () => void;
}) {
  useEffect(() => { onRefresh(); }, [onRefresh]);
  const steps = [
    ["Reins asks", "Requests the item from the shop, like any website."],
    ["402 Payment Required", "The shop replies with the price, the token and where to pay."],
    ["Reins pays on Kite", "Checks the price is what you approved, then pays from its agent wallet."],
    ["Shop confirms", "Verifies the payment on-chain, then confirms the order."],
  ];
  return (
    <div className="grid gap-4">
      <Card title="Demo shops" right={live && shopPayTo ? (
        <a className="text-xs text-stone-500 underline" href={`https://testnet.kitescan.ai/address/${shopPayTo}`} target="_blank" rel="noreferrer">
          Shops&apos; wallet{shopWallet ? `: ${shopWallet.balance.toFixed(4)} ${shopWallet.symbol} received` : ""}
        </a>) : undefined}>
        <p className="text-sm text-stone-600">Four shops that sell to AI agents over x402 on Kite&apos;s test network. Every order below was paid on-chain by Reins.
          {payScale && payScale !== 1 ? ` On testnet each payment is 1/${Math.round(1 / payScale)} of the price.` : ""}</p>
        <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map(([t, d], i) => (
            <li key={t} className="rounded-xl bg-stone-50 p-3">
              <p className="text-sm font-medium"><span className="mr-1.5 text-brand-600">{i + 1}</span>{t}</p>
              <p className="mt-0.5 text-xs text-stone-500">{d}</p>
            </li>
          ))}
        </ol>
        {!live && <p className="mt-3 text-xs text-stone-500">Payments are in demo mode right now, so the shops don&apos;t receive anything.</p>}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {Object.values(SHOPS).map((shop) => {
          const mine = orders.filter((o) => o.payment?.shop === shop.name);
          const total = mine.reduce((a, o) => a + o.request.amount, 0);
          return (
            <Card key={shop.name} title={shop.name} right={<span className="text-xs text-stone-500">{mine.length} order{mine.length === 1 ? "" : "s"} · {usd(total)}</span>}>
              <p className="text-xs text-stone-500">{shop.sells}</p>
              {!mine.length ? (
                <div className="mt-3 rounded-xl border border-dashed border-stone-200 p-3 text-sm text-stone-500">
                  No orders yet.{shop.name === "Reins Coffee" && live && <button className="ml-1 text-brand-600 underline" onClick={onTry}>Ask Reins for a coffee</button>}
                </div>
              ) : (
                <ul className="mt-2 divide-y divide-stone-100">
                  {mine.slice(0, 5).map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm">{o.request.description || o.request.merchant}</p>
                        <p className="text-[11px] text-stone-500">{pretty(o.date)}{o.payment?.orderId ? ` · order ${o.payment.orderId.replace("ord_", "")}` : ""} · {o.payment?.onchain}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Chip tone="good">confirmed</Chip>
                        {o.payment?.explorerUrl && <a className="text-xs underline" href={o.payment.explorerUrl} target="_blank" rel="noreferrer">KiteScan</a>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
    </div>
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
  const map = { paid: ["paid", "good"], waiting: ["waiting", "warn"], paying: ["paying", "warn"], blocked: ["blocked", "bad"], declined: ["declined", "muted"], failed: ["failed", "bad"] } as const;
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

type IconName = "home" | "check" | "habits" | "activity" | "store" | "settings" | "bell" | "menu";

function Icon({ name }: { name: IconName }) {
  const d = {
    home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
    check: "M9 12l2 2 4-4M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
    menu: "M4 7h16M4 12h16M4 17h16",
    store: "M4 4h16l1 5a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0zM5 12v8h14v-8M10 20v-5h4v5",
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
