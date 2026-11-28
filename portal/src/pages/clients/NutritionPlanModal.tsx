import { useEffect, useState } from "react";
import { addDoc, collection, doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { useSignedIn } from "../../auth";
import { isoDay, num } from "../../lib/format";
import { Button, Checkbox, Modal, TextArea, TextInput, useAction } from "../../components/ui";
import type { Meal, NutritionPlan } from "../../types";

export default function NutritionPlanModal({ open, onClose, clientId, plan }: { open: boolean; onClose: () => void; clientId: string; plan?: NutritionPlan | null }) {
  const { uid } = useSignedIn();
  const [run, busy] = useAction();
  const [title, setTitle] = useState("");
  const [active, setActive] = useState(true);
  const [startDate, setStartDate] = useState(isoDay());
  const [calories, setCalories] = useState("");
  const [protein, setProtein] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fat, setFat] = useState("");
  const [fiber, setFiber] = useState("");
  const [water, setWater] = useState("");
  const [guidelines, setGuidelines] = useState("");
  const [meals, setMeals] = useState<Meal[]>([]);
  const [supplements, setSupplements] = useState("");

  useEffect(() => {
    if (!open) return;
    const p = plan;
    setTitle(p?.title ?? "Nutrition plan");
    setActive(p?.active ?? true);
    setStartDate(p?.startDate ?? isoDay());
    setCalories(p?.dailyCalories?.toString() ?? "");
    setProtein(p?.macros?.proteinG?.toString() ?? "");
    setCarbs(p?.macros?.carbsG?.toString() ?? "");
    setFat(p?.macros?.fatG?.toString() ?? "");
    setFiber(p?.macros?.fiberG?.toString() ?? "");
    setWater(p?.hydrationOz?.toString() ?? "");
    setGuidelines(p?.guidelines ?? "");
    setMeals(p?.meals?.length ? p.meals : [{ name: "Breakfast", time: "", description: "" }, { name: "Lunch", time: "", description: "" }, { name: "Dinner", time: "", description: "" }]);
    setSupplements((p?.supplements ?? []).join(", "));
  }, [open, plan]);

  const setMeal = (i: number, patch: Partial<Meal>) => setMeals((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  async function save() {
    const data = {
      clientId,
      trainerId: uid,
      title: title.trim() || "Nutrition plan",
      active,
      startDate: startDate || null,
      dailyCalories: num(calories),
      macros: { proteinG: num(protein), carbsG: num(carbs), fatG: num(fat), fiberG: num(fiber) },
      hydrationOz: num(water),
      guidelines: guidelines.trim(),
      meals: meals.filter((m) => m.name.trim() || m.description?.trim()).map((m) => ({ name: m.name.trim(), time: m.time?.trim() ?? "", description: m.description?.trim() ?? "" })),
      supplements: supplements.split(",").map((s) => s.trim()).filter(Boolean),
      updatedAt: serverTimestamp(),
    };
    const ok = await run(async () => {
      if (plan) await updateDoc(doc(db, "nutritionPlans", plan.id), data);
      else await addDoc(collection(db, "nutritionPlans"), { ...data, createdAt: serverTimestamp() });
      return true;
    }, "Nutrition plan saved");
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} wide title={plan ? "Edit nutrition plan" : "New nutrition plan"} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={save}>Save plan</Button></>}>
      <div className="stack">
        <div className="form-grid">
          <TextInput label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          <TextInput label="Start date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <Checkbox label="Active (shown to the client as their current plan)" checked={active} onChange={setActive} />
        <div className="form-grid form-grid-4">
          <TextInput label="Calories / day" type="number" min={0} value={calories} onChange={(e) => setCalories(e.target.value)} />
          <TextInput label="Protein (g)" type="number" min={0} value={protein} onChange={(e) => setProtein(e.target.value)} />
          <TextInput label="Carbs (g)" type="number" min={0} value={carbs} onChange={(e) => setCarbs(e.target.value)} />
          <TextInput label="Fat (g)" type="number" min={0} value={fat} onChange={(e) => setFat(e.target.value)} />
          <TextInput label="Fiber (g)" type="number" min={0} value={fiber} onChange={(e) => setFiber(e.target.value)} />
          <TextInput label="Water (oz)" type="number" min={0} value={water} onChange={(e) => setWater(e.target.value)} />
        </div>
        <TextArea label="Guidelines" rows={5} value={guidelines} onChange={(e) => setGuidelines(e.target.value)} maxLength={8000} placeholder="Protein at every meal, 2 servings of veg at lunch and dinner…" />
        <fieldset className="fieldset">
          <legend>Meal structure</legend>
          {meals.map((m, i) => (
            <div key={i} className="form-grid form-grid-4 meal-edit">
              <TextInput label="Meal" value={m.name} onChange={(e) => setMeal(i, { name: e.target.value })} />
              <TextInput label="Time" value={m.time ?? ""} onChange={(e) => setMeal(i, { time: e.target.value })} placeholder="7am" />
              <TextInput label="Ideas" className="span-2" value={m.description ?? ""} onChange={(e) => setMeal(i, { description: e.target.value })} />
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setMeals((ms) => [...ms, { name: "Snack", time: "", description: "" }])}>Add meal</Button>
        </fieldset>
        <TextInput label="Supplements" value={supplements} onChange={(e) => setSupplements(e.target.value)} placeholder="Creatine 5 g, Vitamin D, Magnesium" />
      </div>
    </Modal>
  );
}
