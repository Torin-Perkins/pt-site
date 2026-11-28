import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { collection, limit, orderBy, query, where } from "firebase/firestore";
import { call, db } from "../../firebase";
import { useSignedIn } from "../../auth";
import { useLiveDoc, useLiveQuery } from "../../lib/useFirestore";
import { planCreditsLabel, useCredits } from "../../lib/data";
import { fmtDate } from "../../lib/format";
import { Badge, Button, Card, Empty, ErrorNote, Loading, PageHeader, useAction, useToast } from "../../components/ui";
import { InvoiceTable } from "../../components/Invoices";
import { CURRENT_SUB_STATUSES, type BillingPlan, type Invoice, type MembershipAssignment, type Subscription } from "../../types";

export function CreditsStat({ credits }: { credits: number }) {
  return (
    <div className="credits-stat" role="status">
      <span className="credits-num">{credits}</span>
      <span className="credits-label">session credit{credits === 1 ? "" : "s"} left</span>
    </div>
  );
}

export default function ClientBilling() {
  const { uid } = useSignedIn();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const [run, busy] = useAction();
  const { credits } = useCredits(uid);

  const invoices = useLiveQuery<Invoice>(() => query(collection(db, "invoices"), where("clientId", "==", uid), orderBy("stripeCreated", "desc"), limit(50)), [uid]);
  const subs = useLiveQuery<Subscription>(() => query(collection(db, "subscriptions"), where("clientId", "==", uid)), [uid]);
  const plans = useLiveQuery<BillingPlan>(() => query(collection(db, "billingPlans")), []);
  const assignment = useLiveDoc<MembershipAssignment>(`membershipAssignments/${uid}`);
  const [syncing, setSyncing] = useState(false);

  // Catch up with Stripe on every visit (the webhook normally does this too).
  // Right after checkout, check again a few times while Stripe finishes up.
  useEffect(() => {
    let cancelled = false;
    const fromCheckout = params.get("checkout") === "success";
    const sync = () => call("syncBilling").catch((err) => console.warn("Billing sync failed", err));
    setSyncing(true);
    (async () => {
      await sync();
      for (let i = 0; fromCheckout && i < 3 && !cancelled; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        await sync();
      }
      if (!cancelled) setSyncing(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const result = params.get("checkout");
    if (result === "success") toast("Thank you! Your payment went through — your session credits will appear here in a moment.", "success");
    if (result === "cancelled") toast("Checkout cancelled — nothing was charged.");
    if (result) setParams({}, { replace: true });
  }, [params, setParams, toast]);

  async function go(fn: () => Promise<{ url: string | null }>) {
    const res = await run(fn);
    if (res?.url) window.location.assign(res.url);
  }
  const openPortal = () => go(() => call("createBillingPortalSession"));

  if (subs.loading || plans.loading || assignment.loading) return <Loading />;

  const open = invoices.data.filter((i) => i.status === "open");
  // The newest current subscription (the one coaches manage).
  const membership = subs.data
    .filter((s) => CURRENT_SUB_STATUSES.includes(s.status))
    .sort((a, b) => (b.stripeCreated?.toMillis() ?? 0) - (a.stripeCreated?.toMillis() ?? 0))[0];
  const planOf = (id: string | null) => plans.data.find((p) => p.id === id);

  // ------------------------------------------------------------ members
  if (membership) {
    const plan = planOf(membership.planId);
    const perPeriod = plan ? planCreditsLabel(plan) : null;
    return (
      <>
        <PageHeader title="Your membership" subtitle={syncing ? "Checking Stripe for the latest…" : undefined} />
        {open.length > 0 && (
          <Card title="Payment due">
            <InvoiceTable invoices={open} />
          </Card>
        )}
        <Card className="membership-card">
          <div className="membership-head">
            <div>
              <span className="eyebrow">Membership</span>
              <h2 className="membership-name">{plan?.name ?? "Membership"}</h2>
              {plan?.priceDisplay && <p className="price">{plan.priceDisplay}</p>}
            </div>
            <Badge status={membership.status} />
          </div>
          <CreditsStat credits={credits} />
          <dl className="details">
            {perPeriod && (
              <div>
                <dt>Includes</dt>
                <dd>{perPeriod}</dd>
              </div>
            )}
            <div>
              <dt>{membership.cancelAtPeriodEnd ? "Ends" : "Renews"}</dt>
              <dd>{fmtDate(membership.currentPeriodEnd, { month: "long", day: "numeric", year: "numeric" })}</dd>
            </div>
          </dl>
          {membership.status === "past_due" && (
            <ErrorNote>Your last payment didn't go through. Update your card to keep your membership.</ErrorNote>
          )}
          {membership.status === "incomplete" && <p className="muted">Your first payment is still processing.</p>}
          {membership.cancelAtPeriodEnd && (
            <p className="muted small">Your membership won't renew. Unused session credits stay on your account.</p>
          )}
          <div className="row">
            <Link className="btn btn-primary" to="/schedule">Book a session</Link>
            <Button variant="secondary" busy={busy} onClick={openPortal}>Manage membership</Button>
          </div>
          <p className="muted small">Change your card, see receipts or cancel in Stripe's secure billing page.</p>
        </Card>
      </>
    );
  }

  // ------------------------------------------------------------ everyone else
  // Memberships are assigned by a coach; clients only shop for packages.
  const forSale = plans.data.filter((p) => p.active && p.mode !== "subscription").sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const offer = assignment.data?.status === "pending" ? assignment.data : null;
  const offerPlan = offer ? planOf(offer.planId) : undefined;
  return (
    <>
      <PageHeader
        title="Billing"
        subtitle={syncing ? "Checking Stripe for the latest…" : "Sessions, invoices and payment details. Payments are handled securely by Stripe."}
        actions={<Button variant="secondary" busy={busy} onClick={openPortal}>Payment methods & receipts</Button>}
      />
      {invoices.error && <ErrorNote>{invoices.error}</ErrorNote>}
      <Card>
        <CreditsStat credits={credits} />
        <p className="muted small">Each 1-hour session uses one credit.{credits === 0 ? " Buy a package below, or ask your coach about a membership." : ""}</p>
      </Card>
      {offer && (
        <Card className="membership-card offer-card">
          <span className="eyebrow">Membership from your coach</span>
          <h2 className="membership-name">{offerPlan?.name ?? offer.planName}</h2>
          {offerPlan?.priceDisplay && <p className="price">{offerPlan.priceDisplay}</p>}
          {offerPlan && planCreditsLabel(offerPlan) && <p className="plan-credits">{planCreditsLabel(offerPlan)}</p>}
          <p className="muted">
            Your coach set you up with this membership. Add your card to start — you'll be charged automatically each billing period and your session credits are added every time.
          </p>
          <div className="row">
            <Button busy={busy} onClick={() => go(() => call("createCheckoutSession", { planId: offer.planId }))}>Add your card & start</Button>
          </div>
        </Card>
      )}
      {open.length > 0 && (
        <Card title="Due now">
          <InvoiceTable invoices={open} />
        </Card>
      )}
      <Card title="Session packages">
        {forSale.length === 0 ? (
          <Empty>No packages to buy online right now.</Empty>
        ) : (
          <div className="tile-grid">
            {forSale.map((p) => (
              <div key={p.id} className="tile tile-static">
                <span className="eyebrow">{p.mode === "subscription" ? "Membership" : "Package"}</span>
                <h3>{p.name}</h3>
                {p.priceDisplay && <p className="price">{p.priceDisplay}</p>}
                {planCreditsLabel(p) && <p className="plan-credits">{planCreditsLabel(p)}</p>}
                {p.description && <p className="tile-desc">{p.description}</p>}
                <Button busy={busy} onClick={() => go(() => call("createCheckoutSession", { planId: p.id }))}>
                  {p.mode === "subscription" ? "Subscribe" : "Buy"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
      {!offer && <p className="muted small">Memberships are set up by your coach — ask them about a membership tier.</p>}
      <Card title="History">
        {invoices.loading ? <Loading /> : <InvoiceTable invoices={invoices.data.filter((i) => i.status !== "open")} />}
      </Card>
    </>
  );
}
