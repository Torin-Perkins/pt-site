import { useEffect, useState } from "react";
import { Link } from "react-router";
import { collection, orderBy, query, where, limit, Timestamp } from "firebase/firestore";
import { call, db } from "../../firebase";
import { useSignedIn } from "../../auth";
import { useCredits, useTrainers } from "../../lib/data";
import { useLiveQuery, useLiveDoc } from "../../lib/useFirestore";
import { fmtDateTime } from "../../lib/format";
import { Button, Card, Empty, Loading, PageHeader, Select, TextArea, useAction } from "../../components/ui";
import { SessionList } from "../../components/Sessions";
import SlotPicker from "../../components/SlotPicker";
import type { Availability, Session } from "../../types";

export default function ClientSchedule() {
  const { uid } = useSignedIn();
  const trainers = useTrainers();
  const { credits, loading: creditsLoading } = useCredits(uid);
  const [trainerId, setTrainerId] = useState("");
  const [slot, setSlot] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [run, busy] = useAction();
  const availability = useLiveDoc<Availability & { id: string }>(trainerId ? `availability/${trainerId}` : null);

  useEffect(() => {
    if (!trainerId && trainers.data.length) setTrainerId(trainers.data[0].id);
  }, [trainers.data, trainerId]);

  const now = Timestamp.now();
  const upcoming = useLiveQuery<Session>(
    () => query(collection(db, "sessions"), where("clientId", "==", uid), where("start", ">=", now), orderBy("start"), limit(30)),
    [uid],
  );
  const past = useLiveQuery<Session>(
    () => query(collection(db, "sessions"), where("clientId", "==", uid), where("start", "<", now), orderBy("start", "desc"), limit(20)),
    [uid],
  );

  async function request() {
    if (!slot) return;
    const ok = await run(() => call("requestSession", { trainerId, start: slot, note: note.trim() || undefined }), "Request sent — you'll see it here once your coach confirms.");
    if (ok) {
      setSlot(null);
      setNote("");
      setRefreshKey((k) => k + 1);
    }
  }

  const avail = availability.data;
  return (
    <>
      <PageHeader
        title="Schedule"
        subtitle="Request a 1-hour session. Your coach confirms each request."
        actions={
          <span className="credits-pill">
            <strong>{credits}</strong> session credit{credits === 1 ? "" : "s"} left
          </span>
        }
      />
      <Card title="Request a session">
        {trainers.loading || creditsLoading ? (
          <Loading />
        ) : credits < 1 ? (
          <div className="stack">
            <Empty>You don't have any session credits left. Each session uses one credit.</Empty>
            <div><Link className="btn btn-primary" to="/billing">Get session credits</Link></div>
          </div>
        ) : trainers.data.length === 0 ? (
          <Empty>No coaches are taking bookings yet.</Empty>
        ) : (
          <div className="stack">
            {trainers.data.length > 1 && (
              <Select label="Coach" value={trainerId} onChange={(e) => { setTrainerId(e.target.value); setSlot(null); }}>
                {trainers.data.map((t) => <option key={t.id} value={t.id}>{t.displayName}</option>)}
              </Select>
            )}
            {trainerId && !availability.loading && !avail ? (
              <Empty>This coach hasn't opened up their calendar yet.</Empty>
            ) : avail?.acceptingRequests === false ? (
              <Empty>This coach isn't taking new requests right now.</Empty>
            ) : trainerId ? (
              <>
                <SlotPicker trainerId={trainerId} selected={slot} onSelect={setSlot} refreshKey={refreshKey} />
                {avail && (
                  <p className="muted small">
                    Book at least {avail.minNoticeHours ?? 12} hours ahead. Cancellations with less than {avail.cancellationWindowHours ?? 24} hours' notice may be charged.
                  </p>
                )}
              </>
            ) : null}
            {slot && (
              <div className="request-box">
                <p><strong>{fmtDateTime(slot)}</strong> · 1 hour · uses 1 of your {credits} credit{credits === 1 ? "" : "s"}</p>
                <TextArea label="Anything your coach should know? (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
                <div className="row">
                  <Button busy={busy} onClick={request}>Request this time</Button>
                  <Button variant="ghost" onClick={() => setSlot(null)}>Clear</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
      <Card title="Your sessions">
        {upcoming.loading ? <Loading /> : <SessionList sessions={upcoming.data.filter((s) => s.status !== "cancelled")} viewer="client" showTrainer empty="Nothing booked yet." />}
      </Card>
      <Card title="Past & cancelled">
        {past.loading ? (
          <Loading />
        ) : (
          <SessionList
            sessions={[...upcoming.data.filter((s) => s.status === "cancelled"), ...past.data]}
            viewer="client"
            showTrainer
            empty="No past sessions."
          />
        )}
      </Card>
    </>
  );
}
