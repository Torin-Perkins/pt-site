import { useEffect, useState } from "react";
import { Link } from "react-router";
import { doc, getDoc } from "firebase/firestore";
import { call, db } from "../../firebase";
import { useSignedIn } from "../../auth";
import { browserTimeZone, fmtDate, isoDay } from "../../lib/format";
import { Button, Card, Checkbox, Loading, PageHeader, Select, TextInput, useAction } from "../../components/ui";
import { WEEKDAYS, type Availability, type TimeWindow, type Weekday } from "../../types";

const DAY_NAMES: Record<Weekday, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};

const ZONES = ["America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago", "America/New_York", "America/Anchorage", "Pacific/Honolulu"];

const DEFAULT: Availability = {
  timezone: "America/Los_Angeles",
  weekly: {
    mon: [{ start: "06:00", end: "12:00" }],
    tue: [{ start: "06:00", end: "12:00" }],
    wed: [{ start: "06:00", end: "12:00" }],
    thu: [{ start: "06:00", end: "12:00" }],
    fri: [{ start: "06:00", end: "12:00" }],
  },
  blackoutDates: [],
  minNoticeHours: 12,
  maxDaysAhead: 60,
  cancellationWindowHours: 24,
  acceptingRequests: true,
  slotStepMinutes: 15,
};

export default function AvailabilityEditor() {
  const { uid } = useSignedIn();
  const [run, busy] = useAction();
  const [loading, setLoading] = useState(true);
  const [a, setA] = useState<Availability>(DEFAULT);
  const [isNew, setIsNew] = useState(false);
  const [blackout, setBlackout] = useState("");

  useEffect(() => {
    getDoc(doc(db, "availability", uid)).then((snap) => {
      if (snap.exists()) {
        const d = snap.data() as Availability;
        setA({ ...DEFAULT, ...d, weekly: d.weekly ?? {} });
      } else {
        setIsNew(true);
      }
      setLoading(false);
    });
  }, [uid]);

  const setDay = (day: Weekday, windows: TimeWindow[]) => setA((x) => ({ ...x, weekly: { ...x.weekly, [day]: windows } }));

  async function save() {
    const weekly: Availability["weekly"] = {};
    for (const d of WEEKDAYS) {
      const w = (a.weekly[d] ?? []).filter((x) => x.start && x.end);
      if (w.length) weekly[d] = w;
    }
    const ok = await run(
      () =>
        call("setAvailability", {
          timezone: a.timezone,
          weekly,
          blackoutDates: (a.blackoutDates ?? []).filter((d) => d >= isoDay()),
          minNoticeHours: a.minNoticeHours,
          maxDaysAhead: a.maxDaysAhead,
          cancellationWindowHours: a.cancellationWindowHours,
          acceptingRequests: a.acceptingRequests !== false,
          slotStepMinutes: a.slotStepMinutes ?? 15,
        }),
      "Availability saved",
    );
    if (ok) setIsNew(false);
  }

  if (loading) return <Loading />;
  const zones = ZONES.includes(a.timezone) ? ZONES : [a.timezone, ...ZONES];
  if (!zones.includes(browserTimeZone())) zones.push(browserTimeZone());

  return (
    <>
      <p className="crumbs"><Link to="/schedule">← Schedule</Link></p>
      <PageHeader
        title="Availability"
        subtitle="Clients can request any 1-hour block that fits inside these hours."
        actions={<Button busy={busy} onClick={save}>{isNew ? "Publish hours" : "Save"}</Button>}
      />
      <Card title="Weekly hours">
        <ul className="week-editor">
          {WEEKDAYS.map((d) => {
            const windows = a.weekly[d] ?? [];
            return (
              <li key={d} className="day-row">
                <div className="day-row-name">
                  <Checkbox
                    label={DAY_NAMES[d]}
                    checked={windows.length > 0}
                    onChange={(on) => setDay(d, on ? [{ start: "06:00", end: "12:00" }] : [])}
                  />
                </div>
                <div className="day-row-windows">
                  {windows.length === 0 && <span className="muted small">Unavailable</span>}
                  {windows.map((w, i) => (
                    <div key={i} className="window">
                      <input type="time" step={3600} aria-label={`${DAY_NAMES[d]} start`} value={w.start} onChange={(e) => setDay(d, windows.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                      <span>to</span>
                      <input type="time" step={3600} aria-label={`${DAY_NAMES[d]} end`} value={w.end} onChange={(e) => setDay(d, windows.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                      <button type="button" className="icon-btn" aria-label="Remove hours" onClick={() => setDay(d, windows.filter((_, j) => j !== i))}>×</button>
                    </div>
                  ))}
                  {windows.length > 0 && (
                    <button type="button" className="link small" onClick={() => setDay(d, [...windows, { start: "16:00", end: "19:00" }])}>+ add hours</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <div className="grid-2">
        <Card title="Booking rules">
          <div className="stack">
            <Select label="Time zone" value={a.timezone} onChange={(e) => setA({ ...a, timezone: e.target.value })}>
              {zones.map((z) => <option key={z}>{z}</option>)}
            </Select>
            <Select
              label="Session start times"
              value={a.slotStepMinutes ?? 15}
              onChange={(e) => setA({ ...a, slotStepMinutes: Number(e.target.value) as 15 | 30 | 60 })}
              hint="Sessions are always 1 hour; this is how often they can start (e.g. 9:00, 9:15, 9:30…)."
            >
              <option value={15}>Every 15 minutes</option>
              <option value={30}>Every 30 minutes</option>
              <option value={60}>On the hour</option>
            </Select>
            <TextInput label="Minimum notice (hours)" type="number" min={0} value={a.minNoticeHours ?? 12} onChange={(e) => setA({ ...a, minNoticeHours: Number(e.target.value) })} />
            <TextInput label="Bookable up to (days ahead)" type="number" min={1} max={365} value={a.maxDaysAhead ?? 60} onChange={(e) => setA({ ...a, maxDaysAhead: Number(e.target.value) })} />
            <TextInput
              label="Late-cancellation window (hours)"
              type="number"
              min={0}
              value={a.cancellationWindowHours ?? 24}
              onChange={(e) => setA({ ...a, cancellationWindowHours: Number(e.target.value) })}
              hint="Client cancellations closer than this are flagged so you can bill them."
            />
            <Checkbox label="Accepting new requests" checked={a.acceptingRequests !== false} onChange={(v) => setA({ ...a, acceptingRequests: v })} />
          </div>
        </Card>
        <Card title="Days off">
          <div className="row">
            <TextInput label="Add a date" type="date" min={isoDay()} value={blackout} onChange={(e) => setBlackout(e.target.value)} />
            <Button
              variant="secondary"
              disabled={!blackout}
              onClick={() => {
                setA({ ...a, blackoutDates: [...new Set([...(a.blackoutDates ?? []), blackout])].sort() });
                setBlackout("");
              }}
            >
              Add
            </Button>
          </div>
          <ul className="chips">
            {(a.blackoutDates ?? []).filter((d) => d >= isoDay()).map((d) => (
              <li key={d} className="chip">
                {fmtDate(d)}
                <button type="button" aria-label={`Remove ${d}`} onClick={() => setA({ ...a, blackoutDates: (a.blackoutDates ?? []).filter((x) => x !== d) })}>×</button>
              </li>
            ))}
          </ul>
          <p className="muted small">Remember to save. Existing sessions on these days aren't cancelled automatically.</p>
        </Card>
      </div>
    </>
  );
}
