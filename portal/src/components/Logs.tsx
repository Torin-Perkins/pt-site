import { useState } from "react";
import { Link } from "react-router";
import { deleteDoc, doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
import { useSignedIn } from "../auth";
import { fmtDate } from "../lib/format";
import { Button, Empty, TextArea, useAction } from "./ui";
import type { MetricsLog, NutritionLog, WorkoutLog } from "../types";

export type LogKind = "workoutLogs" | "nutritionLogs" | "metrics";

/** Coach feedback: shown to everyone, editable by staff. */
function Feedback({ clientId, kind, log, staff }: { clientId: string; kind: LogKind; log: { id: string; trainerComment?: string }; staff: boolean }) {
  const { uid } = useSignedIn();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(log.trainerComment ?? "");
  const [run, busy] = useAction();

  if (!staff) {
    return log.trainerComment ? <p className="feedback"><strong>Coach:</strong> {log.trainerComment}</p> : null;
  }
  if (!editing) {
    return (
      <div className="feedback-row">
        {log.trainerComment && <p className="feedback"><strong>Your note:</strong> {log.trainerComment}</p>}
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>{log.trainerComment ? "Edit feedback" : "Leave feedback"}</Button>
      </div>
    );
  }
  return (
    <div className="stack-sm">
      <TextArea label="Feedback for the client" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
      <div className="row">
        <Button
          size="sm"
          busy={busy}
          onClick={async () => {
            const ok = await run(
              () => updateDoc(doc(db, "users", clientId, kind, log.id), { trainerComment: text.trim(), reviewedBy: uid, reviewedAt: serverTimestamp() }),
              "Feedback saved",
            );
            if (ok !== undefined) setEditing(false);
          }}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    </div>
  );
}

function DeleteLog({ clientId, kind, id }: { clientId: string; kind: LogKind; id: string }) {
  const [run, busy] = useAction();
  return (
    <Button
      size="sm"
      variant="ghost"
      busy={busy}
      onClick={() => {
        if (window.confirm("Delete this entry?")) run(() => deleteDoc(doc(db, "users", clientId, kind, id)), "Deleted");
      }}
    >
      Delete
    </Button>
  );
}

interface ListProps<T> {
  clientId: string;
  logs: T[];
  staff: boolean;
}

export function WorkoutLogList({ clientId, logs, staff }: ListProps<WorkoutLog>) {
  const { uid, role } = useSignedIn();
  if (!logs.length) return <Empty>No workouts logged yet.</Empty>;
  return (
    <ul className="log-list">
      {logs.map((l) => (
        <li key={l.id} className="log-card">
          <div className="log-head">
            <div>
              <div className="log-date">{fmtDate(l.date)}</div>
              <h3>{l.title || "Workout"}</h3>
            </div>
            <div className="log-badges">
              {l.status === "in_progress" && <span className="chip chip-live">In progress</span>}
              {l.durationMin ? <span className="chip">{l.durationMin} min</span> : null}
              {l.rpe ? <span className="chip">RPE {l.rpe}</span> : null}
            </div>
          </div>
          {l.exercises?.length > 0 && (
            <table className="mini-table">
              <tbody>
                {l.exercises.map((e, i) => (
                  <tr key={i}>
                    <th scope="row">{e.name}</th>
                    <td>
                      {e.sets.filter((s) => s.reps || s.weight).map((s) => [s.reps, s.weight].filter(Boolean).join(" × ")).join(", ") || "—"}
                      {e.notes ? <div className="muted small">{e.notes}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {l.notes && <p className="log-notes">{l.notes}</p>}
          {l.loggedBy && (
            <p className="muted small logged-by">
              Logged by {staff && l.loggedBy === uid ? "you" : l.loggedByName ?? "your coach"}
              {l.sessionId ? " during the session" : ""}
            </p>
          )}
          <Feedback clientId={clientId} kind="workoutLogs" log={l} staff={staff} />
          {!staff && !l.loggedBy && <div className="log-foot"><DeleteLog clientId={clientId} kind="workoutLogs" id={l.id} /></div>}
          {staff && l.loggedBy && (l.loggedBy === uid || role === "admin") && (
            <div className="log-foot">
              <Link className="btn btn-ghost btn-sm" to={`/clients/${clientId}/log/${l.id}`}>{l.status === "in_progress" ? "Continue logging" : "Edit"}</Link>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function NutritionLogList({ clientId, logs, staff }: ListProps<NutritionLog>) {
  if (!logs.length) return <Empty>No meals logged yet.</Empty>;
  return (
    <ul className="log-list">
      {logs.map((l) => (
        <li key={l.id} className="log-card">
          <div className="log-head">
            <div>
              <div className="log-date">{fmtDate(l.date)}</div>
              <h3>{l.meals?.length ?? 0} meal{l.meals?.length === 1 ? "" : "s"}</h3>
            </div>
            <div className="log-badges">
              {l.totals?.calories ? <span className="chip">{l.totals.calories} kcal</span> : null}
              {l.totals?.proteinG ? <span className="chip">{l.totals.proteinG} g protein</span> : null}
              {l.waterOz ? <span className="chip">{l.waterOz} oz water</span> : null}
            </div>
          </div>
          <ul className="meal-list">
            {l.meals?.map((m, i) => (
              <li key={i}>
                <strong>{m.name}</strong> {m.description && <span>— {m.description}</span>}
                {(m.calories || m.proteinG) && (
                  <span className="muted small"> ({[m.calories ? `${m.calories} kcal` : null, m.proteinG ? `${m.proteinG} g protein` : null].filter(Boolean).join(", ")})</span>
                )}
              </li>
            ))}
          </ul>
          {l.notes && <p className="log-notes">{l.notes}</p>}
          <Feedback clientId={clientId} kind="nutritionLogs" log={l} staff={staff} />
          {!staff && <div className="log-foot"><DeleteLog clientId={clientId} kind="nutritionLogs" id={l.id} /></div>}
        </li>
      ))}
    </ul>
  );
}

const SCALE = ["", "Very low", "Low", "OK", "Good", "Great"];

export function MetricsList({ clientId, logs, staff }: ListProps<MetricsLog>) {
  if (!logs.length) return <Empty>No check-ins yet.</Empty>;
  return (
    <ul className="log-list">
      {logs.map((l) => (
        <li key={l.id} className="log-card">
          <div className="log-head">
            <div>
              <div className="log-date">{fmtDate(l.date)}</div>
              <h3>Check-in</h3>
            </div>
          </div>
          <dl className="stats stats-sm">
            {l.weight != null && <div className="stat"><dt>Weight</dt><dd>{l.weight}<small>{l.unit ?? "lb"}</small></dd></div>}
            {l.waistIn != null && <div className="stat"><dt>Waist</dt><dd>{l.waistIn}<small>in</small></dd></div>}
            {l.hipsIn != null && <div className="stat"><dt>Hips</dt><dd>{l.hipsIn}<small>in</small></dd></div>}
            {l.sleepHours != null && <div className="stat"><dt>Sleep</dt><dd>{l.sleepHours}<small>h</small></dd></div>}
            {l.energy ? <div className="stat"><dt>Energy</dt><dd className="dd-text">{SCALE[l.energy]}</dd></div> : null}
            {l.mood ? <div className="stat"><dt>Mood</dt><dd className="dd-text">{SCALE[l.mood]}</dd></div> : null}
          </dl>
          {l.symptoms?.length ? <p className="small">Symptoms: {l.symptoms.join(", ")}</p> : null}
          {l.notes && <p className="log-notes">{l.notes}</p>}
          <Feedback clientId={clientId} kind="metrics" log={l} staff={staff} />
          {!staff && <div className="log-foot"><DeleteLog clientId={clientId} kind="metrics" id={l.id} /></div>}
        </li>
      ))}
    </ul>
  );
}

export { SCALE };
