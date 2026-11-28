/**
 * Calendar invites for sessions: an .ics file (Outlook desktop, Apple
 * Calendar, most apps) plus "add to Google / Outlook" links. Pure functions so
 * they can be unit tested.
 */

export interface CalendarEvent {
  /** Stable id: the same uid in a later CANCEL removes the event. */
  uid: string;
  start: Date;
  end: Date;
  title: string;
  description?: string;
  location?: string;
}

/** 20261116T140000Z */
export function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Escapes text per RFC 5545 §3.3.11. */
export function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds a content line to 75 octets (RFC 5545 §3.1), never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, "utf8");
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

/**
 * Builds a one-event calendar file. `cancel` produces the matching
 * cancellation (same UID, higher SEQUENCE) so calendar apps remove the event.
 */
export function buildIcs(e: CalendarEvent, opts: { cancel?: boolean; now?: Date } = {}): string {
  const cancel = opts.cancel ?? false;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Toro Fitness//Member Portal//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${cancel ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${icsDate(opts.now ?? new Date())}`,
    `DTSTART:${icsDate(e.start)}`,
    `DTEND:${icsDate(e.end)}`,
    `SEQUENCE:${cancel ? 1 : 0}`,
    `STATUS:${cancel ? "CANCELLED" : "CONFIRMED"}`,
    `SUMMARY:${icsText(cancel ? `Cancelled: ${e.title}` : e.title)}`,
    ...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
    ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []),
    ...(cancel
      ? []
      : ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(e.title)}`, "TRIGGER:-PT1H", "END:VALARM"]),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Opens Google Calendar with the event filled in. */
export function googleCalendarLink(e: CalendarEvent): string {
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${icsDate(e.start)}/${icsDate(e.end)}`,
    ...(e.description ? { details: e.description } : {}),
    ...(e.location ? { location: e.location } : {}),
  });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

/**
 * Opens Outlook on the web with the event filled in. `account` picks
 * outlook.com (personal) or Microsoft 365 (work/school) accounts.
 */
export function outlookCalendarLink(e: CalendarEvent, account: "personal" | "work" = "personal"): string {
  const host = account === "work" ? "outlook.office.com" : "outlook.live.com";
  const p = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: e.title,
    startdt: e.start.toISOString(),
    enddt: e.end.toISOString(),
    ...(e.description ? { body: e.description } : {}),
    ...(e.location ? { location: e.location } : {}),
  });
  return `https://${host}/calendar/0/deeplink/compose?${p.toString()}`;
}

/** "Monday, November 16 · 6:00 – 7:00 AM" in the given time zone. */
export function describeTime(start: Date, end: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(start);
  const t = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(d);
  const zone = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(start)
    .find((p) => p.type === "timeZoneName")?.value;
  return `${day} · ${t(start)} – ${t(end)}${zone ? ` ${zone}` : ""}`;
}
