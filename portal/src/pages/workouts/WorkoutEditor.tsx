import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { addDoc, collection, doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { useSignedIn } from "../../auth";
import { LEVELS, WORKOUT_CATEGORIES } from "../../lib/data";
import { num } from "../../lib/format";
import { Button, Card, Checkbox, ErrorNote, Loading, PageHeader, Select, TextArea, TextInput, useAction } from "../../components/ui";
import type { Exercise, Workout } from "../../types";

interface ExerciseDraft {
  name: string;
  sets: string;
  reps: string;
  weight: string;
  restSec: string;
  notes: string;
  videoUrl: string;
}

const blankExercise = (): ExerciseDraft => ({ name: "", sets: "3", reps: "10", weight: "", restSec: "60", notes: "", videoUrl: "" });

const toDraft = (e: Exercise): ExerciseDraft => ({
  name: e.name,
  sets: e.sets?.toString() ?? "",
  reps: e.reps ?? "",
  weight: e.weight ?? "",
  restSec: e.restSec?.toString() ?? "",
  notes: e.notes ?? "",
  videoUrl: e.videoUrl ?? "",
});

const fromDraft = (e: ExerciseDraft): Exercise => ({
  name: e.name.trim(),
  sets: num(e.sets),
  reps: e.reps.trim(),
  weight: e.weight.trim(),
  restSec: num(e.restSec),
  notes: e.notes.trim(),
  videoUrl: e.videoUrl.trim(),
});

export default function WorkoutEditor() {
  const { id } = useParams();
  const isNew = !id;
  const { uid } = useSignedIn();
  const navigate = useNavigate();
  const [run, busy] = useAction();
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("Strength");
  const [level, setLevel] = useState("Beginner");
  const [durationMin, setDurationMin] = useState("45");
  const [equipment, setEquipment] = useState("");
  const [published, setPublished] = useState(false);
  const [exercises, setExercises] = useState<ExerciseDraft[]>([blankExercise()]);

  useEffect(() => {
    if (isNew) return;
    getDoc(doc(db, "workouts", id!)).then((snap) => {
      const w = snap.data() as Workout | undefined;
      if (!w) {
        setError("Workout not found.");
      } else {
        setTitle(w.title);
        setDescription(w.description ?? "");
        setCategory(w.category ?? "");
        setLevel(w.level ?? "");
        setDurationMin(w.durationMin?.toString() ?? "");
        setEquipment((w.equipment ?? []).join(", "));
        setPublished(w.published);
        setExercises(w.exercises?.length ? w.exercises.map(toDraft) : [blankExercise()]);
      }
      setLoading(false);
    });
  }, [id, isNew]);

  const updateEx = (i: number, patch: Partial<ExerciseDraft>) =>
    setExercises((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, dir: -1 | 1) =>
    setExercises((xs) => {
      const j = i + dir;
      if (j < 0 || j >= xs.length) return xs;
      const copy = [...xs];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  async function save(e: FormEvent) {
    e.preventDefault();
    const data = {
      title: title.trim(),
      description: description.trim(),
      category,
      level,
      durationMin: num(durationMin),
      equipment: equipment.split(",").map((s) => s.trim()).filter(Boolean),
      exercises: exercises.filter((x) => x.name.trim()).map(fromDraft),
      published,
      updatedAt: serverTimestamp(),
    };
    const savedId = await run(async () => {
      if (isNew) {
        const ref = await addDoc(collection(db, "workouts"), { ...data, createdBy: uid, createdAt: serverTimestamp() });
        return ref.id;
      }
      await updateDoc(doc(db, "workouts", id!), data);
      return id!;
    }, "Workout saved");
    if (savedId) navigate(`/workouts/${savedId}`);
  }

  if (loading) return <Loading />;
  if (error) return <ErrorNote>{error}</ErrorNote>;

  return (
    <form onSubmit={save}>
      <p className="crumbs"><Link to={isNew ? "/workouts" : `/workouts/${id}`}>← Back</Link></p>
      <PageHeader
        title={isNew ? "New workout" : "Edit workout"}
        actions={
          <>
            <Checkbox label="Published (visible to clients)" checked={published} onChange={setPublished} />
            <Button type="submit" busy={busy}>Save</Button>
          </>
        }
      />
      <Card>
        <div className="form-grid">
          <TextInput label="Title" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className="span-2" />
          <Select label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">—</option>
            {WORKOUT_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </Select>
          <Select label="Level" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">—</option>
            {LEVELS.map((c) => <option key={c}>{c}</option>)}
          </Select>
          <TextInput label="Duration (minutes)" type="number" min={0} value={durationMin} onChange={(e) => setDurationMin(e.target.value)} />
          <TextInput label="Equipment" placeholder="Dumbbells, bench, band" value={equipment} onChange={(e) => setEquipment(e.target.value)} />
          <TextArea label="Description" className="span-2" maxLength={8000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Focus, cues, how it should feel…" />
        </div>
      </Card>

      <Card title="Exercises" actions={<Button variant="secondary" size="sm" onClick={() => setExercises((x) => [...x, blankExercise()])}>Add exercise</Button>}>
        <ol className="exercise-editor">
          {exercises.map((x, i) => (
            <li key={i} className="exercise-edit">
              <div className="exercise-edit-head">
                <span className="exercise-num">{i + 1}</span>
                <TextInput label="Exercise" value={x.name} onChange={(e) => updateEx(i, { name: e.target.value })} placeholder="Goblet squat" className="grow" />
                <div className="row-tools">
                  <button type="button" className="icon-btn" onClick={() => move(i, -1)} aria-label="Move up" disabled={i === 0}>↑</button>
                  <button type="button" className="icon-btn" onClick={() => move(i, 1)} aria-label="Move down" disabled={i === exercises.length - 1}>↓</button>
                  <button type="button" className="icon-btn" onClick={() => setExercises((xs) => xs.filter((_, j) => j !== i))} aria-label="Remove exercise">×</button>
                </div>
              </div>
              <div className="form-grid form-grid-4">
                <TextInput label="Sets" type="number" min={0} value={x.sets} onChange={(e) => updateEx(i, { sets: e.target.value })} />
                <TextInput label="Reps / time" value={x.reps} onChange={(e) => updateEx(i, { reps: e.target.value })} placeholder="8-10 or 30s" />
                <TextInput label="Load" value={x.weight} onChange={(e) => updateEx(i, { weight: e.target.value })} placeholder="RPE 7 / 20 lb" />
                <TextInput label="Rest (sec)" type="number" min={0} value={x.restSec} onChange={(e) => updateEx(i, { restSec: e.target.value })} />
                <TextInput label="Coaching notes" className="span-2" value={x.notes} onChange={(e) => updateEx(i, { notes: e.target.value })} />
                <TextInput label="Demo video link" type="url" className="span-2" value={x.videoUrl} onChange={(e) => updateEx(i, { videoUrl: e.target.value })} placeholder="https://…" />
              </div>
            </li>
          ))}
        </ol>
      </Card>
      <div className="form-foot">
        <Button type="submit" busy={busy}>Save workout</Button>
      </div>
    </form>
  );
}
