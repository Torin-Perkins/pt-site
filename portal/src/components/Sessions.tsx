import { useState } from "react";
import { Link } from "react-router";
import { call } from "../firebase";
import { fmtDate, fmtTime } from "../lib/format";
import { useLiveDoc } from "../lib/useFirestore";
import type { Availability, Session } from "../types";
import { Badge, Button, Empty, Modal, TextArea, useAction } from "./ui";

/**
 * One row per session with the actions that make sense for the viewer:
 * clients can cancel; trainers confirm/decline, cancel, and mark complete.
 */
export function SessionList({
  sessions,
  viewer,
  empty = "No sessions.",
  showClient,
  showTrainer,
}: {
  sessions: Session[];
  viewer: "client" | "staff";
  empty?: string;
  showClient?: boolean;
  showTrainer?: boolean;
}) {
  if (!sessions.length) return <Empty>{empty}</Empty>;
  return (
    <ul className="session-list">
      {sessions.map((s) => (
        <SessionRow key={s.id} s={s} viewer={viewer} showClient={showClient} showTrainer={showTrainer} />
      ))}
    </ul>
  );
}

type Dialog = null | "decline" | "cancel" | "complete";

function SessionRow({ s, viewer, showClient, showTrainer }: { s: Session; viewer: "client" | "staff"; showClient?: boolean; showTrainer?: boolean }) {
  const [run, busy] = useAction();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [note, setNote] = useState("");
  const start = s.start.toDate();
  const future = start.getTime() > Date.now();
  const active = s.status === "requested" || s.status === "confirmed";

  const close = () => {
    setDialog(null);
    setNote("");
  };

  return (
    <li className="session-row">
      <div className="session-when">
        <span className="session-day">{fmtDate(start, { weekday: "short" })}</span>
        <span className="session-date">{fmtDate(start, { month: "short", day: "numeric" })}</span>
      </div>
      <div className="session-main">
        <div className="session-title">
          {fmtTime(start)} – {fmtTime(s.end)}
          <Badge status={s.status} />
          {s.lateCancellation && <Badge status="no_show">late cancel</Badge>}
          {viewer === "staff" && s.creditUsed === false && (s.status === "confirmed" || s.status === "completed" || s.status === "no_show") && (
            <Badge status="requested">no credit used</Badge>
          )}
        </div>
        <div className="session-meta">
          {showClient && <span>with {s.clientName ?? "client"}</span>}
          {showTrainer && <span>with {s.trainerName ?? "your coach"}</span>}
          {s.clientNote && <span className="quote">“{s.clientNote}”</span>}
          {s.trainerNote && <span className="quote">Coach: “{s.trainerNote}”</span>}
          {s.cancelReason && <span className="quote">Reason: “{s.cancelReason}”</span>}
        </div>
      </div>
      <div className="session-actions">
        {viewer === "staff" && s.status === "requested" && future && (
          <>
            <Button size="sm" busy={busy} onClick={() => run(() => call("respondToSession", { sessionId: s.id, action: "confirm" }), "Session confirmed")}>
              Confirm
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setDialog("decline")}>Decline</Button>
          </>
        )}
        {viewer === "staff" && (s.status === "confirmed" || s.status === "completed") && start.getTime() - Date.now() < 30 * 60_000 && (
          <Link className="btn btn-primary btn-sm" to={`/clients/${s.clientId}/log?session=${s.id}`}>
            {s.status === "completed" ? "Workout log" : "Log workout"}
          </Link>
        )}
        {viewer === "staff" && s.status === "confirmed" && !future && (
          <Button size="sm" variant="secondary" onClick={() => setDialog("complete")}>Mark done</Button>
        )}
        {active && future && (
          <Button size="sm" variant="ghost" onClick={() => setDialog("cancel")}>
            {viewer === "client" && s.status === "requested" ? "Withdraw" : "Cancel"}
          </Button>
        )}
      </div>

      <Modal
        open={dialog === "decline"}
        onClose={close}
        title="Decline request"
        footer={
          <>
            <Button variant="ghost" onClick={close}>Back</Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={async () => {
                await run(() => call("respondToSession", { sessionId: s.id, action: "decline", note: note || undefined }), "Request declined");
                close();
              }}
            >
              Decline
            </Button>
          </>
        }
      >
        <TextArea label="Message to the client (optional)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. That hour's taken — could you do 10am?" />
      </Modal>

      <Modal
        open={dialog === "cancel"}
        onClose={close}
        title="Cancel session"
        footer={
          <>
            <Button variant="ghost" onClick={close}>Keep it</Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={async () => {
                const res = await run(() => call<{ lateCancellation: boolean }>("cancelSession", { sessionId: s.id, reason: note || undefined }));
                if (res) close();
              }}
            >
              Cancel session
            </Button>
          </>
        }
      >
        <p>
          {fmtDate(start)} at {fmtTime(start)}
        </p>
        {dialog === "cancel" && <CreditNotice s={s} viewer={viewer} />}
        <TextArea label="Reason (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      </Modal>

      <Modal
        open={dialog === "complete"}
        onClose={close}
        title="How did it go?"
        footer={
          <>
            <Button
              variant="secondary"
              busy={busy}
              onClick={async () => {
                await run(() => call("completeSession", { sessionId: s.id, outcome: "no_show", note: note || undefined }), "Marked as no-show");
                close();
              }}
            >
              No-show
            </Button>
            <Button
              busy={busy}
              onClick={async () => {
                await run(() => call("completeSession", { sessionId: s.id, outcome: "completed", note: note || undefined }), "Session completed");
                close();
              }}
            >
              Completed
            </Button>
          </>
        }
      >
        <TextArea label="Session notes (visible to the client)" value={note} onChange={(e) => setNote(e.target.value)} />
      </Modal>
    </li>
  );
}

/** Tells the person cancelling whether the session credit comes back. */
function CreditNotice({ s, viewer }: { s: Session; viewer: "client" | "staff" }) {
  const avail = useLiveDoc<Availability & { id: string }>(viewer === "client" && s.status === "confirmed" ? `availability/${s.trainerId}` : null);
  if (!s.creditUsed) return null;
  if (viewer === "staff") return <p className="muted small">The client's session credit will be returned.</p>;
  if (s.status === "requested") return <p className="muted small">Your session credit will be returned.</p>;
  if (avail.loading) return null;
  const windowHours = avail.data?.cancellationWindowHours ?? 24;
  const late = s.start.toMillis() - Date.now() < windowHours * 3_600_000;
  return late ? (
    <p className="error-note">
      This is less than {windowHours} hours before the session, so it counts as a late cancellation and your session credit won't be returned.
    </p>
  ) : (
    <p className="muted small">Your session credit will be returned. (Cancellations within {windowHours} hours of a session keep the credit.)</p>
  );
}
