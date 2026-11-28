import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { collection, deleteDoc, doc, limit, orderBy, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { call, db } from "../../firebase";
import { useSignedIn } from "../../auth";
import { useLiveDoc, useLiveQuery } from "../../lib/useFirestore";
import { displayNameOf, fmtDate } from "../../lib/format";
import { Avatar, Badge, Button, Card, Empty, ErrorNote, Loading, PageHeader, Select, Tabs, TextArea, TextInput, useAction } from "../../components/ui";
import { MetricsList, NutritionLogList, WorkoutLogList } from "../../components/Logs";
import { SessionList } from "../../components/Sessions";
import { InvoiceTable } from "../../components/Invoices";
import InvoiceModal from "../../components/InvoiceModal";
import NutritionPlanView from "../../components/NutritionPlanView";
import AssignWorkoutModal from "../workouts/AssignWorkoutModal";
import NutritionPlanModal from "./NutritionPlanModal";
import { BookModal } from "../schedule/TrainerSchedule";
import { useCredits } from "../../lib/data";
import { CURRENT_SUB_STATUSES, type MembershipAssignment } from "../../types";
import type { Assignment, BillingPlan, CreditEntry, Invoice, Subscription, MetricsLog, NutritionLog, NutritionPlan, Session, UserProfile, WorkoutLog } from "../../types";

type Tab = "overview" | "workouts" | "nutrition" | "checkins" | "sessions" | "billing";

export default function ClientDetail() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "overview";
  const client = useLiveDoc<UserProfile>(`users/${id}`);

  if (client.loading) return <Loading />;
  if (client.error) return <ErrorNote>{client.error}</ErrorNote>;
  if (!client.data) return <Empty>Client not found.</Empty>;
  const c = client.data;

  return (
    <>
      <p className="crumbs"><Link to="/clients">← Clients</Link></p>
      <div className="client-head">
        <Avatar name={displayNameOf(c)} />
        <PageHeader title={displayNameOf(c)} subtitle={[c.email, c.phone].filter(Boolean).join(" · ")} actions={c.role !== "client" && c.role ? <Badge status={c.role}>{c.role}</Badge> : null} />
      </div>
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t })}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "workouts", label: "Workouts" },
          { id: "nutrition", label: "Nutrition" },
          { id: "checkins", label: "Check-ins" },
          { id: "sessions", label: "Sessions" },
          { id: "billing", label: "Billing" },
        ]}
      />
      {tab === "overview" && <Overview client={c} />}
      {tab === "workouts" && <WorkoutsTab clientId={id} />}
      {tab === "nutrition" && <NutritionTab clientId={id} />}
      {tab === "checkins" && <CheckinsTab clientId={id} />}
      {tab === "sessions" && <SessionsTab clientId={id} />}
      {tab === "billing" && <BillingTab clientId={id} />}
    </>
  );
}

function Overview({ client }: { client: UserProfile }) {
  const notes = useLiveDoc<{ id: string; text: string }>(`clientNotes/${client.id}`);
  const [text, setText] = useState("");
  const [run, busy] = useAction();
  useEffect(() => setText(notes.data?.text ?? ""), [notes.data?.text]);

  return (
    <div className="grid-2">
      <Card title="Profile">
        <dl className="details">
          <div><dt>Email</dt><dd>{client.email ?? "—"}</dd></div>
          <div><dt>Phone</dt><dd>{client.phone || "—"}</dd></div>
          <div><dt>Emergency contact</dt><dd>{client.emergencyContact || "—"}</dd></div>
          <div><dt>Joined</dt><dd>{fmtDate(client.createdAt, { month: "long", day: "numeric", year: "numeric" })}</dd></div>
          <div className="span-all"><dt>Goals</dt><dd className="prose">{client.goals || "—"}</dd></div>
        </dl>
      </Card>
      <Card title="Private notes" actions={<span className="muted small">Only coaches see these</span>}>
        <TextArea label="Notes" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Injury history, preferences, what motivates her…" />
        <Button
          size="sm"
          busy={busy}
          disabled={text === (notes.data?.text ?? "")}
          onClick={() => run(() => setDoc(doc(db, "clientNotes", client.id), { text, updatedAt: serverTimestamp() }, { merge: true }), "Notes saved")}
        >
          Save notes
        </Button>
      </Card>
    </div>
  );
}

function WorkoutsTab({ clientId }: { clientId: string }) {
  const [assignOpen, setAssignOpen] = useState(false);
  const [run] = useAction();
  const assignments = useLiveQuery<Assignment>(() => query(collection(db, "assignments"), where("clientId", "==", clientId), orderBy("dueDate", "desc"), limit(50)), [clientId]);
  const logs = useLiveQuery<WorkoutLog>(() => query(collection(db, "users", clientId, "workoutLogs"), orderBy("date", "desc"), limit(30)), [clientId]);
  return (
    <>
      <Card title="Assigned workouts" actions={<Button size="sm" onClick={() => setAssignOpen(true)}>Assign workout</Button>}>
        {assignments.loading ? (
          <Loading />
        ) : assignments.data.length === 0 ? (
          <Empty>Nothing assigned yet.</Empty>
        ) : (
          <ul className="simple-list">
            {assignments.data.map((a) => (
              <li key={a.id}>
                <Link to={`/workouts/${a.workoutId}`}>{a.workoutTitle ?? "Workout"}</Link>
                <span className="muted small">{a.dueDate ? `due ${fmtDate(a.dueDate)}` : "any time"}</span>
                {a.completedAt ? <Badge status="completed">done {fmtDate(a.completedAt)}</Badge> : <Badge status="requested">to do</Badge>}
                <button type="button" className="icon-btn" aria-label="Remove assignment" onClick={() => window.confirm("Remove this assignment?") && run(() => deleteDoc(doc(db, "assignments", a.id)), "Assignment removed")}>×</button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Workout log" actions={<Link className="btn btn-primary btn-sm" to={`/clients/${clientId}/log`}>Log a workout</Link>}>
        {logs.loading ? <Loading /> : <WorkoutLogList clientId={clientId} logs={logs.data} staff />}
      </Card>
      <AssignWorkoutModal open={assignOpen} onClose={() => setAssignOpen(false)} clientId={clientId} />
    </>
  );
}

function NutritionTab({ clientId }: { clientId: string }) {
  const [editing, setEditing] = useState<NutritionPlan | null | undefined>(undefined);
  const plans = useLiveQuery<NutritionPlan>(() => query(collection(db, "nutritionPlans"), where("clientId", "==", clientId), orderBy("updatedAt", "desc")), [clientId]);
  const logs = useLiveQuery<NutritionLog>(() => query(collection(db, "users", clientId, "nutritionLogs"), orderBy("date", "desc"), limit(30)), [clientId]);
  return (
    <>
      <Card title="Nutrition plans" actions={<Button size="sm" onClick={() => setEditing(null)}>New plan</Button>}>
        {plans.loading ? (
          <Loading />
        ) : plans.data.length === 0 ? (
          <Empty>No plan yet.</Empty>
        ) : (
          plans.data.map((p) => (
            <details key={p.id} className="disclosure" open={p.active}>
              <summary>
                {p.title} <Badge status={p.active ? "active" : "canceled"}>{p.active ? "active" : "inactive"}</Badge>
                <span className="muted small"> · updated {fmtDate(p.updatedAt)}</span>
              </summary>
              <NutritionPlanView plan={p} />
              <Button size="sm" variant="secondary" onClick={() => setEditing(p)}>Edit plan</Button>
            </details>
          ))
        )}
      </Card>
      <Card title="Meal log">
        {logs.loading ? <Loading /> : <NutritionLogList clientId={clientId} logs={logs.data} staff />}
      </Card>
      <NutritionPlanModal open={editing !== undefined} onClose={() => setEditing(undefined)} clientId={clientId} plan={editing} />
    </>
  );
}

function CheckinsTab({ clientId }: { clientId: string }) {
  const logs = useLiveQuery<MetricsLog>(() => query(collection(db, "users", clientId, "metrics"), orderBy("date", "desc"), limit(50)), [clientId]);
  return <Card title="Check-ins">{logs.loading ? <Loading /> : <MetricsList clientId={clientId} logs={logs.data} staff />}</Card>;
}

function SessionsTab({ clientId }: { clientId: string }) {
  const { uid } = useSignedIn();
  const [bookOpen, setBookOpen] = useState(false);
  const sessions = useLiveQuery<Session>(() => query(collection(db, "sessions"), where("clientId", "==", clientId), orderBy("start", "desc"), limit(50)), [clientId]);
  const now = Date.now();
  const upcoming = sessions.data.filter((s) => s.start.toMillis() >= now).reverse();
  const past = sessions.data.filter((s) => s.start.toMillis() < now);
  return (
    <>
      <Card title="Upcoming" actions={<Button size="sm" onClick={() => setBookOpen(true)}>Book session</Button>}>
        {sessions.loading ? <Loading /> : <SessionList sessions={upcoming} viewer="staff" showTrainer empty="Nothing coming up." />}
      </Card>
      <Card title="History">{sessions.loading ? <Loading /> : <SessionList sessions={past} viewer="staff" showTrainer empty="No past sessions." />}</Card>
      <BookModal open={bookOpen} onClose={() => setBookOpen(false)} trainerId={uid} clientId={clientId} />
    </>
  );
}

function BillingTab({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false);
  const [run, busy] = useAction();
  const invoices = useLiveQuery<Invoice>(() => query(collection(db, "invoices"), where("clientId", "==", clientId), orderBy("stripeCreated", "desc"), limit(50)), [clientId]);
  const subs = useLiveQuery<Subscription>(() => query(collection(db, "subscriptions"), where("clientId", "==", clientId)), [clientId]);
  const plans = useLiveQuery<BillingPlan>(() => query(collection(db, "billingPlans")), []);
  const planName = (id: string | null) => plans.data.find((p) => p.id === id)?.name ?? "Membership";
  return (
    <>
      <CreditsCard clientId={clientId} />
      <Card
        title="Memberships"
        actions={
          <Button size="sm" variant="secondary" busy={busy} onClick={() => run(() => call("syncBilling", { clientId }), "Up to date with Stripe")}>
            Refresh from Stripe
          </Button>
        }
      >
        <MembershipTier clientId={clientId} subs={subs.data} plans={plans.data} />
        {subs.loading ? (
          <Loading />
        ) : subs.data.length === 0 ? null : (
          <ul className="simple-list">
            {subs.data.map((s) => (
              <li key={s.id}>
                <strong>{planName(s.planId)}</strong>
                <Badge status={s.status} />
                <span className="muted small">
                  {s.status === "canceled" ? "Ended" : s.cancelAtPeriodEnd ? "Ends" : "Renews"} {fmtDate(s.currentPeriodEnd, { month: "short", day: "numeric", year: "numeric" })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Invoices" actions={<Button size="sm" onClick={() => setOpen(true)}>New invoice</Button>}>
        {invoices.loading ? <Loading /> : <InvoiceTable invoices={invoices.data} staff />}
      </Card>
      <InvoiceModal open={open} onClose={() => setOpen(false)} clientId={clientId} />
    </>
  );
}

const REASON_LABEL: Record<CreditEntry["reason"], string> = {
  plan_payment: "Payment",
  session_booked: "Session booked",
  session_refund: "Credit returned",
  manual_adjustment: "Adjusted",
};

function CreditsCard({ clientId }: { clientId: string }) {
  const { credits } = useCredits(clientId);
  const [run, busy] = useAction();
  const [change, setChange] = useState("1");
  const [note, setNote] = useState("");
  const ledger = useLiveQuery<CreditEntry>(
    () => query(collection(db, "creditLedger"), where("clientId", "==", clientId), orderBy("createdAt", "desc"), limit(30)),
    [clientId],
  );
  const n = Number(change);
  const valid = Number.isInteger(n) && n !== 0 && note.trim().length > 0;

  async function adjust() {
    const ok = await run(() => call("adjustCredits", { clientId, change: n, note: note.trim() }), n > 0 ? `Added ${n} credit${n === 1 ? "" : "s"}` : `Removed ${-n} credit${n === -1 ? "" : "s"}`);
    if (ok) {
      setNote("");
      setChange("1");
    }
  }

  return (
    <Card title="Session credits">
      <div className="credits-stat"><span className="credits-num">{credits}</span><span className="credits-label">credit{credits === 1 ? "" : "s"} left</span></div>
      <div className="row adjust-row">
        <TextInput label="Add (+) or remove (−)" type="number" min={-100} max={100} step={1} value={change} onChange={(e) => setChange(e.target.value)} />
        <TextInput label="Reason" className="grow" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Free intro session" maxLength={300} />
        <Button busy={busy} disabled={!valid} onClick={adjust}>Apply</Button>
      </div>
      {ledger.loading ? (
        <Loading />
      ) : ledger.data.length === 0 ? (
        <Empty>No credit history yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Date</th><th>What</th><th className="num">Change</th><th className="num">Balance</th></tr>
            </thead>
            <tbody>
              {ledger.data.map((e) => (
                <tr key={e.id}>
                  <td>{fmtDate(e.createdAt, { month: "short", day: "numeric", year: "numeric" })}</td>
                  <td>{REASON_LABEL[e.reason] ?? e.reason}{e.note ? <span className="muted"> — {e.note}</span> : null}</td>
                  <td className="num">{e.change > 0 ? `+${e.change}` : e.change}</td>
                  <td className="num">{e.balanceAfter}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Trainer/admin controls: assign or change a client's membership tier, end or resume it. */
function MembershipTier({ clientId, subs, plans }: { clientId: string; subs: Subscription[]; plans: BillingPlan[] }) {
  const assignment = useLiveDoc<MembershipAssignment>(`membershipAssignments/${clientId}`);
  const [run, busy] = useAction();
  const tiers = plans.filter((p) => p.mode === "subscription" && p.active).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  // Same choice as the backend: the newest current subscription.
  const currentSubs = subs
    .filter((s) => CURRENT_SUB_STATUSES.includes(s.status))
    .sort((a, b) => (b.stripeCreated?.toMillis() ?? 0) - (a.stripeCreated?.toMillis() ?? 0));
  const current = currentSubs[0];
  const pending = !current && assignment.data?.status === "pending" ? assignment.data : null;
  const currentPlanId = current?.planId ?? pending?.planId ?? "";
  const [tier, setTier] = useState("");
  useEffect(() => setTier(currentPlanId), [currentPlanId]);

  const tierName = (id: string) => plans.find((p) => p.id === id)?.name ?? "Membership";

  async function assign() {
    if (!tier) return;
    const label = tierName(tier);
    const msg = current
      ? `Move this client to ${label}? Their card on file is charged the new price from their next renewal.`
      : `Set this client up with ${label}? They'll get an email asking them to add a card; it's charged automatically each period after that.`;
    if (!window.confirm(msg)) return;
    await act(() => call("assignMembership", { clientId, planId: tier }), current ? `Moved to ${label}` : `${label} assigned — the client has been asked to add a card`);
  }

  /** Runs a tier action, then refreshes this client's billing from Stripe so the page shows what Stripe has. */
  async function act(fn: () => Promise<unknown>, success: string) {
    const ok = await run(fn, success);
    if (ok !== undefined) await call("syncBilling", { clientId }).catch((err) => console.warn("Billing refresh failed", err));
  }

  if (assignment.loading) return <Loading />;
  if (tiers.length === 0) {
    return <p className="muted small">No membership tiers yet. An admin can add them under Billing → Packages & memberships.</p>;
  }
  return (
    <div className="stack tier-box">
      {currentSubs.length > 1 && (
        <p className="error-note">
          This client has {currentSubs.length} active memberships in Stripe. Changes here apply to the newest one ({tierName(current!.planId ?? "")}). End the
          extra one in Stripe (Customers → this client → Subscriptions → Cancel) so they aren't charged twice.
        </p>
      )}
      {pending && (
        <p className="banner">
          <strong>{tierName(pending.planId)}</strong> assigned — waiting for the client to add a card.
        </p>
      )}
      <div className="row">
        <Select label={current ? "Change tier" : "Assign a membership tier"} className="grow" value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="">Choose a tier…</option>
          {tiers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.priceDisplay ? ` — ${p.priceDisplay}` : ""}
            </option>
          ))}
        </Select>
        <Button busy={busy} disabled={!tier || tier === currentPlanId} onClick={assign}>
          {current ? "Change tier" : pending ? "Assign instead" : "Assign"}
        </Button>
      </div>
      <div className="row">
        {current && !current.cancelAtPeriodEnd && (
          <Button
            variant="ghost"
            size="sm"
            busy={busy}
            onClick={() =>
              window.confirm("End this membership at the end of the current billing period? Unused credits stay on the account.") &&
              act(() => call("setMembershipEnding", { clientId, ending: true }), "Membership will end at the end of this period")
            }
          >
            End membership
          </Button>
        )}
        {current?.cancelAtPeriodEnd && (
          <Button variant="secondary" size="sm" busy={busy} onClick={() => act(() => call("setMembershipEnding", { clientId, ending: false }), "Membership will keep renewing")}>
            Keep membership (undo ending)
          </Button>
        )}
        {pending && (
          <Button variant="ghost" size="sm" busy={busy} onClick={() => act(() => call("setMembershipEnding", { clientId, ending: true }), "Assignment withdrawn")}>
            Withdraw
          </Button>
        )}
      </div>
    </div>
  );
}
