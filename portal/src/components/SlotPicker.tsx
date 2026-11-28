import { useEffect, useMemo, useState } from "react";
import { call, errorMessage } from "../firebase";
import { addDays, browserTimeZone, fmtDate, fmtTime, isoDay, startOfWeek } from "../lib/format";
import { Button, Empty, ErrorNote, Loading } from "./ui";

const PARTS = [
  { label: "Morning", until: 12 },
  { label: "Afternoon", until: 17 },
  { label: "Evening", until: 24 },
];

/**
 * A trainer's open 1-hour start times (from getOpenSlots), a week at a time:
 * pick a day, then a time. `refreshKey` forces a reload after booking.
 */
export default function SlotPicker({
  trainerId,
  selected,
  onSelect,
  refreshKey = 0,
}: {
  trainerId: string;
  selected: string | null;
  onSelect: (iso: string) => void;
  refreshKey?: number;
}) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [slots, setSlots] = useState<string[] | null>(null);
  const [tz, setTz] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSlots(null);
    setError(null);
    call<{ timezone: string; slots: string[] }>("getOpenSlots", {
      trainerId,
      from: weekStart.toISOString(),
      to: addDays(weekStart, 7).toISOString(),
    })
      .then((r) => {
        if (cancelled) return;
        setSlots(r.slots);
        setTz(r.timezone);
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [trainerId, weekStart, refreshKey]);

  const days = useMemo(() => {
    const out = Array.from({ length: 7 }, (_, i) => ({ date: addDays(weekStart, i), key: isoDay(addDays(weekStart, i)), slots: [] as string[] }));
    for (const s of slots ?? []) out.find((d) => d.key === isoDay(new Date(s)))?.slots.push(s);
    return out;
  }, [slots, weekStart]);

  // Keep the chosen day if it still has times, otherwise jump to the first day that does.
  useEffect(() => {
    if (!slots) return;
    if (day && days.some((d) => d.key === day && d.slots.length)) return;
    setDay(days.find((d) => d.slots.length)?.key ?? null);
  }, [slots, days, day]);

  const current = days.find((d) => d.key === day);
  const thisWeek = startOfWeek(new Date()).getTime() === weekStart.getTime();
  const mine = browserTimeZone();

  return (
    <div className="slot-picker">
      <div className="week-nav">
        <Button size="sm" variant="ghost" disabled={thisWeek} onClick={() => setWeekStart((w) => addDays(w, -7))} aria-label="Previous week">←</Button>
        <strong>
          {fmtDate(weekStart, { month: "short", day: "numeric" })} – {fmtDate(addDays(weekStart, 6), { month: "short", day: "numeric" })}
        </strong>
        <Button size="sm" variant="ghost" onClick={() => setWeekStart((w) => addDays(w, 7))} aria-label="Next week">→</Button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!slots && !error ? (
        <Loading label="Finding open times…" />
      ) : slots && slots.length === 0 ? (
        <Empty>No open times this week. Try the next week.</Empty>
      ) : (
        <>
          <div className="day-strip" role="tablist" aria-label="Day">
            {days.map((d) => (
              <button
                key={d.key}
                type="button"
                role="tab"
                aria-selected={d.key === day}
                disabled={!d.slots.length}
                className={`day-pick ${d.key === day ? "is-active" : ""}`}
                onClick={() => setDay(d.key)}
              >
                <span className="day-pick-name">{fmtDate(d.date, { weekday: "short" })}</span>
                <span className="day-pick-num">{d.date.getDate()}</span>
                <span className="day-pick-count">
                  {d.slots.length ? (
                    <>
                      {d.slots.length}
                      <span className="open-word"> open</span>
                    </>
                  ) : (
                    "—"
                  )}
                </span>
              </button>
            ))}
          </div>
          {current && (
            <div className="day-times" aria-label={fmtDate(current.date, { weekday: "long", month: "long", day: "numeric" })}>
              {PARTS.map((part, i) => {
                const from = i === 0 ? 0 : PARTS[i - 1].until;
                const times = current.slots.filter((s) => {
                  const h = new Date(s).getHours();
                  return h >= from && h < part.until;
                });
                if (!times.length) return null;
                return (
                  <div key={part.label} className="time-group">
                    <h4>{part.label}</h4>
                    <div className="time-grid">
                      {times.map((s) => (
                        <button
                          key={s}
                          type="button"
                          className={`slot ${selected === s ? "is-selected" : ""}`}
                          aria-pressed={selected === s}
                          onClick={() => onSelect(s)}
                        >
                          {fmtTime(s)}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      <p className="muted small">
        Times shown in your time zone ({mine}).{tz && tz !== mine ? ` Your coach is on ${tz}.` : ""} Sessions are 1 hour, by video call unless your coach arranges otherwise.
      </p>
    </div>
  );
}
