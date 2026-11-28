import { Link } from "react-router";
import { collection, limit, orderBy, query, Timestamp, where } from "firebase/firestore";
import { db } from "../firebase";
import { useSignedIn } from "../auth";
import { useLiveDoc, useLiveQuery } from "../lib/useFirestore";
import { displayNameOf, fmtDate, money } from "../lib/format";
import { Card, Empty, Loading, PageHeader } from "../components/ui";
import { useCredits } from "../lib/data";
import { SessionList } from "../components/Sessions";
import { isStaffRole, type MembershipAssignment, type Assignment, type Invoice, type NutritionPlan, type Session } from "../types";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default function Home() {
  const { role } = useSignedIn();
  return isStaffRole(role) ? <StaffHome /> : <ClientHome />;
}

function firstName(name: string) {
  return name.includes("@") ? "" : name.split(" ")[0];
}

function ClientHome() {
  const { uid, profile, user } = useSignedIn();
  const name = firstName(displayNameOf(profile ?? { email: user.email }));
  const { credits } = useCredits(uid);
  const offer = useLiveDoc<MembershipAssignment>(`membershipAssignments/${uid}`);
  // Fixed at mount so the query isn't rebuilt every render.
  const now = Timestamp.now();

  const sessions = useLiveQuery<Session>(
    () => query(collection(db, "sessions"), where("clientId", "==", uid), where("start", ">=", now), orderBy("start"), limit(10)),
    [uid],
  );
  const assignments = useLiveQuery<Assignment>(
    () => query(collection(db, "assignments"), where("clientId", "==", uid), orderBy("dueDate"), limit(50)),
    [uid],
  );
  const plans = useLiveQuery<NutritionPlan>(
    () => query(collection(db, "nutritionPlans"), where("clientId", "==", uid), orderBy("updatedAt", "desc"), limit(5)),
    [uid],
  );
  const invoices = useLiveQuery<Invoice>(
    () => query(collection(db, "invoices"), where("clientId", "==", uid), orderBy("stripeCreated", "desc"), limit(20)),
    [uid],
  );

  const upcoming = sessions.data.filter((s) => s.status === "confirmed" || s.status === "requested");
  const todo = assignments.data.filter((a) => !a.completedAt);
  const plan = plans.data.find((p) => p.active);
  const open = invoices.data.filter((i) => i.status === "open");

  return (
    <>
      <PageHeader title={`${greeting()}${name ? `, ${name}` : ""}`} subtitle="Here's what's coming up." />
      {offer.data?.status === "pending" && (
        <div className="banner">
          Your coach set you up with the <strong>{offer.data.planName}</strong> membership. <Link to="/billing">Add your card to start</Link>
        </div>
      )}
      {open.length > 0 && (
        <div className="banner">
          You have {open.length} open invoice{open.length > 1 ? "s" : ""} ({money(open.reduce((n, i) => n + i.amountRemaining, 0), open[0].currency)}).{" "}
          <Link to="/billing">View & pay</Link>
        </div>
      )}
      <div className="grid-2">
        <Card
          title="Upcoming sessions"
          actions={
            <>
              <Link to="/billing" className="credits-pill" title="Session credits">
                <strong>{credits}</strong> credit{credits === 1 ? "" : "s"}
              </Link>
              <Link className="btn btn-secondary btn-sm" to="/schedule">Book a session</Link>
            </>
          }
        >
          {sessions.loading ? <Loading /> : <SessionList sessions={upcoming} viewer="client" showTrainer empty="Nothing booked yet." />}
        </Card>
        <Card title="Your workouts" actions={<Link className="link" to="/workouts">Library</Link>}>
          {assignments.loading ? (
            <Loading />
          ) : todo.length === 0 ? (
            <Empty>No workouts assigned right now. Browse the library any time.</Empty>
          ) : (
            <ul className="simple-list">
              {todo.slice(0, 6).map((a) => (
                <li key={a.id}>
                  <Link to={`/workouts/${a.workoutId}?assignment=${a.id}`}>{a.workoutTitle ?? "Workout"}</Link>
                  <span className="muted small">{a.dueDate ? `due ${fmtDate(a.dueDate)}` : "any time"}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Nutrition" actions={<Link className="link" to="/nutrition">Open plan</Link>}>
          {plans.loading ? (
            <Loading />
          ) : plan ? (
            <>
              <p className="lead-sm">{plan.title}</p>
              <MacroRow plan={plan} />
            </>
          ) : (
            <Empty>Your coach hasn't shared a nutrition plan yet.</Empty>
          )}
        </Card>
        <Card title="Log today">
          <div className="quick-actions">
            <Link className="btn btn-secondary" to="/log/workout">Log a workout</Link>
            <Link className="btn btn-secondary" to="/log?tab=nutrition&new=1">Log meals</Link>
            <Link className="btn btn-secondary" to="/log?tab=checkins&new=1">Check in</Link>
          </div>
        </Card>
      </div>
    </>
  );
}

export function MacroRow({ plan }: { plan: NutritionPlan }) {
  const items = [
    ["Calories", plan.dailyCalories, ""],
    ["Protein", plan.macros?.proteinG, "g"],
    ["Carbs", plan.macros?.carbsG, "g"],
    ["Fat", plan.macros?.fatG, "g"],
    ["Water", plan.hydrationOz, "oz"],
  ].filter(([, v]) => v != null && v !== "");
  if (!items.length) return null;
  return (
    <dl className="stats">
      {items.map(([label, v, unit]) => (
        <div key={label as string} className="stat">
          <dt>{label}</dt>
          <dd>
            {v as number}
            <small>{unit}</small>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StaffHome() {
  const { uid, profile, user } = useSignedIn();
  const name = firstName(displayNameOf(profile ?? { email: user.email }));
  const now = Timestamp.now();
  const requests = useLiveQuery<Session>(
    () => query(collection(db, "sessions"), where("trainerId", "==", uid), where("status", "==", "requested"), orderBy("start"), limit(30)),
    [uid],
  );
  const upcoming = useLiveQuery<Session>(
    () => query(collection(db, "sessions"), where("trainerId", "==", uid), where("start", ">=", now), orderBy("start"), limit(30)),
    [uid],
  );
  const past = useLiveQuery<Session>(
    () => query(collection(db, "sessions"), where("trainerId", "==", uid), where("start", "<", now), orderBy("start", "desc"), limit(20)),
    [uid],
  );
  const confirmed = upcoming.data.filter((s) => s.status === "confirmed");
  const pendingRequests = requests.data.filter((s) => s.start.toMillis() > Date.now());
  const toClose = past.data.filter((s) => s.status === "confirmed");

  return (
    <>
      <PageHeader title={`${greeting()}${name ? `, ${name}` : ""}`} subtitle="Your requests and sessions at a glance." />
      <div className="grid-2">
        <Card title={`Session requests${pendingRequests.length ? ` (${pendingRequests.length})` : ""}`}>
          {requests.loading ? <Loading /> : <SessionList sessions={pendingRequests} viewer="staff" showClient empty="No requests waiting." />}
        </Card>
        <Card title="Coming up" actions={<Link className="link" to="/schedule">Full schedule</Link>}>
          {upcoming.loading ? <Loading /> : <SessionList sessions={confirmed.slice(0, 8)} viewer="staff" showClient empty="No confirmed sessions." />}
        </Card>
        {toClose.length > 0 && (
          <Card title="Needs wrapping up">
            <p className="muted small">Mark these as completed or no-show.</p>
            <SessionList sessions={toClose} viewer="staff" showClient />
          </Card>
        )}
        <Card title="Shortcuts">
          <div className="quick-actions">
            <Link className="btn btn-secondary" to="/workouts/new">New workout</Link>
            <Link className="btn btn-secondary" to="/clients">Clients</Link>
            <Link className="btn btn-secondary" to="/schedule/availability">Availability</Link>
            <Link className="btn btn-secondary" to="/billing">Billing</Link>
          </div>
        </Card>
      </div>
    </>
  );
}
