import { describe, expect, it } from "vitest";
import {
  buildIcs,
  describeTime,
  foldLine,
  googleCalendarLink,
  icsDate,
  icsText,
  outlookCalendarLink,
  type CalendarEvent,
} from "../../src/lib/calendar.js";
import { emailKind } from "../../src/notifications.js";
import type { SessionDoc } from "../../src/scheduling.js";

const event: CalendarEvent = {
  uid: "abc123@toro-fitness",
  start: new Date("2026-11-16T14:00:00Z"),
  end: new Date("2026-11-16T15:00:00Z"),
  title: "Personal training with Erica Hansen",
  description: "Client note: knees, deadlifts; go easy\nSecond line",
  location: "Online, via video call",
};
const now = new Date("2026-11-07T12:00:00Z");

describe("ics", () => {
  it("formats dates and escapes text", () => {
    expect(icsDate(event.start)).toBe("20261116T140000Z");
    expect(icsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });

  it("builds a valid one-event calendar", () => {
    const ics = buildIcs(event, { now });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("METHOD:PUBLISH");
    expect(ics).toContain("UID:abc123@toro-fitness");
    expect(ics).toContain("DTSTART:20261116T140000Z");
    expect(ics).toContain("DTEND:20261116T150000Z");
    expect(ics).toContain("DTSTAMP:20261107T120000Z");
    expect(ics).toContain("LOCATION:Online\\, via video call");
    expect(ics).toContain("TRIGGER:-PT1H");
    // no bare LF line breaks, and every line ≤ 75 octets
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });

  it("builds the matching cancellation", () => {
    const ics = buildIcs(event, { cancel: true, now });
    expect(ics).toContain("METHOD:CANCEL");
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).toContain("SEQUENCE:1");
    expect(ics).toContain("UID:abc123@toro-fitness");
    expect(ics).not.toContain("VALARM");
  });

  it("folds long lines without splitting characters", () => {
    const long = "DESCRIPTION:" + "é".repeat(100);
    const folded = foldLine(long);
    for (const part of folded.split("\r\n")) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
    expect(folded.split("\r\n").map((p, i) => (i ? p.slice(1) : p)).join("")).toBe(long);
  });
});

describe("calendar links", () => {
  it("Google Calendar", () => {
    const url = new URL(googleCalendarLink(event));
    expect(url.hostname).toBe("calendar.google.com");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("dates")).toBe("20261116T140000Z/20261116T150000Z");
    expect(url.searchParams.get("text")).toBe(event.title);
    expect(url.searchParams.get("location")).toBe(event.location);
  });

  it("Outlook personal and work", () => {
    const personal = new URL(outlookCalendarLink(event));
    expect(personal.hostname).toBe("outlook.live.com");
    expect(personal.searchParams.get("startdt")).toBe("2026-11-16T14:00:00.000Z");
    expect(personal.searchParams.get("enddt")).toBe("2026-11-16T15:00:00.000Z");
    expect(personal.searchParams.get("subject")).toBe(event.title);
    expect(new URL(outlookCalendarLink(event, "work")).hostname).toBe("outlook.office.com");
  });

  it("describes the time in the trainer's zone", () => {
    expect(describeTime(event.start, event.end, "America/Los_Angeles")).toBe("Monday, November 16 · 6:00 AM – 7:00 AM PST");
  });
});

describe("which email a session change sends", () => {
  const s = (status: SessionDoc["status"]) => ({ status }) as SessionDoc;
  it("confirmations", () => {
    expect(emailKind(s("requested"), s("confirmed"))).toBe("confirmed");
    expect(emailKind(undefined, s("confirmed"))).toBe("confirmed"); // booked directly
    expect(emailKind(s("confirmed"), s("confirmed"))).toBeNull(); // e.g. invoice linked
  });
  it("cancellations", () => {
    expect(emailKind(s("confirmed"), s("cancelled"))).toBe("cancelled");
    expect(emailKind(s("requested"), s("cancelled"))).toBeNull(); // never on a calendar
    expect(emailKind(s("requested"), s("declined"))).toBeNull();
    expect(emailKind(s("confirmed"), s("completed"))).toBeNull();
    expect(emailKind(s("confirmed"), undefined)).toBeNull();
  });
});
