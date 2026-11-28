import { MacroRow } from "../pages/Home";
import { fmtDate } from "../lib/format";
import type { NutritionPlan } from "../types";

export default function NutritionPlanView({ plan }: { plan: NutritionPlan }) {
  return (
    <div className="stack">
      {plan.startDate && <p className="muted small">Started {fmtDate(plan.startDate)}</p>}
      <MacroRow plan={plan} />
      {plan.guidelines && (
        <div>
          <h3 className="h-sm">Guidelines</h3>
          <p className="prose">{plan.guidelines}</p>
        </div>
      )}
      {plan.meals?.length ? (
        <div>
          <h3 className="h-sm">Meals</h3>
          <ul className="meal-plan">
            {plan.meals.map((m, i) => (
              <li key={i}>
                <div className="meal-plan-head">
                  <strong>{m.name}</strong>
                  {m.time && <span className="muted small">{m.time}</span>}
                </div>
                {m.description && <p className="prose">{m.description}</p>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {plan.supplements?.length ? (
        <p className="small"><strong>Supplements:</strong> {plan.supplements.join(", ")}</p>
      ) : null}
    </div>
  );
}
