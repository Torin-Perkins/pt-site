import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { deleteDoc, doc } from "firebase/firestore";
import { db } from "../../firebase";
import { useSignedIn } from "../../auth";
import { useLiveDoc } from "../../lib/useFirestore";
import { Badge, Button, Card, Empty, ErrorNote, Loading, Modal, PageHeader, useAction } from "../../components/ui";
import AssignWorkoutModal from "./AssignWorkoutModal";
import { isStaffRole, type Assignment, type Workout } from "../../types";
import { fmtDate } from "../../lib/format";

export default function WorkoutDetail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const assignmentId = params.get("assignment");
  const { role } = useSignedIn();
  const staff = isStaffRole(role);
  const navigate = useNavigate();
  const w = useLiveDoc<Workout>(`workouts/${id}`);
  const assignment = useLiveDoc<Assignment>(assignmentId ? `assignments/${assignmentId}` : null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [run, busy] = useAction();

  if (w.loading) return <Loading />;
  if (w.error) return <ErrorNote>{w.error}</ErrorNote>;
  if (!w.data) return <Empty>This workout isn't available.</Empty>;
  const workout = w.data;

  const logLink = `/log/workout?workout=${workout.id}${assignmentId ? `&assignment=${assignmentId}` : ""}`;

  return (
    <>
      <p className="crumbs"><Link to="/workouts">← Workouts</Link></p>
      <PageHeader
        title={workout.title}
        subtitle={[workout.category, workout.level, workout.durationMin ? `${workout.durationMin} min` : null].filter(Boolean).join(" · ")}
        actions={
          staff ? (
            <>
              {!workout.published && <Badge status="draft">draft</Badge>}
              <Button variant="secondary" onClick={() => setAssignOpen(true)}>Assign to client</Button>
              <Link className="btn btn-primary" to={`/workouts/${workout.id}/edit`}>Edit</Link>
            </>
          ) : (
            <Link className="btn btn-primary" to={logLink}>Log this workout</Link>
          )
        }
      />
      {assignment.data && (
        <div className="banner">
          Assigned by your coach{assignment.data.dueDate ? ` · due ${fmtDate(assignment.data.dueDate)}` : ""}
          {assignment.data.notes && <> — “{assignment.data.notes}”</>}
          {assignment.data.completedAt && <> · <strong>done ✓</strong></>}
        </div>
      )}
      {workout.description && <p className="prose">{workout.description}</p>}
      {workout.equipment?.length ? <p className="muted small">Equipment: {workout.equipment.join(", ")}</p> : null}

      <Card title="Exercises">
        {workout.exercises?.length ? (
          <ol className="exercise-list">
            {workout.exercises.map((e, i) => (
              <li key={i}>
                <div className="exercise-name">{e.name}</div>
                <div className="exercise-rx">
                  {[e.sets ? `${e.sets} sets` : null, e.reps ? `${e.reps} reps` : null, e.weight || null, e.restSec ? `rest ${e.restSec}s` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {e.notes && <p className="exercise-notes">{e.notes}</p>}
                {e.videoUrl && /^https:\/\//.test(e.videoUrl) && (
                  <a href={e.videoUrl} target="_blank" rel="noopener noreferrer" className="link small">Watch demo ↗</a>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <Empty>No exercises listed.</Empty>
        )}
      </Card>

      {staff && (
        <div className="danger-zone">
          <Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete workout</Button>
        </div>
      )}

      {staff && <AssignWorkoutModal open={assignOpen} onClose={() => setAssignOpen(false)} workout={workout} />}
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this workout?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={async () => {
                await run(() => deleteDoc(doc(db, "workouts", workout.id)), "Workout deleted");
                navigate("/workouts");
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p>Clients' past logs of it are kept. To hide it without deleting, unpublish it instead.</p>
      </Modal>
    </>
  );
}
