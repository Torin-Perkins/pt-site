import type { Timestamp } from "firebase/firestore";

type DateLike = Date | Timestamp | string | null | undefined;

export function toDate(v: DateLike): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v);
  return v.toDate();
}

export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function fmtDate(v: DateLike, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }) {
  const d = toDate(v);
  return d ? d.toLocaleDateString(undefined, opts) : "—";
}

export function fmtTime(v: DateLike, timeZone?: string) {
  const d = toDate(v);
  return d ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone }) : "—";
}

export function fmtDateTime(v: DateLike) {
  const d = toDate(v);
  if (!d) return "—";
  return `${fmtDate(d)} · ${fmtTime(d)}`;
}

/** "2026-11-06" in the browser's time zone. */
export function isoDay(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function money(cents: number | null | undefined, currency = "usd") {
  if (cents == null) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

/** Parses "85" / "85.50" / "$85" into cents, or null. */
export function parseDollars(v: string): number | null {
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

/** Number from an input, or null when blank. */
export function num(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - day);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?").toUpperCase() + (parts[1]?.[0] ?? "").toUpperCase();
}

export const displayNameOf = (u: { displayName?: string | null; email?: string | null } | null | undefined) =>
  u?.displayName || u?.email || "Unnamed";
