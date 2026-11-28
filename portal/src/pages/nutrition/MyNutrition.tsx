import { useState } from "react";
import { collection, limit, orderBy, query, where } from "firebase/firestore";
import { db } from "../../firebase";
import { useSignedIn } from "../../auth";
import { useLiveQuery } from "../../lib/useFirestore";
import { fmtDate } from "../../lib/format";
import { Button, Card, Empty, ErrorNote, Loading, PageHeader } from "../../components/ui";
import NutritionPlanView from "../../components/NutritionPlanView";
import { NutritionLogList } from "../../components/Logs";
import { NutritionLogModal } from "../log/LogForms";
import type { NutritionLog, NutritionPlan } from "../../types";

export default function MyNutrition() {
  const { uid } = useSignedIn();
  const [logOpen, setLogOpen] = useState(false);
  const plans = useLiveQuery<NutritionPlan>(
    () => query(collection(db, "nutritionPlans"), where("clientId", "==", uid), orderBy("updatedAt", "desc")),
    [uid],
  );
  const logs = useLiveQuery<NutritionLog>(() => query(collection(db, "users", uid, "nutritionLogs"), orderBy("date", "desc"), limit(5)), [uid]);
  const active = plans.data.filter((p) => p.active);
  const past = plans.data.filter((p) => !p.active);

  return (
    <>
      <PageHeader title="Nutrition" subtitle="Your plan from your coach, and what you've logged." actions={<Button onClick={() => setLogOpen(true)}>Log meals</Button>} />
      {plans.error && <ErrorNote>{plans.error}</ErrorNote>}
      {plans.loading ? (
        <Loading />
      ) : active.length === 0 ? (
        <Card><Empty>Your coach hasn't shared a nutrition plan yet. You can still log meals.</Empty></Card>
      ) : (
        active.map((p) => (
          <Card key={p.id} title={p.title}>
            <NutritionPlanView plan={p} />
          </Card>
        ))
      )}
      <Card title="Recent meals">
        {logs.loading ? <Loading /> : <NutritionLogList clientId={uid} logs={logs.data} staff={false} />}
      </Card>
      {past.length > 0 && (
        <Card title="Earlier plans">
          {past.map((p) => (
            <details key={p.id} className="disclosure">
              <summary>{p.title} <span className="muted small">· updated {fmtDate(p.updatedAt)}</span></summary>
              <NutritionPlanView plan={p} />
            </details>
          ))}
        </Card>
      )}
      <NutritionLogModal open={logOpen} onClose={() => setLogOpen(false)} />
    </>
  );
}
