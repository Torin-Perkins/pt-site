import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { call, db, errorMessage } from "../../firebase";
import { useSignedIn } from "../../auth";
import { useLiveDoc, useLiveQuery } from "../../lib/useFirestore";
import { useWorkouts } from "../../lib/data";
import { displayNameOf, fmtDateTime, fmtTime, isoDay, num } from "../../lib/format";
import { Button, Card, Empty, ErrorNote, Loading, PageHeader, Select, TextArea, TextInput, useAction, useToast } from "../../components/ui";
import { LastTimeHint } from "../log/WorkoutLogForm";
import { useLastTime, type LastTime } from "../../lib/lastTime";
import type { Assignment, Exercise, LoggedExercise, Session, UserProfile, Workout, WorkoutLog } from "../../types";

/*
 * A coach logs a client's workout live during a session. The log is created
 * when they start and saved automatically as they go (so a locked tablet or a
 * closed tab loses nothing); "Finish" marks it completed and, for a session,
 * marks the session done too.
 */

const AUTOSAVE_MS = 1200;

/** Last time's weight for set k (repeats the last set when there were fewer). */
const lastWeightOf = (last: LastTime | null, k: number) => (last ? last.sets[Math.min(k, last.sets.length - 1)]?.weight ?? "" : "");

function targetOf(e: Exercise): string {
  return [e.sets && e.reps ? `${e.sets} × ${e.reps}` : e.sets ? `${e.sets} sets` : e.reps, e.weight, e.restSec ? `rest ${e.restSec}s` : null]
    .filter(Boolean)
    .join(" · ");
}

function fromTemplate(w: Workout): LoggedExercise[] {
  return (w.exercises ?? []).map((e) => ({
    name: e.name,
    target: targetOf(e),
    notes: "",
    sets: Array.from({ length: Math.max(1, Math.min(e.sets ?? 1, 10)) }, () => ({ reps: e.reps ?? "", weight: "", done: false })),
  }));
}

function elapsed(fromMs: number, now: number) {
  const s = Math.max(0, Math.floor((now - fromMs) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export default function LiveWorkoutLog() {
  const { clientId = "", logId } = useParams();
  return logId ? <Logger clientId={clientId} logId={logId} /> : <StartLog clientId={clientId} />;
}

// ------------------------------------------------------------------ start

function StartLog({ clientId }: { clientId: string }) {
  const { uid, profile, user } = useSignedIn();
  const [params] = useSearchParams();
  const sessionId = params.get("session");
  const navigate = useNavigate();
  const [run, busy] = useAction();
  const [checking, setChecking] = useState(Boolean(sessionId));
  const client = useLiveDoc<UserProfile>(`users/${clientId}`);
  const session = useLiveDoc<Session>(sessionId ? `sessions/${sessionId}` : null);
  const workouts = useWorkouts(true);
  const assignments = useLiveQuery<Assignment>(
    () => query(collection(db, "assignments"), where("clientId", "==", clientId), orderBy("dueDate", "desc"), limit(20)),
    [clientId],
  );
  const [template, setTemplate] = useState("");

  // One log per session: reopen it if the coach already started.
  useEffect(() => {
    if (!sessionId) return;
    getDocs(query(collection(db, "users", clientId, "workoutLogs"), where("sessionId", "==", sessionId), limit(1)))
      .then((snap) => {
        if (!snap.empty) navigate(`/clients/${clientId}/log/${snap.docs[0].id}`, { replace: true });
        else setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [clientId, sessionId, navigate]);

  const todo = assignments.data.filter((a) => !a.completedAt);
  const chosen = workouts.data.find((w) => w.id === template);

  async function start() {
    const id = await run(async () => {
      const ref = await addDoc(collection(db, "users", clientId, "workoutLogs"), {
        date: session.data ? isoDay(session.data.start.toDate()) : isoDay(),
        title: chosen?.title ?? "Coached session",
        workoutId: chosen?.id ?? null,
        sessionId: sessionId ?? null,
        exercises: chosen ? fromTemplate(chosen) : [{ name: "", target: "", notes: "", sets: [{ reps: "", weight: "", done: false }] }],
        durationMin: null,
        rpe: null,
        notes: "",
        status: "in_progress",
        loggedBy: uid,
        loggedByName: displayNameOf(profile ?? { email: user.email }),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return ref.id;
    });
    if (id) navigate(`/clients/${clientId}/log/${id}`, { replace: true });
  }

  if (checking || client.loading) return <Loading />;
  if (!client.data) return <Empty>Client not found.</Empty>;

  return (
    <>
      <p className="crumbs"><Link to={`/clients/${clientId}?tab=workouts`}>← {displayNameOf(client.data)}</Link></p>
      <PageHeader
        title={`Log a workout for ${displayNameOf(client.data)}`}
        subtitle={session.data ? `Session ${fmtDateTime(session.data.start)}` : "Not tied to a booked session"}
      />
      <Card>
        <div className="stack">
          <Select label="Start from" value={template} onChange={(e) => setTemplate(e.target.value)} hint="Exercises and sets are filled in from the workout; change anything as you go.">
            <option value="">Blank workout</option>
            {todo.length > 0 && (
              <optgroup label="Assigned to this client">
                {todo.map((a) => (
                  <option key={a.id} value={a.workoutId}>{a.workoutTitle ?? "Workout"}</option>
                ))}
              </optgroup>
            )}
            <optgroup label="Workout library">
              {workouts.data.map((w) => (
                <option key={w.id} value={w.id}>{w.title}{w.published ? "" : " (draft)"}</option>
              ))}
            </optgroup>
          </Select>
          <div>
            <Button busy={busy} onClick={start}>Start logging</Button>
          </div>
        </div>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ logger

type Draft = Pick<WorkoutLog, "title" | "exercises" | "notes"> & { rpe: string; durationMin: string };

function Logger({ clientId, logId }: { clientId: string; logId: string }) {
  const { uid, role } = useSignedIn();
  const navigate = useNavigate();
  const toast = useToast();
  const [run, busy] = useAction();
  const client = useLiveDoc<UserProfile>(`users/${clientId}`);
  const [log, setLog] = useState<WorkoutLog | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const session = useLiveDoc<Session>(log?.sessionId ? `sessions/${log.sessionId}` : null);
  const workouts = useWorkouts(true);
  const history = useLastTime(clientId, logId);
  const [now, setNow] = useState(Date.now());
  const [saveState, setSaveState] = useState<{ status: "saved" | "saving" | "error"; at?: Date; message?: string }>({ status: "saved" });
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const ref = useMemo(() => doc(db, "users", clientId, "workoutLogs", logId), [clientId, logId]);

  useEffect(() => {
    getDoc(ref)
      .then((snap) => {
        if (!snap.exists()) return setLoadError("This log doesn't exist any more.");
        const l = { id: snap.id, ...snap.data() } as WorkoutLog;
        setLog(l);
        setDraft({
          title: l.title,
          exercises: l.exercises?.length ? l.exercises : [{ name: "", sets: [{ reps: "", weight: "", done: false }] }],
          notes: l.notes ?? "",
          rpe: l.rpe?.toString() ?? "",
          durationMin: l.durationMin?.toString() ?? "",
        });
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, [ref]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const payload = (d: Draft) => ({
    title: d.title.trim() || "Coached session",
    exercises: d.exercises
      .filter((e) => e.name.trim() || e.sets.some((s) => s.reps || s.weight))
      .map((e) => ({
        name: e.name.trim() || "Exercise",
        target: e.target ?? "",
        notes: e.notes?.trim() ?? "",
        sets: e.sets.map((s) => ({ reps: s.reps?.trim() ?? "", weight: s.weight?.trim() ?? "", done: Boolean(s.done) })),
      })),
    notes: d.notes?.trim() ?? "",
    rpe: num(d.rpe),
    durationMin: num(d.durationMin),
    updatedAt: serverTimestamp(),
  });

  const latest = useRef<Draft | null>(null);
  latest.current = draft;

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (!dirty.current || !latest.current) return;
    dirty.current = false;
    setSaveState({ status: "saving" });
    try {
      await updateDoc(ref, payload(latest.current));
      setSaveState({ status: "saved", at: new Date() });
    } catch (err) {
      dirty.current = true;
      setSaveState({ status: "error", message: errorMessage(err) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);

  // Save shortly after each change, and right away when the tab is hidden or closed.
  const edit = (fn: (d: Draft) => Draft) => {
    setDraft((d) => (d ? fn(d) : d));
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
  };
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && void flush();
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        void flush();
        e.preventDefault();
      }
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
      void flush();
    };
  }, [flush]);

  if (loadError) return <ErrorNote>{loadError}</ErrorNote>;
  if (!log || !draft) return <Loading />;
  const canEdit = log.loggedBy === uid || role === "admin";
  if (!canEdit) return <ErrorNote>This workout was logged by another coach.</ErrorNote>;

  const started = session.data?.start.toMillis() ?? log.createdAt?.toMillis() ?? now;
  const setEx = (i: number, fn: (e: LoggedExercise) => LoggedExercise) => edit((d) => ({ ...d, exercises: d.exercises.map((x, j) => (j === i ? fn(x) : x)) }));
  const setSet = (i: number, k: number, patch: Partial<LoggedExercise["sets"][number]>) =>
    setEx(i, (e) => ({ ...e, sets: e.sets.map((s, m) => (m === k ? { ...s, ...patch } : s)) }));
  const doneSets = draft.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done).length, 0);
  const totalSets = draft.exercises.reduce((n, e) => n + e.sets.length, 0);
  const exerciseNames = [...new Set(workouts.data.flatMap((w) => w.exercises?.map((e) => e.name) ?? []))].sort();
  const finished = log.status === "completed";

  async function finish() {
    const minutes = draft!.durationMin || String(Math.max(1, Math.round((Date.now() - started) / 60000)));
    edit((d) => ({ ...d, durationMin: minutes }));
    const ok = await run(async () => {
      window.clearTimeout(timer.current);
      dirty.current = false;
      await updateDoc(ref, { ...payload({ ...draft!, durationMin: minutes }), status: "completed" });
      const s = session.data;
      if (s && s.status === "confirmed" && s.start.toMillis() <= Date.now()) {
        await call("completeSession", { sessionId: s.id, outcome: "completed" });
      }
      return true;
    });
    if (ok) {
      toast("Workout saved to the client's log", "success");
      navigate(`/clients/${clientId}?tab=workouts`);
    }
  }

  async function discard() {
    if (!window.confirm("Delete this workout log? This can't be undone.")) return;
    window.clearTimeout(timer.current);
    dirty.current = false;
    const ok = await run(() => deleteDoc(ref).then(() => true), "Log deleted");
    if (ok) navigate(`/clients/${clientId}?tab=workouts`);
  }

  return (
    <div className="live-log">
      <p className="crumbs"><Link to={`/clients/${clientId}?tab=workouts`}>← {client.data ? displayNameOf(client.data) : "Client"}</Link></p>
      <div className="live-head">
        <div>
          <span className="eyebrow">{finished ? "Logged workout" : "Live session"}</span>
          <input
            className="live-title"
            aria-label="Workout name"
            value={draft.title}
            onChange={(e) => edit((d) => ({ ...d, title: e.target.value }))}
          />
          <p className="muted small">
            {client.data ? displayNameOf(client.data) : ""}
            {session.data ? ` · ${fmtTime(session.data.start)} – ${fmtTime(session.data.end)}` : ""}
          </p>
        </div>
        <div className="live-stats">
          {!finished && (
            <div className="live-timer" aria-label="Time since start">
              {elapsed(started, now)}
            </div>
          )}
          <div className="muted small">{doneSets}/{totalSets} sets done</div>
          <div className={`save-state save-${saveState.status}`} role="status">
            {saveState.status === "saving" ? "Saving…" : saveState.status === "error" ? `Not saved — ${saveState.message}` : saveState.at ? `Saved ${fmtTime(saveState.at)}` : "Saved"}
          </div>
        </div>
      </div>

      <ol className="live-exercises">
        {draft.exercises.map((e, i) => (
          <li key={i} className="live-exercise">
            <div className="live-ex-head">
              <span className="exercise-num">{i + 1}</span>
              <input
                className="live-ex-name"
                aria-label={`Exercise ${i + 1} name`}
                placeholder="Exercise"
                list="exercise-names"
                value={e.name}
                onChange={(ev) => setEx(i, (x) => ({ ...x, name: ev.target.value }))}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove exercise ${i + 1}`}
                onClick={() => window.confirm(`Remove ${e.name || "this exercise"}?`) && edit((d) => ({ ...d, exercises: d.exercises.filter((_, j) => j !== i) }))}
              >
                ×
              </button>
            </div>
            {e.target && <p className="live-target">Plan: {e.target}</p>}
            <div className="live-last">
              <LastTimeHint
                last={history.lookup(e.name)}
                onUse={(last) => setEx(i, (x) => ({ ...x, sets: x.sets.map((y, m) => (y.weight ? y : { ...y, weight: lastWeightOf(last, m) })) }))}
              />
            </div>
            <div className="live-sets">
              {e.sets.map((s, k) => (
                <div key={k} className={`live-set ${s.done ? "is-done" : ""}`}>
                  <span className="live-set-num">{k + 1}</span>
                  <label>
                    <span className="sr-only">Set {k + 1} reps</span>
                    <input inputMode="numeric" placeholder="reps" value={s.reps ?? ""} onChange={(ev) => setSet(i, k, { reps: ev.target.value })} />
                  </label>
                  <span className="live-x">×</span>
                  <label>
                    <span className="sr-only">Set {k + 1} weight</span>
                    <input inputMode="decimal" placeholder={lastWeightOf(history.lookup(e.name), k) || "lb"} value={s.weight ?? ""} onChange={(ev) => setSet(i, k, { weight: ev.target.value })} />
                  </label>
                  <button
                    type="button"
                    className="done-btn"
                    aria-pressed={Boolean(s.done)}
                    aria-label={`Set ${k + 1} ${s.done ? "done" : "not done"}`}
                    onClick={() => setSet(i, k, { done: !s.done })}
                  >
                    ✓
                  </button>
                  {e.sets.length > 1 && (
                    <button type="button" className="icon-btn" aria-label={`Remove set ${k + 1}`} onClick={() => setEx(i, (x) => ({ ...x, sets: x.sets.filter((_, m) => m !== k) }))}>
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="row">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setEx(i, (x) => ({ ...x, sets: [...x.sets, { ...(x.sets[x.sets.length - 1] ?? {}), done: false }] }))}
              >
                + Set
              </Button>
              <input
                className="live-ex-notes"
                aria-label={`Notes for exercise ${i + 1}`}
                placeholder="Notes (form, pain, swaps…)"
                value={e.notes ?? ""}
                onChange={(ev) => setEx(i, (x) => ({ ...x, notes: ev.target.value }))}
              />
            </div>
          </li>
        ))}
      </ol>
      <datalist id="exercise-names">{exerciseNames.map((n) => <option key={n} value={n} />)}</datalist>
      <Button variant="secondary" onClick={() => edit((d) => ({ ...d, exercises: [...d.exercises, { name: "", target: "", notes: "", sets: [{ reps: "", weight: "", done: false }] }] }))}>
        + Add exercise
      </Button>

      <Card title="Wrap up" className="live-wrap">
        <div className="form-grid">
          <Select label="Effort (RPE)" value={draft.rpe} onChange={(e) => edit((d) => ({ ...d, rpe: e.target.value }))} hint="How hard it felt for the client, 1–10">
            <option value="">—</option>
            {Array.from({ length: 10 }, (_, n) => n + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
          <TextInput
            label="Minutes"
            type="number"
            min={0}
            value={draft.durationMin}
            onChange={(e) => edit((d) => ({ ...d, durationMin: e.target.value }))}
            hint={finished ? undefined : "Left blank, it's filled from the timer when you finish."}
          />
          <TextArea label="Session notes (the client sees these)" className="span-2" value={draft.notes ?? ""} onChange={(e) => edit((d) => ({ ...d, notes: e.target.value }))} maxLength={4000} />
        </div>
        <div className="row live-actions">
          <Button busy={busy} onClick={finish}>{finished ? "Save changes" : session.data?.status === "confirmed" ? "Finish session" : "Finish"}</Button>
          <Button variant="ghost" onClick={discard}>Delete log</Button>
        </div>
        {!finished && session.data?.status === "confirmed" && (
          <p className="muted small">Finishing also marks the session as completed.</p>
        )}
      </Card>
    </div>
  );
}
