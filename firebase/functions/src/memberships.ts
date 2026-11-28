import { HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import type Stripe from "stripe";
import { db, COL } from "./lib/firebase.js";
import { resolvePlanPrice, PlanPriceError, type StripeCatalog } from "./lib/planPrice.js";
import { customerField } from "./config.js";

/*
 * Membership tiers are assigned by trainers/admins, not chosen by clients.
 *
 * membershipAssignments/{clientId}: { planId, planName, status, assignedBy }
 *   pending   — a coach picked a tier; the client still has to add a card.
 *               Their Billing page offers Stripe Checkout for that tier only.
 *   active    — the Stripe subscription exists (card on file, charged
 *               automatically each period).
 *   withdrawn — the coach took the offer back before the client signed up.
 *
 * A client who already has a membership is moved to the new tier in Stripe
 * directly (their card is on file); the new price applies from the next
 * renewal.
 */

export const CURRENT_STATUSES = ["active", "trialing", "past_due", "incomplete"];

/** The slice of the Stripe client used here (lets tests pass a fake). */
export interface StripeMemberships extends StripeCatalog {
  subscriptions: {
    list(p: Stripe.SubscriptionListParams): Promise<{ data: Stripe.Subscription[] }>;
    update(id: string, p: Stripe.SubscriptionUpdateParams): Promise<Stripe.Subscription>;
  };
}

export interface AssignmentDoc {
  clientId: string;
  planId: string;
  planName: string;
  status: "pending" | "active" | "withdrawn";
  assignedBy: string;
}

const assignmentRef = (clientId: string) => db.collection(COL.membershipAssignments).doc(clientId);

async function stripeCustomerOf(clientId: string): Promise<string | null> {
  return ((await db.collection(COL.billing).doc(clientId).get()).get(customerField()) as string | undefined) ?? null;
}

/**
 * The membership coaches manage: the newest current subscription. (A client
 * can end up with two, e.g. from before tiers were coach-assigned; the portal
 * shows the same one and flags the extra.)
 */
export async function currentSubscription(stripe: StripeMemberships, customer: string | null): Promise<Stripe.Subscription | null> {
  if (!customer) return null;
  let subs;
  try {
    subs = await stripe.subscriptions.list({ customer, status: "all", limit: 20 });
  } catch (err) {
    // A customer id from the other Stripe mode (or deleted): no membership here.
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "resource_missing") return null;
    throw err;
  }
  const current = subs.data.filter((s) => CURRENT_STATUSES.includes(s.status)).sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return current[0] ?? null;
}

async function membershipPlan(stripe: StripeMemberships, planId: string) {
  const plan = await db.collection(COL.billingPlans).doc(planId).get();
  if (!plan.exists) throw new HttpsError("not-found", "That membership tier doesn't exist.");
  let resolved;
  try {
    resolved = await resolvePlanPrice(stripe, { stripeProductId: plan.get("stripeProductId"), stripePriceId: plan.get("stripePriceId") });
  } catch (err) {
    if (err instanceof PlanPriceError) throw new HttpsError("failed-precondition", `${plan.get("name") ?? "This tier"}: ${err.message}`);
    throw err;
  }
  if (resolved.mode !== "subscription") {
    throw new HttpsError("invalid-argument", "That's a one-time package, not a membership — clients buy packages themselves.");
  }
  return { planId, name: (plan.get("name") as string | undefined) ?? "Membership", priceId: resolved.priceId };
}

export type AssignResult =
  | { status: "pending"; planName: string }
  | { status: "changed"; planName: string; subscription: Stripe.Subscription }
  | { status: "unchanged"; planName: string };

/**
 * Puts a client on a membership tier. With no current membership this
 * records a pending assignment (the client adds a card next); with one, it
 * switches the Stripe subscription to the new tier from the next renewal.
 */
export async function assignMembership(
  stripe: StripeMemberships,
  args: { clientId: string; planId: string; by: string },
): Promise<AssignResult> {
  const user = await db.collection(COL.users).doc(args.clientId).get();
  if (!user.exists || user.get("role") !== "client") throw new HttpsError("not-found", "Client not found.");
  const plan = await membershipPlan(stripe, args.planId);
  const sub = await currentSubscription(stripe, await stripeCustomerOf(args.clientId));

  const record = {
    clientId: args.clientId,
    planId: plan.planId,
    planName: plan.name,
    assignedBy: args.by,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (!sub) {
    await assignmentRef(args.clientId).set({ ...record, status: "pending", assignedAt: FieldValue.serverTimestamp() });
    return { status: "pending", planName: plan.name };
  }

  const item = sub.items.data[0];
  if (item?.price?.id === plan.priceId && sub.metadata?.planId === plan.planId) {
    await assignmentRef(args.clientId).set({ ...record, status: "active" }, { merge: true });
    return { status: "unchanged", planName: plan.name };
  }
  const updated = await stripe.subscriptions.update(sub.id, {
    items: [{ id: item.id, price: plan.priceId }],
    proration_behavior: "none", // new price from the next renewal
    metadata: { ...(sub.metadata ?? {}), firebaseUid: args.clientId, planId: plan.planId },
  });
  await assignmentRef(args.clientId).set({ ...record, status: "active" }, { merge: true });
  return { status: "changed", planName: plan.name, subscription: updated };
}

/**
 * Ends a membership at the end of the current period (or undoes that). With
 * no membership yet, ending withdraws a pending assignment.
 */
export async function setMembershipEnding(
  stripe: StripeMemberships,
  args: { clientId: string; ending: boolean; by: string },
): Promise<{ status: "ending" | "resumed" | "withdrawn"; subscription?: Stripe.Subscription }> {
  const sub = await currentSubscription(stripe, await stripeCustomerOf(args.clientId));
  if (sub) {
    const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: args.ending });
    return { status: args.ending ? "ending" : "resumed", subscription: updated };
  }
  const pending = await assignmentRef(args.clientId).get();
  if (args.ending && pending.get("status") === "pending") {
    await pending.ref.update({ status: "withdrawn", updatedAt: FieldValue.serverTimestamp(), withdrawnBy: args.by });
    return { status: "withdrawn" };
  }
  throw new HttpsError("failed-precondition", "This client doesn't have a membership.");
}

/** Clients may only check out a membership their coach assigned them. */
export async function assertCheckoutAllowed(clientId: string, planId: string, mode: "payment" | "subscription"): Promise<void> {
  if (mode !== "subscription") return; // packages are self-serve
  const a = await assignmentRef(clientId).get();
  if (a.get("status") !== "pending" || a.get("planId") !== planId) {
    throw new HttpsError("permission-denied", "Memberships are set up by your coach. Ask them to assign you a membership tier.");
  }
}

/** The client finished checkout for their assigned tier (or already has a membership). */
export async function markAssignmentActive(clientId: string | null | undefined): Promise<void> {
  if (!clientId) return;
  const ref = assignmentRef(clientId);
  const snap = await ref.get();
  if (snap.get("status") === "pending") await ref.update({ status: "active", updatedAt: FieldValue.serverTimestamp() });
}
