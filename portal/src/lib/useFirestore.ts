import { useEffect, useState, type DependencyList } from "react";
import { doc, onSnapshot, type DocumentReference, type Query } from "firebase/firestore";
import { db, errorMessage } from "../firebase";

export interface Live<T> {
  data: T;
  loading: boolean;
  error: string | null;
}

/**
 * Live Firestore query. `make` returns the query (or null to skip); it is
 * rebuilt whenever `deps` change.
 */
export function useLiveQuery<T extends { id: string }>(make: () => Query | null, deps: DependencyList): Live<T[]> {
  const [state, setState] = useState<Live<T[]>>({ data: [], loading: true, error: null });
  useEffect(() => {
    const q = make();
    if (!q) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      q,
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T), loading: false, error: null }),
      (err) => {
        console.error(err);
        setState({ data: [], loading: false, error: errorMessage(err) });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/** Live single document at `path` (or null to skip). */
export function useLiveDoc<T extends { id: string }>(path: string | null): Live<T | null> {
  const [state, setState] = useState<Live<T | null>>({ data: null, loading: true, error: null });
  useEffect(() => {
    if (!path) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const ref = doc(db, path) as DocumentReference;
    return onSnapshot(
      ref,
      (snap) => setState({ data: snap.exists() ? ({ id: snap.id, ...snap.data() } as T) : null, loading: false, error: null }),
      (err) => {
        console.error(err);
        setState({ data: null, loading: false, error: errorMessage(err) });
      },
    );
  }, [path]);
  return state;
}
