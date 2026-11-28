import { useEffect, useState } from "react";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "../../firebase";
import { useSignedIn } from "../../auth";
import { useClients, useWorkouts } from "../../lib/data";
import { displayNameOf } from "../../lib/format";
import { Button, Modal, Select, TextArea, TextInput, useAction } from "../../components/ui";
import type { Workout } from "../../types";

/** Assign a workout to a client. Pass `workout` or `clientId` to fix one side. */
export default function AssignWorkoutModal({
  open,
  onClose,
  workout,
  clientId,
}: {
  open: boolean;
  onClose: () => void;
  workout?: Workout;
  clientId?: string;
}) {
  const { uid } = useSignedIn();
  const clients = useClients();
  const workouts = useWorkouts(true);
  const [client, setClient] = useState(clientId ?? "");
  const [workoutId, setWorkoutId] = useState(workout?.id ?? "");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [run, busy] = useAction();

  useEffect(() => {
    if (open) {
      setClient(clientId ?? "");
      setWorkoutId(workout?.id ?? "");
      setDueDate("");
      setNotes("");
    }
  }, [open, clientId, workout?.id]);

  const chosen = workout ?? workouts.data.find((w) => w.id === workoutId);

  async function save() {
    if (!client || !chosen) return;
    const ok = await run(
      () =>
        addDoc(collection(db, "assignments"), {
          clientId: client,
          trainerId: uid,
          workoutId: chosen.id,
          workoutTitle: chosen.title,
          dueDate: dueDate || null,
          notes: notes.trim(),
          completedAt: null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
      "Workout assigned",
    );
    if (ok) onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Assign workout"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button busy={busy} disabled={!client || !chosen || !chosen.published} onClick={save}>Assign</Button>
        </>
      }
    >
      <div className="stack">
        {!clientId && (
          <Select label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">Choose a client…</option>
            {clients.data.map((c) => (
              <option key={c.id} value={c.id}>{displayNameOf(c)}</option>
            ))}
          </Select>
        )}
        {!workout && (
          <Select label="Workout" value={workoutId} onChange={(e) => setWorkoutId(e.target.value)}>
            <option value="">Choose a workout…</option>
            {workouts.data.filter((w) => w.published).map((w) => (
              <option key={w.id} value={w.id}>{w.title}</option>
            ))}
          </Select>
        )}
        {chosen && !chosen.published && (
          <p className="error-note">This workout is a draft. Publish it first so the client can open it.</p>
        )}
        <TextInput label="Due date (optional)" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        <TextArea label="Notes for the client" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Go light on the lunges this week." />
      </div>
    </Modal>
  );
}
