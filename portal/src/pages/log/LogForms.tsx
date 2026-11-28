import { useEffect, useState } from "react";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "../../firebase";
import { useSignedIn } from "../../auth";
import { isoDay, num } from "../../lib/format";
import { SCALE } from "../../components/Logs";
import { Button, Checkbox, Modal, Select, TextArea, TextInput, useAction } from "../../components/ui";

interface MealDraft {
  name: string;
  description: string;
  calories: string;
  proteinG: string;
}
const MEAL_NAMES = ["Breakfast", "Lunch", "Dinner", "Snack"];

export function NutritionLogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { uid } = useSignedIn();
  const [run, busy] = useAction();
  const [date, setDate] = useState(isoDay());
  const [meals, setMeals] = useState<MealDraft[]>([]);
  const [waterOz, setWaterOz] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open) {
      setDate(isoDay());
      setMeals(MEAL_NAMES.slice(0, 3).map((name) => ({ name, description: "", calories: "", proteinG: "" })));
      setWaterOz("");
      setNotes("");
    }
  }, [open]);

  const update = (i: number, patch: Partial<MealDraft>) => setMeals((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  async function save() {
    const filled = meals
      .filter((m) => m.description.trim() || m.calories || m.proteinG)
      .map((m) => ({ name: m.name.trim() || "Meal", description: m.description.trim(), calories: num(m.calories), proteinG: num(m.proteinG) }));
    const sum = (k: "calories" | "proteinG") => {
      const vals = filled.map((m) => m[k]).filter((v): v is number => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };
    const ok = await run(
      () =>
        addDoc(collection(db, "users", uid, "nutritionLogs"), {
          date,
          meals: filled,
          totals: { calories: sum("calories"), proteinG: sum("proteinG") },
          waterOz: num(waterOz),
          notes: notes.trim(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
      "Meals logged",
    );
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Log meals" wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={save}>Save</Button></>}>
      <div className="stack">
        <TextInput label="Date" type="date" value={date} max={isoDay()} onChange={(e) => setDate(e.target.value)} />
        {meals.map((m, i) => (
          <div key={i} className="meal-edit">
            <div className="form-grid form-grid-4">
              <TextInput label="Meal" value={m.name} onChange={(e) => update(i, { name: e.target.value })} list="meal-names" />
              <TextInput label="What you had" className="span-3" value={m.description} onChange={(e) => update(i, { description: e.target.value })} placeholder="Greek yogurt, berries, granola" />
              <TextInput label="Calories" type="number" min={0} value={m.calories} onChange={(e) => update(i, { calories: e.target.value })} />
              <TextInput label="Protein (g)" type="number" min={0} value={m.proteinG} onChange={(e) => update(i, { proteinG: e.target.value })} />
            </div>
          </div>
        ))}
        <datalist id="meal-names">{MEAL_NAMES.map((n) => <option key={n} value={n} />)}</datalist>
        <div>
          <Button size="sm" variant="secondary" onClick={() => setMeals((ms) => [...ms, { name: "Snack", description: "", calories: "", proteinG: "" }])}>Add meal</Button>
        </div>
        <TextInput label="Water (oz)" type="number" min={0} value={waterOz} onChange={(e) => setWaterOz(e.target.value)} />
        <TextArea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Cravings, digestion, how you felt…" />
      </div>
    </Modal>
  );
}

const SYMPTOMS = ["Hot flashes", "Night sweats", "Joint aches", "Low energy", "Poor sleep", "Brain fog", "Mood swings", "Bloating"];

export function CheckinModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { uid } = useSignedIn();
  const [run, busy] = useAction();
  const [date, setDate] = useState(isoDay());
  const [weight, setWeight] = useState("");
  const [unit, setUnit] = useState<"lb" | "kg">("lb");
  const [waist, setWaist] = useState("");
  const [hips, setHips] = useState("");
  const [sleep, setSleep] = useState("");
  const [energy, setEnergy] = useState("");
  const [mood, setMood] = useState("");
  const [symptoms, setSymptoms] = useState<string[]>([]);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open) {
      setDate(isoDay());
      [setWeight, setWaist, setHips, setSleep, setEnergy, setMood, setNotes].forEach((f) => f(""));
      setSymptoms([]);
    }
  }, [open]);

  async function save() {
    const ok = await run(
      () =>
        addDoc(collection(db, "users", uid, "metrics"), {
          date,
          weight: num(weight),
          unit,
          waistIn: num(waist),
          hipsIn: num(hips),
          sleepHours: num(sleep),
          energy: num(energy),
          mood: num(mood),
          symptoms,
          notes: notes.trim(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
      "Check-in saved",
    );
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Check in" wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={save}>Save</Button></>}>
      <div className="stack">
        <div className="form-grid form-grid-4">
          <TextInput label="Date" type="date" value={date} max={isoDay()} onChange={(e) => setDate(e.target.value)} />
          <TextInput label="Weight" type="number" step="0.1" min={0} value={weight} onChange={(e) => setWeight(e.target.value)} />
          <Select label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as "lb" | "kg")}>
            <option value="lb">lb</option>
            <option value="kg">kg</option>
          </Select>
          <TextInput label="Sleep (hours)" type="number" step="0.5" min={0} max={24} value={sleep} onChange={(e) => setSleep(e.target.value)} />
          <TextInput label="Waist (in)" type="number" step="0.1" min={0} value={waist} onChange={(e) => setWaist(e.target.value)} />
          <TextInput label="Hips (in)" type="number" step="0.1" min={0} value={hips} onChange={(e) => setHips(e.target.value)} />
          <Select label="Energy" value={energy} onChange={(e) => setEnergy(e.target.value)}>
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{SCALE[n]}</option>)}
          </Select>
          <Select label="Mood" value={mood} onChange={(e) => setMood(e.target.value)}>
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{SCALE[n]}</option>)}
          </Select>
        </div>
        <fieldset className="fieldset">
          <legend>Symptoms this week</legend>
          <div className="check-grid">
            {SYMPTOMS.map((s) => (
              <Checkbox key={s} label={s} checked={symptoms.includes(s)} onChange={(on) => setSymptoms((xs) => (on ? [...xs, s] : xs.filter((x) => x !== s)))} />
            ))}
          </div>
        </fieldset>
        <TextArea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </Modal>
  );
}
