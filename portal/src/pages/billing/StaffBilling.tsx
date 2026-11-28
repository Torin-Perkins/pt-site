import { useState } from "react";
import { addDoc, collection, deleteDoc, deleteField, doc, limit, orderBy, query, updateDoc } from "firebase/firestore";
import { call, db } from "../../firebase";
import { useSignedIn } from "../../auth";
import { useClients } from "../../lib/data";
import { useLiveQuery } from "../../lib/useFirestore";
import { displayNameOf, money } from "../../lib/format";
import { Badge, Button, Card, Checkbox, Empty, ErrorNote, Loading, Modal, PageHeader, Select, Tabs, TextArea, TextInput, useAction } from "../../components/ui";
import { InvoiceTable } from "../../components/Invoices";
import InvoiceModal from "../../components/InvoiceModal";
import type { BillingPlan, Invoice } from "../../types";

type Tab = "invoices" | "plans";

export default function StaffBilling() {
  const { role } = useSignedIn();
  const [tab, setTab] = useState<Tab>("invoices");
  const [status, setStatus] = useState("");
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const clients = useClients();
  const invoices = useLiveQuery<Invoice>(() => query(collection(db, "invoices"), orderBy("stripeCreated", "desc"), limit(200)), []);
  const name = (id: string | null) => displayNameOf(clients.data.find((c) => c.id === id)) ?? "—";
  const shown = invoices.data.filter((i) => !status || i.status === status);
  const outstanding = invoices.data.filter((i) => i.status === "open").reduce((n, i) => n + i.amountRemaining, 0);
  const paid30 = invoices.data
    .filter((i) => i.status === "paid" && i.stripeCreated && i.stripeCreated.toMillis() > Date.now() - 30 * 86_400_000)
    .reduce((n, i) => n + i.amountPaid, 0);

  return (
    <>
      <PageHeader title="Billing" subtitle="Invoices are sent and collected by Stripe." actions={<Button onClick={() => setInvoiceOpen(true)}>New invoice</Button>} />
      <dl className="stats stats-cards">
        <div className="stat"><dt>Outstanding</dt><dd>{money(outstanding)}</dd></div>
        <div className="stat"><dt>Paid, last 30 days</dt><dd>{money(paid30)}</dd></div>
      </dl>
      {role === "admin" && (
        <Tabs value={tab} onChange={setTab} tabs={[{ id: "invoices", label: "Invoices" }, { id: "plans", label: "Packages & memberships" }]} />
      )}
      {tab === "invoices" ? (
        <Card
          actions={
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All invoices</option>
              <option value="open">Open</option>
              <option value="paid">Paid</option>
              <option value="void">Void</option>
            </select>
          }
          title="Invoices"
        >
          {invoices.error && <ErrorNote>{invoices.error}</ErrorNote>}
          {invoices.loading ? <Loading /> : <InvoiceTable invoices={shown} staff clientName={name} />}
        </Card>
      ) : (
        <>
          <PlansAdmin />
          <TestDataCleanup />
        </>
      )}
      <InvoiceModal open={invoiceOpen} onClose={() => setInvoiceOpen(false)} />
    </>
  );
}

const blankPlan = (): Omit<BillingPlan, "id"> => ({ name: "", description: "", priceDisplay: "", stripeProductId: "", mode: "payment", active: true, sort: 0, sessionCredits: 1 });

interface StripeProductInfo {
  productId: string;
  name: string;
  description: string;
  active: boolean;
  hasDefaultPrice: boolean;
  priceDisplay: string;
  mode: BillingPlan["mode"];
}

function PlansAdmin() {
  const plans = useLiveQuery<BillingPlan>(() => query(collection(db, "billingPlans")), []);
  const [editing, setEditing] = useState<BillingPlan | Omit<BillingPlan, "id"> | null>(null);
  const [run, busy] = useAction();
  const [lookup, looking] = useAction();
  const [stripeNote, setStripeNote] = useState<string | null>(null);
  const sorted = [...plans.data].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

  async function save() {
    if (!editing) return;
    const { id, ...data } = editing as BillingPlan;
    const productId = data.stripeProductId?.trim() ?? "";
    const clean = {
      ...data,
      name: data.name.trim(),
      stripeProductId: productId,
      // Once a product is set, the product's own price is used; drop the old fixed price.
      stripePriceId: productId ? deleteField() : data.stripePriceId?.trim() ?? deleteField(),
      sort: Number(data.sort) || 0,
      sessionCredits: Math.max(0, Math.floor(Number(data.sessionCredits) || 0)),
    };
    const ok = await run(async () => {
      if (id) await updateDoc(doc(db, "billingPlans", id), clean);
      else {
        const { stripePriceId: _unused, ...fresh } = clean;
        void _unused;
        await addDoc(collection(db, "billingPlans"), fresh);
      }
      return true;
    }, "Saved");
    if (ok) setEditing(null);
  }

  const e = editing;
  const set = (patch: Partial<BillingPlan>) => setEditing((x) => (x ? { ...x, ...patch } : x));
  const productId = e?.stripeProductId?.trim() ?? "";
  const legacyPrice = !productId && e?.stripePriceId?.startsWith("price_");
  const canSave = Boolean(e?.name.trim()) && (productId.startsWith("prod_") || legacyPrice);

  async function fillFromStripe() {
    const info = await lookup(() => call<StripeProductInfo>("lookupStripeProduct", { productId }));
    if (!info) return;
    set({ name: info.name, priceDisplay: info.priceDisplay, mode: info.mode, ...(info.description ? { description: info.description } : {}) });
    setStripeNote(
      !info.active
        ? "This product is archived in Stripe, so clients can't buy it."
        : !info.hasDefaultPrice
          ? "This product has no default price in Stripe yet — set one on its Stripe page before selling it."
          : `Filled from Stripe: ${info.priceDisplay} (${info.mode === "subscription" ? "recurring" : "one-time"}).`,
    );
  }
  const close = () => {
    setEditing(null);
    setStripeNote(null);
  };

  return (
    <Card title="Packages & memberships" actions={<Button size="sm" onClick={() => setEditing(blankPlan())}>Add</Button>}>
      <p className="muted small">
        Create the product in Stripe first (Product catalog → Add product, with its price), then paste its product ID (prod_…) here. Checkout always charges the
        product's current default price in Stripe, so price changes there apply here automatically. Clients can buy items that are on sale from their Billing page.
      </p>
      {plans.loading ? (
        <Loading />
      ) : sorted.length === 0 ? (
        <Empty>Nothing for sale yet.</Empty>
      ) : (
        <ul className="simple-list">
          {sorted.map((p) => (
            <li key={p.id}>
              <strong>{p.name}</strong>
              <span className="muted small">
                {p.priceDisplay} · {p.mode === "subscription" ? "membership" : "one-time"} · {p.sessionCredits ?? 0} session credit{p.sessionCredits === 1 ? "" : "s"}
                {p.mode === "subscription" ? " per payment" : ""}
              </span>
              {!p.stripeProductId && <Badge status="requested">needs product ID</Badge>}
              <Badge status={p.active ? "active" : "canceled"}>{p.active ? "on sale" : "hidden"}</Badge>
              <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>Edit</Button>
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={!!e}
        onClose={close}
        title={e && "id" in e ? "Edit item" : "New item"}
        footer={
          <>
            {e && "id" in e && (
              <Button variant="ghost" onClick={() => window.confirm("Delete this item?") && run(() => deleteDoc(doc(db, "billingPlans", (e as BillingPlan).id)), "Deleted").then(close)}>
                Delete
              </Button>
            )}
            <Button busy={busy} disabled={!canSave} onClick={save}>Save</Button>
          </>
        }
      >
        {e && (
          <div className="stack">
            <div className="row">
              <TextInput
                label="Stripe product ID"
                className="grow"
                value={e.stripeProductId ?? ""}
                onChange={(ev) => {
                  set({ stripeProductId: ev.target.value });
                  setStripeNote(null);
                }}
                placeholder="prod_…"
              />
              <Button variant="secondary" busy={looking} disabled={!productId.startsWith("prod_")} onClick={fillFromStripe}>
                Fill from Stripe
              </Button>
            </div>
            {stripeNote && <p className="muted small">{stripeNote}</p>}
            {legacyPrice && (
              <p className="muted small">
                This item still uses a fixed Stripe price ({e.stripePriceId}). Add its product ID so price changes in Stripe apply automatically.
              </p>
            )}
            <TextInput label="Name" value={e.name} onChange={(ev) => set({ name: ev.target.value })} placeholder="10-session pack" />
            <TextInput label="Price shown to clients" value={e.priceDisplay ?? ""} onChange={(ev) => set({ priceDisplay: ev.target.value })} placeholder="$850 · or $200/month" />
            <Select label="Type" value={e.mode} onChange={(ev) => set({ mode: ev.target.value as BillingPlan["mode"] })} hint="Filled from Stripe. Checkout always follows the price in Stripe (recurring = membership).">
              <option value="payment">One-time purchase (package)</option>
              <option value="subscription">Recurring membership</option>
            </Select>
            <TextInput
              label={e.mode === "subscription" ? "Session credits per billing period" : "Session credits included"}
              type="number"
              min={0}
              step={1}
              value={e.sessionCredits ?? 0}
              onChange={(ev) => set({ sessionCredits: Number(ev.target.value) })}
              hint={e.mode === "subscription" ? "Added each time the membership payment goes through. Unused credits roll over." : "Added once when the purchase is paid."}
            />
            <TextArea label="Description" value={e.description ?? ""} onChange={(ev) => set({ description: ev.target.value })} />
            <TextInput label="Sort order" type="number" value={e.sort ?? 0} onChange={(ev) => set({ sort: Number(ev.target.value) })} />
            <Checkbox label="On sale" checked={e.active} onChange={(v) => set({ active: v })} />
          </div>
        )}
      </Modal>
    </Card>
  );
}

interface CleanupReport {
  dryRun: boolean;
  removed: { subscriptions: number; invoices: number; purchases: number };
  kept: { subscriptions: number; invoices: number; purchases: number };
  creditsRemoved: { clientId: string; name: string | null; credits: number }[];
}

/** Admin: after going live, remove billing records and credits left over from Stripe test mode. */
function TestDataCleanup() {
  const [run, busy] = useAction();
  const [report, setReport] = useState<CleanupReport | null>(null);

  async function go(dryRun: boolean) {
    if (!dryRun && !window.confirm("Remove the test-mode records and credits listed above? This can't be undone.")) return;
    const r = await run(() => call<CleanupReport>("cleanupTestBillingData", { dryRun }), dryRun ? undefined : "Test data removed");
    if (r) setReport(r);
  }

  const total = report ? report.removed.subscriptions + report.removed.invoices + report.removed.purchases + report.creditsRemoved.length : 0;
  return (
    <Card title="Clean up test data">
      <p className="muted small">
        After switching Stripe to live mode, memberships, invoices and credits from testing can linger in the portal. This checks each record
        against live Stripe and removes the ones that only exist in test mode. Live records are kept. Preview first.
      </p>
      <div className="row">
        <Button variant="secondary" busy={busy} onClick={() => go(true)}>Preview</Button>
        {report?.dryRun && total > 0 && (
          <Button variant="danger" busy={busy} onClick={() => go(false)}>Remove test data</Button>
        )}
      </div>
      {report && (
        <div className="cleanup-report">
          <p>
            <strong>{report.dryRun ? "Would remove" : "Removed"}:</strong> {report.removed.subscriptions} membership
            {report.removed.subscriptions === 1 ? "" : "s"}, {report.removed.invoices} invoice{report.removed.invoices === 1 ? "" : "s"},{" "}
            {report.removed.purchases} purchase{report.removed.purchases === 1 ? "" : "s"}.{" "}
            <span className="muted">
              Keeping {report.kept.subscriptions + report.kept.invoices + report.kept.purchases} live record
              {report.kept.subscriptions + report.kept.invoices + report.kept.purchases === 1 ? "" : "s"}.
            </span>
          </p>
          {report.creditsRemoved.length > 0 && (
            <>
              <p><strong>Credits from test payments {report.dryRun ? "to remove" : "removed"}:</strong></p>
              <ul className="simple-list">
                {report.creditsRemoved.map((c) => (
                  <li key={c.clientId}>{c.name ?? "Client"}: {c.credits} credit{c.credits === 1 ? "" : "s"}</li>
                ))}
              </ul>
            </>
          )}
          {total === 0 && <p className="muted">Nothing left over from test mode.</p>}
        </div>
      )}
    </Card>
  );
}
