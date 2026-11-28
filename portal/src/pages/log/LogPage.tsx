import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { collection, limit, orderBy, query } from "firebase/firestore";
import { db } from "../../firebase";
import { useSignedIn } from "../../auth";
import { useLiveQuery } from "../../lib/useFirestore";
import { MetricsList, NutritionLogList, WorkoutLogList } from "../../components/Logs";
import { Button, ErrorNote, Loading, PageHeader, Tabs } from "../../components/ui";
import { CheckinModal, NutritionLogModal } from "./LogForms";
import type { MetricsLog, NutritionLog, WorkoutLog } from "../../types";

type Tab = "workouts" | "nutrition" | "checkins";

export default function LogPage() {
  const { uid } = useSignedIn();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "workouts";
  const [modal, setModal] = useState<null | "nutrition" | "checkins">(params.get("new") ? (tab === "workouts" ? null : tab) : null);

  const workouts = useLiveQuery<WorkoutLog>(() => query(collection(db, "users", uid, "workoutLogs"), orderBy("date", "desc"), limit(50)), [uid]);
  const meals = useLiveQuery<NutritionLog>(() => query(collection(db, "users", uid, "nutritionLogs"), orderBy("date", "desc"), limit(50)), [uid]);
  const checkins = useLiveQuery<MetricsLog>(() => query(collection(db, "users", uid, "metrics"), orderBy("date", "desc"), limit(50)), [uid]);
  const current = { workouts, nutrition: meals, checkins }[tab];

  const action =
    tab === "workouts" ? (
      <Link className="btn btn-primary" to="/log/workout">Log a workout</Link>
    ) : (
      <Button onClick={() => setModal(tab)}>{tab === "nutrition" ? "Log meals" : "Check in"}</Button>
    );

  return (
    <>
      <PageHeader title="My log" subtitle="Your coach can see these and may leave feedback." actions={action} />
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t })}
        tabs={[
          { id: "workouts", label: "Workouts" },
          { id: "nutrition", label: "Nutrition" },
          { id: "checkins", label: "Check-ins" },
        ]}
      />
      {current.error && <ErrorNote>{current.error}</ErrorNote>}
      {current.loading ? (
        <Loading />
      ) : tab === "workouts" ? (
        <WorkoutLogList clientId={uid} logs={workouts.data} staff={false} />
      ) : tab === "nutrition" ? (
        <NutritionLogList clientId={uid} logs={meals.data} staff={false} />
      ) : (
        <MetricsList clientId={uid} logs={checkins.data} staff={false} />
      )}
      <NutritionLogModal open={modal === "nutrition"} onClose={() => setModal(null)} />
      <CheckinModal open={modal === "checkins"} onClose={() => setModal(null)} />
    </>
  );
}
