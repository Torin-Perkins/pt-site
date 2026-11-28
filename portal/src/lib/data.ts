import { collection, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useLiveDoc, useLiveQuery } from "./useFirestore";
import type { TrainerProfile, UserProfile, Workout } from "../types";

/** Staff only: every client account. */
export function useClients() {
  const q = useLiveQuery<UserProfile>(() => query(collection(db, "users"), where("role", "==", "client")), []);
  const data = q.data
    .filter((u) => !u.deleted)
    .sort((a, b) => (a.displayName || a.email || "").localeCompare(b.displayName || b.email || ""));
  return { ...q, data };
}

/** Coaches clients can book with. */
export function useTrainers() {
  const q = useLiveQuery<TrainerProfile>(() => query(collection(db, "trainers"), where("active", "==", true)), []);
  return { ...q, data: [...q.data].sort((a, b) => a.displayName.localeCompare(b.displayName)) };
}

export function useWorkouts(staff: boolean) {
  return useLiveQuery<Workout>(
    () =>
      staff
        ? query(collection(db, "workouts"), orderBy("updatedAt", "desc"))
        : query(collection(db, "workouts"), where("published", "==", true), orderBy("updatedAt", "desc")),
    [staff],
  );
}

export const WORKOUT_CATEGORIES = ["Strength", "Mobility", "Conditioning", "Core", "Balance", "Recovery", "Warm-up"];
export const LEVELS = ["Beginner", "Intermediate", "Advanced"];

/** A client's session-credit balance (live). */
export function useCredits(uid: string | null | undefined) {
  const d = useLiveDoc<{ id: string; sessionCredits?: number }>(uid ? `billing/${uid}` : null);
  return { credits: d.data?.sessionCredits ?? 0, loading: d.loading };
}

/** "8 sessions every month" / "10 sessions" for a plan. */
export function planCreditsLabel(p: { sessionCredits?: number; mode: string }): string | null {
  if (!p.sessionCredits) return null;
  const n = `${p.sessionCredits} session${p.sessionCredits === 1 ? "" : "s"}`;
  return p.mode === "subscription" ? `${n} every billing period` : n;
}
