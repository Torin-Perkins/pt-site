import { describe, expect, it } from "vitest";
import {
  type Availability,
  checkSlot,
  isLateCancellation,
  blockIds,
  listOpenSlots,
  nearbyBlockIds,
  localParts,
  slotId,
  validateAvailability,
} from "../../src/lib/schedule.js";

const avail: Availability = {
  timezone: "America/Los_Angeles",
  weekly: {
    mon: [{ start: "06:00", end: "12:00" }, { start: "16:00", end: "19:00" }],
    wed: [{ start: "06:00", end: "12:00" }],
    sat: [{ start: "08:00", end: "10:00" }],
  },
  blackoutDates: ["2026-11-25"],
  minNoticeHours: 12,
  maxDaysAhead: 60,
};

// Monday 2026-11-09, 00:00 Pacific (PST, UTC-8)
const now = new Date("2026-11-09T08:00:00Z");

describe("localParts", () => {
  it("converts to trainer local time", () => {
    const p = localParts(new Date("2026-11-16T14:00:00Z"), "America/Los_Angeles");
    expect(p).toEqual({ weekday: "mon", date: "2026-11-16", minutes: 6 * 60, second: 0 });
  });
});

describe("checkSlot", () => {
  it("accepts an hour inside a window", () => {
    expect(checkSlot(new Date("2026-11-16T14:00:00Z"), avail, now)).toBeNull(); // Mon 06:00
    expect(checkSlot(new Date("2026-11-16T19:00:00Z"), avail, now)).toBeNull(); // Mon 11:00 (ends 12:00)
  });

  it("rejects an hour that runs past the window", () => {
    expect(checkSlot(new Date("2026-11-16T20:00:00Z"), avail, now)).toBe("outside_availability"); // 12:00
    expect(checkSlot(new Date("2026-11-17T14:00:00Z"), avail, now)).toBe("outside_availability"); // Tue
  });

  it("allows starts on the quarter hour by default", () => {
    expect(checkSlot(new Date("2026-11-16T14:15:00Z"), avail, now)).toBeNull(); // 06:15
    expect(checkSlot(new Date("2026-11-16T14:45:00Z"), avail, now)).toBeNull(); // 06:45
    expect(checkSlot(new Date("2026-11-16T14:10:00Z"), avail, now)).toBe("bad_start_time");
    expect(checkSlot(new Date("2026-11-16T14:00:01Z"), avail, now)).toBe("bad_start_time");
    // must still fit the window: 11:15 would end 12:15
    expect(checkSlot(new Date("2026-11-16T19:15:00Z"), avail, now)).toBe("outside_availability");
  });

  it("follows the trainer's start-time spacing", () => {
    const half = { ...avail, slotStepMinutes: 30 };
    expect(checkSlot(new Date("2026-11-16T14:30:00Z"), half, now)).toBeNull();
    expect(checkSlot(new Date("2026-11-16T14:15:00Z"), half, now)).toBe("bad_start_time");
    const hourly = { ...avail, slotStepMinutes: 60 };
    expect(checkSlot(new Date("2026-11-16T14:00:00Z"), hourly, now)).toBeNull();
    expect(checkSlot(new Date("2026-11-16T14:30:00Z"), hourly, now)).toBe("bad_start_time");
  });

  it("enforces notice and horizon", () => {
    expect(checkSlot(new Date("2026-11-09T14:00:00Z"), avail, now)).toBe("too_soon"); // 6h ahead
    expect(checkSlot(new Date("2026-11-09T14:00:00Z"), avail, now, { enforceNotice: false })).toBeNull();
    expect(checkSlot(new Date("2027-03-01T14:00:00Z"), avail, now)).toBe("too_far_ahead");
    expect(checkSlot(new Date("2026-11-08T14:00:00Z"), avail, now, { enforceNotice: false })).toBe("too_soon");
  });

  it("honours blackout dates and acceptingRequests", () => {
    expect(checkSlot(new Date("2026-11-25T14:00:00Z"), avail, now)).toBe("blackout"); // Wed
    expect(checkSlot(new Date("2026-11-16T14:00:00Z"), { ...avail, acceptingRequests: false }, now)).toBe(
      "not_accepting",
    );
  });

  it("handles daylight-saving time", () => {
    // Mon 2026-03-09 is after spring-forward (PDT, UTC-7): 06:00 local = 13:00Z
    const spring = new Date("2026-02-20T08:00:00Z");
    expect(checkSlot(new Date("2026-03-09T13:00:00Z"), avail, spring)).toBeNull();
    expect(checkSlot(new Date("2026-03-09T14:00:00Z"), avail, spring)).toBeNull(); // 07:00 PDT
  });

  it("rejects an hour that straddles a DST jump", () => {
    const nightOwl: Availability = { timezone: "America/Los_Angeles", weekly: { sun: [{ start: "00:00", end: "24:00" }] } };
    const before = new Date("2026-02-20T08:00:00Z");
    // 2026-03-08 01:00 PST -> 03:00 PDT one hour later
    expect(checkSlot(new Date("2026-03-08T09:00:00Z"), nightOwl, before)).toBe("outside_availability");
    expect(checkSlot(new Date("2026-03-08T10:00:00Z"), nightOwl, before)).toBeNull(); // 03:00 PDT
  });

  it("allows a window ending at midnight", () => {
    const late: Availability = { timezone: "UTC", weekly: { mon: [{ start: "22:00", end: "24:00" }] } };
    expect(checkSlot(new Date("2026-11-16T23:00:00Z"), late, now)).toBeNull();
  });
});

describe("listOpenSlots", () => {
  const from = new Date("2026-11-16T08:00:00Z"); // Mon 00:00 PST
  const to = new Date("2026-11-17T08:00:00Z");
  const local = (d: Date) => {
    const m = localParts(d, avail.timezone).minutes;
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  };

  it("hourly spacing skips a booked hour", () => {
    const busy = [{ start: Date.parse("2026-11-16T15:00:00Z"), end: Date.parse("2026-11-16T16:00:00Z") }]; // 07:00-08:00
    const slots = listOpenSlots({ ...avail, slotStepMinutes: 60 }, from, to, busy, now).map(local);
    expect(slots).toEqual(["6:00", "8:00", "9:00", "10:00", "11:00", "16:00", "17:00", "18:00"]);
  });

  it("15-minute spacing hides every start that would overlap a booking", () => {
    const busy = [{ start: Date.parse("2026-11-16T15:15:00Z"), end: Date.parse("2026-11-16T16:15:00Z") }]; // 07:15-08:15
    const morning = listOpenSlots(avail, from, to, busy, now).map(local).filter((t) => Number(t.split(":")[0]) < 12);
    expect(morning).toEqual([
      "6:00", "6:15",
      "8:15", "8:30", "8:45", "9:00", "9:15", "9:30", "9:45", "10:00", "10:15", "10:30", "10:45", "11:00",
    ]);
  });

  it("works in half-hour offset time zones", () => {
    const india: Availability = { timezone: "Asia/Kolkata", weekly: { mon: [{ start: "09:00", end: "11:00" }] } };
    const slots = listOpenSlots(india, new Date("2026-11-15T18:30:00Z"), new Date("2026-11-16T18:30:00Z"), [], now);
    expect(slots.map((d) => d.toISOString())).toEqual([
      "2026-11-16T03:30:00.000Z", "2026-11-16T03:45:00.000Z", "2026-11-16T04:00:00.000Z", "2026-11-16T04:15:00.000Z", "2026-11-16T04:30:00.000Z",
    ]);
  });
});

describe("validateAvailability", () => {
  it("rejects bad input", () => {
    expect(() => validateAvailability({ ...avail, timezone: "Mars/Olympus" })).toThrow(/time zone/);
    expect(() => validateAvailability({ ...avail, weekly: { mon: [{ start: "10:00", end: "09:00" }] } })).toThrow();
    expect(() =>
      validateAvailability({ ...avail, weekly: { mon: [{ start: "06:00", end: "10:00" }, { start: "09:00", end: "11:00" }] } }),
    ).toThrow(/overlap/);
    expect(() => validateAvailability(avail)).not.toThrow();
  });
});

describe("misc", () => {
  it("builds stable slot ids", () => {
    expect(slotId("t1", new Date("2026-11-16T14:00:00Z"))).toBe("t1_2026-11-16T1400");
  });
  it("locks a session's four 15-minute blocks and checks the hour before", () => {
    const start = new Date("2026-11-16T14:15:00Z");
    const end = new Date("2026-11-16T15:15:00Z");
    expect(blockIds("t1", start, end)).toEqual(["t1_2026-11-16T1415", "t1_2026-11-16T1430", "t1_2026-11-16T1445", "t1_2026-11-16T1500"]);
    expect(nearbyBlockIds("t1", start, end)).toEqual([
      "t1_2026-11-16T1330", "t1_2026-11-16T1345", "t1_2026-11-16T1400",
      "t1_2026-11-16T1415", "t1_2026-11-16T1430", "t1_2026-11-16T1445", "t1_2026-11-16T1500",
    ]);
  });
  it("flags late cancellations", () => {
    expect(isLateCancellation(new Date("2026-11-10T08:00:00Z"), now)).toBe(false); // exactly 24h
    expect(isLateCancellation(new Date("2026-11-10T07:00:00Z"), now)).toBe(true);
  });
});
