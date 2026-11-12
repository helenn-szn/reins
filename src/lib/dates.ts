// Small date helpers. Dates are plain "YYYY-MM-DD" strings, read in UTC so they never shift by a day.

export const parse = (d: string) => new Date(`${d}T00:00:00Z`);
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => iso(new Date(parse(d).getTime() + n * 864e5));
export const weekday = (d: string) => parse(d).getUTCDay(); // 0 = Sunday
export const dayOfMonth = (d: string) => parse(d).getUTCDate();
export const daysBetween = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 864e5);

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Monday that starts the week of d (used as the "week" period key)
export const weekStart = (d: string) => addDays(d, -((weekday(d) + 6) % 7));

export function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function pretty(d: string) {
  return parse(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
