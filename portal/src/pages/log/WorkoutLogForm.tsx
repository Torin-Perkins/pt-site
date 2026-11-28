import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { addDoc, collection, doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { useSignedIn } from "../../auth";
import { isoDay, num } from "../../lib/format";
import { Button, Card, Loading, PageHeader, Select, TextArea, TextInput, useAction } from "../../components/ui";
import type { LoggedExercise, Workout } from "../../types";
import { lastTimeLabel, useLastTime, type LastTime } from "../../lib/lastTime";

/** Last time's weight for set k (repeats the last set when there were fewer). */
const lastWeight = (last: LastTime | null, k: number) => (last ? last.sets[Math.min(k, last.sets.length - 1)]?.weight ?? "" : "");

export default function WorkoutLogForm() {
  const { uid } = useSignedIn();
  const [params] = useSearchParams();
  const workoutId = params.get("workout");
  const assignmentId = params.get("assignment");
  const navigate = useNavigate();
  const [run, busy] = useAction();
  const [loading, setLoading] = useState(Boolean(workoutId));

  const [date, setDate] = useState(isoDay());
  const [title, setTitle] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [rpe, setRpe] = useState("");
  const [notes, setNotes] = useState("");
  const [exercises, setExercises] = useState<LoggedExercise[]>([{ name: "", sets: [{ reps: "", weight: "" }] }]);

  useEffect(() => {
    if (!workoutId) return;
    getDoc(doc(db, "workouts", workoutId))
      .then((snap) => {
        const w = snap.data() as Workout | undefined;
        if (w) {
          setTitle(w.title);
          setDurationMin(w.durationMin?.toString() ?? "");
          setExercises(
            w.exercises.map((e) => ({
              name: e.name,
              sets: Array.from({ length: Math.max(1, Math.min(e.sets ?? 1, 10)) }, () => ({ reps: e.reps ?? "", weight: "" })),
            })),
          );
        }
      })
      .finally(() => setLoading(false));
  }, [workoutId]);

  const setEx = (i: number, fn: (e: LoggedExercise) => LoggedExercise) => setExercises((xs) => xs.map((x, j) => (j === i ? fn(x) : x)));
  const history = useLastTime(uid);

  async function save(e: FormEvent) {
    e.preventDefault();
    const ok = await run(async () => {
      const ref = await addDoc(collection(db, "users", uid, "workoutLogs"), {
        date,
        title: title.trim() || "Workout",
        workoutId: workoutId ?? null,
        assignmentId: assignmentId ?? null,
        durationMin: num(durationMin),
        rpe: num(rpe),
        exercises: exercises
          .filter((x) => x.name.trim())
          .map((x) => ({ name: x.name.trim(), sets: x.sets.map((s) => ({ reps: s.reps?.trim() ?? "", weight: s.weight?.trim() ?? "" })) })),
        notes: notes.trim(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      if (assignmentId) {
        await updateDoc(doc(db, "assignments", assignmentId), { completedAt: serverTimestamp(), completedLogId: ref.id, updatedAt: serverTimestamp() });
      }
      return true;
    }, "Workout logged — nice work!");
    if (ok) navigate("/log");
  }

  if (loading) return <Loading />;

  return (
    <form onSubmit={save}>
      <p className="crumbs"><Link to={workoutId ? `/workouts/${workoutId}` : "/log"}>← Back</Link></p>
      <PageHeader title="Log a workout" actions={<Button type="submit" busy={busy}>Save</Button>} />
      <Card>
        <div className="form-grid form-grid-4">
          <TextInput label="Workout" className="span-2" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Lower body + walk" required />
          <TextInput label="Date" type="date" value={date} max={isoDay()} onChange={(e) => setDate(e.target.value)} required />
          <TextInput label="Minutes" type="number" min={0} value={durationMin} onChange={(e) => setDurationMin(e.target.value)} />
          <Select label="Effort (RPE)" value={rpe} onChange={(e) => setRpe(e.target.value)} hint="1 = very easy, 10 = all-out">
            <option value="">—</option>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </div>
      </Card>

      <Card title="What you did" actions={<Button size="sm" variant="secondary" onClick={() => setExercises((x) => [...x, { name: "", sets: [{ reps: "", weight: "" }] }])}>Add exercise</Button>}>
        <ol className="exercise-editor">
          {exercises.map((x, i) => (
            <li key={i} className="exercise-edit">
              <div className="exercise-edit-head">
                <span className="exercise-num">{i + 1}</span>
                <TextInput label="Exercise" className="grow" value={x.name} onChange={(e) => setEx(i, (ex) => ({ ...ex, name: e.target.value }))} />
                <button type="button" className="icon-btn" aria-label="Remove exercise" onClick={() => setExercises((xs) => xs.filter((_, j) => j !== i))}>×</button>
              </div>
              <LastTimeHint
                last={history.lookup(x.name)}
                onUse={(last) => setEx(i, (ex) => ({ ...ex, sets: ex.sets.map((y, m) => (y.weight ? y : { ...y, weight: lastWeight(last, m) })) }))}
              />
              <table className="set-table">
                <thead>
                  <tr><th>Set</th><th>Reps / time</th><th>Weight</th><th /></tr>
                </thead>
                <tbody>
                  {x.sets.map((s, k) => (
                    <tr key={k}>
                      <td>{k + 1}</td>
                      <td><input aria-label={`Set ${k + 1} reps`} value={s.reps} onChange={(e) => setEx(i, (ex) => ({ ...ex, sets: ex.sets.map((y, m) => (m === k ? { ...y, reps: e.target.value } : y)) }))} /></td>
                      <td><input aria-label={`Set ${k + 1} weight`} value={s.weight} placeholder={lastWeight(history.lookup(x.name), k) || "lb"} onChange={(e) => setEx(i, (ex) => ({ ...ex, sets: ex.sets.map((y, m) => (m === k ? { ...y, weight: e.target.value } : y)) }))} /></td>
                      <td>
                        {x.sets.length > 1 && (
                          <button type="button" className="icon-btn" aria-label={`Remove set ${k + 1}`} onClick={() => setEx(i, (ex) => ({ ...ex, sets: ex.sets.filter((_, m) => m !== k) }))}>×</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Button size="sm" variant="ghost" onClick={() => setEx(i, (ex) => ({ ...ex, sets: [...ex.sets, { ...(ex.sets[ex.sets.length - 1] ?? { reps: "", weight: "" }) }] }))}>+ Add set</Button>
            </li>
          ))}
        </ol>
      </Card>
      <Card>
        <TextArea label="How did it feel?" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Energy, anything that hurt, wins…" maxLength={4000} />
      </Card>
      <div className="form-foot"><Button type="submit" busy={busy}>Save workout</Button></div>
    </form>
  );
}

/** "Last time (Nov 12): 10 × 25, 10 × 30" with a button to copy the weights in. */
export function LastTimeHint({ last, onUse }: { last: LastTime | null; onUse: (last: LastTime) => void }) {
  if (!last) return null;
  const hasWeights = last.sets.some((s) => s.weight);
  return (
    <div className="last-time">
      <span>{lastTimeLabel(last)}</span>
      {hasWeights && (
        <Button size="sm" variant="ghost" onClick={() => onUse(last)}>
          Use last weights
        </Button>
      )}
    </div>
  );
}
