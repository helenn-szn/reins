// Shared types for Reins. Used by both the browser and the API routes.

export type Transaction = {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number; // negative = money out, positive = money in
};

export type Cadence =
  | { type: "weekdays" } // most weekdays
  | { type: "weekly"; weekday: number } // 0 = Sunday ... 6 = Saturday
  | { type: "monthly"; dayOfMonth: number }
  | { type: "frequent"; perWeek: number }; // regular but no fixed day

// bill: subscriptions, phone, rent. essential: groceries. lifestyle: coffee, nights out, rides, food.
export type HabitKind = "bill" | "essential" | "lifestyle";

export type Habit = {
  id: string;
  name: string;
  category: string;
  merchants: string[];
  cadence: Cadence;
  kind: HabitKind;
  count: number; // times seen in the statement
  avgAmount: number;
  maxAmount: number;
  lastSeen: string;
  // User-controlled
  enabled: boolean; // switchboard on/off
  capPerPurchase: number; // hard limit per purchase (USD)
  // Trust ladder
  approvalsInARow: number;
  autopilot: boolean; // graduated to automatic
  note?: string; // SERV insight, e.g. "Possibly forgotten subscription"
};

export type Mode = "ask_every_time" | "trust_ladder" | "full_autopilot";

export type PurchaseRequest = {
  id: string;
  date: string;
  merchant: string;
  amount: number;
  habitId?: string; // set when it comes from a habit
  description?: string; // for on-demand requests, e.g. "Order lunch under $15"
};

export type DecisionAction = "allow" | "ask" | "block";

export type Decision = {
  action: DecisionAction;
  reason: string;
  source: "rules" | "serv"; // who made the final call
  safeMode: boolean;
};

export type Payment = {
  id: string;
  date: string;
  merchant: string;
  amount: number;
  status: "paid" | "failed";
  txHash?: string;
  provider: "mock" | "kite";
};

export type LogEntry = {
  id: string;
  date: string;
  request: PurchaseRequest;
  decision: Decision;
  outcome: "paid" | "waiting" | "blocked" | "declined" | "failed";
  payment?: Payment;
};

// Everything the decision engine needs to know. Sent from the browser to /api/decide.
export type EngineState = {
  today: string;
  mode: Mode;
  habits: Habit[];
  walletBalance: number; // user's own wallet, read-only (USD)
  safetyFloor: number; // USD the user always wants left
  potBalance: number; // Kite Passport spending pot (USD)
  onDemandAutoLimit: number; // on-demand purchases up to this can skip approval in full autopilot
  spent: Record<string, number>; // "<habitId>:<periodKey>" -> USD already spent in that period
};
