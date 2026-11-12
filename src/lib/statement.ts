import Papa from "papaparse";
import type { Transaction } from "./types";

// Reads a bank statement CSV. Handles the two common layouts:
//   Date, Description, Debit, Credit[, Balance]
//   Date, Description, Amount (negative = money out)
export function parseStatementCsv(csv: string): Transaction[] {
  const parsed = Papa.parse<Record<string, string>>(csv.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });

  const pick = (row: Record<string, string>, names: string[]) => {
    for (const n of names) if (row[n] !== undefined && row[n] !== "") return row[n];
    return undefined;
  };
  const money = (v?: string) => (v ? Number(v.replace(/[^0-9.-]/g, "")) : 0);

  const out: Transaction[] = [];
  for (const row of parsed.data) {
    const rawDate = pick(row, ["date", "transaction date", "posted date", "value date"]);
    const description = pick(row, ["description", "narration", "details", "merchant", "memo"]);
    if (!rawDate || !description) continue;
    const date = toIsoDate(rawDate);
    if (!date) continue;

    let amount: number;
    const amt = pick(row, ["amount", "amount (usd)"]);
    if (amt !== undefined) amount = money(amt);
    else amount = money(pick(row, ["credit", "money in", "deposit"])) - money(pick(row, ["debit", "money out", "withdrawal"]));
    if (!amount || Number.isNaN(amount)) continue;

    out.push({ date, description: description.trim(), amount });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function toIsoDate(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // DD/MM/YYYY
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
