/**
 * Pure scheduling logic (no Firebase imports) so it can be unit tested.
 *
 * Every session is exactly one hour long and starts on the trainer's start-time
 * spacing (every 15 minutes by default) in the trainer's time zone. A trainer publishes weekly availability windows in
 * their own local time; a requested hour must sit entirely inside one window.
 */

export const SESSION_MINUTES = 60;
export const SESSION_MS = SESSION_MINUTES * 60 * 1000;

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** "HH:MM" in 24h local time; end may be "24:00". */
export interface TimeWindow {
  start: string;
  end: string;
}

export interface Availability {
  /** IANA time zone, e.g. "America/Los_Angeles". */
  timezone: string;
  weekly: Partial<Record<Weekday, TimeWindow[]>>;
  /** Local dates ("YYYY-MM-DD") with no sessions (vacations, holidays). */
  blackoutDates?: string[];
  /** Requests must be at least this many hours in the future. */
  minNoticeHours?: number;
  /** Requests can be at most this many days in the future. */
  maxDaysAhead?: number;
  /** Clients cancelling with less notice than this are flagged as late. */
  cancellationWindowHours?: number;
  /** False hides this trainer from new requests. */
  acceptingRequests?: boolean;
  /** Sessions may start every N minutes: 15, 30 or 60. */
  slotStepMinutes?: number;
}

export const DEFAULT_MIN_NOTICE_HOURS = 12;
export const DEFAULT_MAX_DAYS_AHEAD = 60;
export const DEFAULT_CANCELLATION_WINDOW_HOURS = 24;
export const DEFAULT_SLOT_STEP_MINUTES = 15;
export const SLOT_STEPS = [15, 30, 60] as const;
/** Bookings are locked in 15-minute blocks (the smallest start-time spacing). */
export const BLOCK_MS = 15 * 60 * 1000;

const WEEKDAY_FROM_INTL: Record<string, Weekday> = {
  Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun",
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export interface LocalParts {
  weekday: Weekday;
  /** "YYYY-MM-DD" */
  date: string;
  /** Minutes since local midnight. */
  minutes: number;
  second: number;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  return {
    weekday: WEEKDAY_FROM_INTL[parts.weekday],
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    second: Number(parts.second),
  };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;

export function parseHHMM(value: string): number {
  if (!HHMM.test(value)) throw new Error(`Invalid time "${value}", expected HH:MM`);
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

/** Throws with a readable message if the availability document is malformed. */
export function validateAvailability(a: Availability): void {
  if (!isValidTimeZone(a.timezone)) throw new Error(`Unknown time zone "${a.timezone}"`);
  for (const [day, windows] of Object.entries(a.weekly)) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) throw new Error(`Unknown weekday "${day}"`);
    const sorted = [...(windows ?? [])]
      .map((w) => ({ start: parseHHMM(w.start), end: parseHHMM(w.end) }))
      .sort((x, y) => x.start - y.start);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].end <= sorted[i].start) throw new Error(`${day}: window end must be after start`);
      if (i > 0 && sorted[i].start < sorted[i - 1].end) throw new Error(`${day}: windows overlap`);
    }
  }
  for (const d of a.blackoutDates ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Invalid blackout date "${d}"`);
  }
}

export type SlotProblem =
  | "bad_start_time"
  | "too_soon"
  | "too_far_ahead"
  | "blackout"
  | "outside_availability"
  | "not_accepting";

export const SLOT_PROBLEM_MESSAGES: Record<SlotProblem, string> = {
  bad_start_time: "Sessions can't start at that time — please pick one of the listed start times.",
  too_soon: "That time is too soon — please give more notice.",
  too_far_ahead: "That time is too far ahead to book yet.",
  blackout: "The trainer is unavailable that day.",
  outside_availability: "That hour is outside the trainer's available hours.",
  not_accepting: "This trainer is not accepting session requests right now.",
};

/**
 * Checks whether a one-hour session starting at `start` fits the trainer's
 * availability. Returns null when it fits, otherwise the reason it doesn't.
 * Does NOT check for conflicts with other sessions.
 */
export function checkSlot(
  start: Date,
  availability: Availability,
  now: Date,
  opts: { enforceNotice?: boolean } = {},
): SlotProblem | null {
  const enforceNotice = opts.enforceNotice ?? true;
  if (availability.acceptingRequests === false && enforceNotice) return "not_accepting";

  const tz = availability.timezone;
  const s = localParts(start, tz);
  const step = SLOT_STEPS.includes(availability.slotStepMinutes as 15) ? availability.slotStepMinutes! : DEFAULT_SLOT_STEP_MINUTES;
  if (s.minutes % step !== 0 || s.second !== 0 || start.getUTCMilliseconds() !== 0) {
    return "bad_start_time";
  }

  const minNotice = (availability.minNoticeHours ?? DEFAULT_MIN_NOTICE_HOURS) * 3_600_000;
  const maxAhead = (availability.maxDaysAhead ?? DEFAULT_MAX_DAYS_AHEAD) * 86_400_000;
  const lead = start.getTime() - now.getTime();
  if (lead < (enforceNotice ? minNotice : 0)) return "too_soon";
  if (lead > maxAhead) return "too_far_ahead";

  if (availability.blackoutDates?.includes(s.date)) return "blackout";

  // The session must end within the same local day, exactly 60 local minutes
  // later (this rejects hours that straddle a daylight-saving change).
  const endMs = start.getTime() + SESSION_MS;
  const e = localParts(new Date(endMs), tz);
  const endMinutes = e.date === s.date ? e.minutes : e.minutes === 0 ? 24 * 60 : -1;
  if (endMinutes !== s.minutes + SESSION_MINUTES) return "outside_availability";

  const windows = availability.weekly[s.weekday] ?? [];
  const fits = windows.some(
    (w) => parseHHMM(w.start) <= s.minutes && endMinutes <= parseHHMM(w.end),
  );
  return fits ? null : "outside_availability";
}

export interface Busy {
  start: number;
  end: number;
}

/**
 * Lists every bookable start time in [from, to) for a trainer, skipping any
 * hour that would overlap a busy period (another booked session).
 */
export function listOpenSlots(
  availability: Availability,
  from: Date,
  to: Date,
  busy: Busy[],
  now: Date,
): Date[] {
  const STEP = BLOCK_MS; // also handles :30 and :45 UTC-offset zones
  const out: Date[] = [];
  let t = Math.ceil(from.getTime() / STEP) * STEP;
  for (; t < to.getTime(); t += STEP) {
    if (busy.some((b) => overlaps(t, t + SESSION_MS, b.start, b.end))) continue;
    const start = new Date(t);
    if (checkSlot(start, availability, now) === null) out.push(start);
  }
  return out;
}

/** Deterministic lock-document id for one 15-minute block of a trainer's day. */
export function slotId(trainerId: string, start: Date): string {
  return `${trainerId}_${start.toISOString().slice(0, 16).replace(":", "")}`;
}

/** The 15-minute blocks a session covers (its lock documents). */
export function blockIds(trainerId: string, start: Date, end: Date): string[] {
  const ids: string[] = [];
  for (let t = Math.floor(start.getTime() / BLOCK_MS) * BLOCK_MS; t < end.getTime(); t += BLOCK_MS) ids.push(slotId(trainerId, new Date(t)));
  return ids;
}

/**
 * Blocks whose lock could belong to a session overlapping [start, end): the
 * session's own blocks plus the ones up to an hour before (an earlier session
 * may still be running; older bookings only locked their first block).
 */
export function nearbyBlockIds(trainerId: string, start: Date, end: Date): string[] {
  return blockIds(trainerId, new Date(start.getTime() - SESSION_MS + BLOCK_MS), end);
}

export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function isLateCancellation(start: Date, now: Date, availability?: Availability): boolean {
  const window = (availability?.cancellationWindowHours ?? DEFAULT_CANCELLATION_WINDOW_HOURS) * 3_600_000;
  return start.getTime() - now.getTime() < window;
}
