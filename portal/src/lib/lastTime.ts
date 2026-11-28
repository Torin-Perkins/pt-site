import { useMemo } from "react";
import { collection, limit, orderBy, query } from "firebase/firestore";
import { db } from "../firebase";
import { useLiveQuery } from "./useFirestore";
import { fmtDate } from "./format";
import type { LoggedSet, WorkoutLog } from "../types";

/** How far back to look for an exercise's previous sets. */
const LOOKBACK = 40;

export interface LastTime {
  date: string;
  sets: LoggedSet[];
}

const key = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/** "10 × 25, 10 × 30" (reps × weight), skipping empty sets. */
export function describeSets(sets: LoggedSet[]): string {
  return sets
    .filter((s) => s.reps || s.weight)
    .map((s) => [s.reps, s.weight].filter(Boolean).join(" × "))
    .join(", ");
}

/** "Last time (Nov 12): 10 × 25, 10 × 30" */
export function lastTimeLabel(last: LastTime): string {
  return `Last time (${fmtDate(last.date, { month: "short", day: "numeric" })}): ${describeSets(last.sets)}`;
}

/**
 * The sets a client did the last time they logged each exercise, from their
 * recent workout logs (matched by exercise name, ignoring case and spacing).
 * `excludeLogId` leaves out the log being edited.
 */
export function useLastTime(clientId: string | null | undefined, excludeLogId?: string) {
  const logs = useLiveQuery<WorkoutLog>(
    () => (clientId ? query(collection(db, "users", clientId, "workoutLogs"), orderBy("date", "desc"), limit(LOOKBACK)) : null),
    [clientId],
  );

  const byExercise = useMemo(() => {
    const map = new Map<string, LastTime>();
    // Newest first; on the same date, the most recently created wins.
    const sorted = [...logs.data].sort(
      (a, b) => b.date.localeCompare(a.date) || (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0),
    );
    for (const log of sorted) {
      if (log.id === excludeLogId) continue;
      for (const ex of log.exercises ?? []) {
        const k = key(ex.name ?? "");
        const done = (ex.sets ?? []).filter((s) => s.reps || s.weight);
        if (!k || !done.length || map.has(k)) continue;
        map.set(k, { date: log.date, sets: done });
      }
    }
    return map;
  }, [logs.data, excludeLogId]);

  return {
    loading: logs.loading,
    lookup: (name: string): LastTime | null => byExercise.get(key(name)) ?? null,
  };
}
