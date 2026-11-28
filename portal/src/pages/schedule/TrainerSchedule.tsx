import { useEffect, useState } from "react";
import { Link } from "react-router";
import { collection, limit, orderBy, query, Timestamp, where } from "firebase/firestore";
import { call, db } from "../../firebase";
import { useSignedIn } from "../../auth";
import { useClients, useCredits, useTrainers } from "../../lib/data";
import { useLiveDoc, useLiveQuery } from "../../lib/useFirestore";
import { displayNameOf, fmtDateTime } from "../../lib/format";
import { Button, Card, ErrorNote, Loading, Modal, PageHeader, Select, Tabs, TextArea, useAction } from "../../components/ui";
import { SessionList } from "../../components/Sessions";
import SlotPicker from "../../components/SlotPicker";
import type { Availability, Session } from "../../types";

type Tab = "requests" | "upcoming" | "past";

export default function TrainerSchedule() {
  const { uid, role } = useSignedIn();
  const trainers = useTrainers();
  const [trainerId, setTrainerId] = useState(uid);
  const [tab, setTab] = useState<Tab>("requests");
  const [bookOpen, setBookOpen] = useState(false);
  const availability = useLiveDoc<Availability & { id: string }>(`availability/${trainerId}`);
  const now = Timestamp.now();

  const upcoming = useLiveQuery<Session>(
    () => query(collection(db, "sessions"), where("trainerId", "==", trainerId), where("start", ">=", now), orderBy("start"), limit(100)),
    [trainerId],
  );
  const past = useLiveQuery<Session>(
    () => query(collection(db, "sessions"), where("trainerId", "==", trainerId), where("start", "<", now), orderBy("start", "desc"), limit(50)),
    [trainerId],
  );

  const requests = upcoming.data.filter((s) => s.status === "requested");
  const confirmed = upcoming.data.filter((s) => s.status === "confirmed");
  const other = upcoming.data.filter((s) => s.status !== "requested" && s.status !== "confirmed");

  useEffect(() => {
    if (!upcoming.loading && tab === "requests" && requests.length === 0 && confirmed.length > 0) setTab("upcoming");
    // only on first load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcoming.loading]);

  const isOwn = trainerId === uid;
  return (
    <>
      <PageHeader
        title="Schedule"
        subtitle="Confirm requests, book clients and keep your calendar up to date."
        actions={
          <>
            {isOwn && <Link className="btn btn-secondary" to="/schedule/availability">Availability</Link>}
            {isOwn && <Button onClick={() => setBookOpen(true)} disabled={!availability.data}>Book a client</Button>}
          </>
        }
      />
      {role === "admin" && trainers.data.length > 1 && (
        <div className="filters">
          <select value={trainerId} onChange={(e) => setTrainerId(e.target.value)} aria-label="Coach">
            {trainers.data.map((t) => <option key={t.id} value={t.id}>{t.id === uid ? `${t.displayName} (you)` : t.displayName}</option>)}
          </select>
        </div>
      )}
      {isOwn && !availability.loading && !availability.data && (
        <div className="banner">
          Clients can't request sessions until you publish your hours. <Link to="/schedule/availability">Set availability</Link>
        </div>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "requests", label: "Requests", count: requests.length },
          { id: "upcoming", label: "Upcoming", count: confirmed.length },
          { id: "past", label: "Past" },
        ]}
      />
      {upcoming.error && <ErrorNote>{upcoming.error}</ErrorNote>}
      <Card>
        {upcoming.loading || past.loading ? (
          <Loading />
        ) : tab === "requests" ? (
          <SessionList sessions={requests} viewer="staff" showClient empty="No requests waiting." />
        ) : tab === "upcoming" ? (
          <SessionList sessions={confirmed} viewer="staff" showClient empty="No confirmed sessions coming up." />
        ) : (
          <SessionList sessions={[...past.data, ...other]} viewer="staff" showClient empty="No past sessions." />
        )}
      </Card>
      {isOwn && <BookModal open={bookOpen} onClose={() => setBookOpen(false)} trainerId={uid} />}
    </>
  );
}

function BookModal({ open, onClose, trainerId, clientId }: { open: boolean; onClose: () => void; trainerId: string; clientId?: string }) {
  const clients = useClients();
  const [client, setClient] = useState(clientId ?? "");
  const { credits } = useCredits(client || null);
  const [slot, setSlot] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [run, busy] = useAction();

  useEffect(() => {
    if (open) {
      setClient(clientId ?? "");
      setSlot(null);
      setNote("");
    }
  }, [open, clientId]);

  async function book() {
    if (!client || !slot) return;
    const ok = await run(() => call("bookSession", { clientId: client, start: slot, note: note.trim() || undefined }), "Session booked");
    if (ok) onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Book a session"
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button busy={busy} disabled={!client || !slot} onClick={book}>{slot ? `Book ${fmtDateTime(slot)}` : "Book"}</Button>
        </>
      }
    >
      <div className="stack">
        {!clientId && (
          <Select label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">Choose a client…</option>
            {clients.data.map((c) => <option key={c.id} value={c.id}>{displayNameOf(c)}</option>)}
          </Select>
        )}
        {client && (
          <p className={credits > 0 ? "muted small" : "error-note"}>
            {credits > 0
              ? `Uses 1 of ${credits} session credit${credits === 1 ? "" : "s"}.`
              : "This client has no session credits. The session will be booked without one — invoice it from their Billing tab."}
          </p>
        )}
        {open && <SlotPicker trainerId={trainerId} selected={slot} onSelect={setSlot} />}
        <TextArea label="Note (visible to the client)" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

export { BookModal };
