/**
 * Coach-assigned membership tiers, against the Firestore emulator with a
 * stand-in Stripe client (`npm run test:integration`).
 */
import { beforeAll, describe, expect, it } from "vitest";
import type Stripe from "stripe";

process.env.FUNCTIONS_EMULATOR = "true";
process.env.GCLOUD_PROJECT ??= "demo-toro";

const { db } = await import("../../src/lib/firebase.js");
const { assignMembership, setMembershipEnding, assertCheckoutAllowed, markAssignmentActive } = await import("../../src/memberships.js");

const price = (id: string, recurring: boolean) =>
  ({ id, active: true, product: id.replace("price", "prod"), currency: "usd", unit_amount: 48000, recurring: recurring ? { interval: "month", interval_count: 1 } : null }) as unknown as Stripe.Price;

function fakeStripe(subs: Stripe.Subscription[] = []) {
  const updates: [string, Stripe.SubscriptionUpdateParams][] = [];
  const products: Record<string, Stripe.Price> = {
    prod_basic: price("price_basic", true),
    prod_premium: price("price_premium", true),
    prod_pack: price("price_pack", false),
  };
  return {
    updates,
    products: { retrieve: async (id: string) => ({ id, active: true, default_price: products[id] }) as unknown as Stripe.Product },
    prices: { retrieve: async (id: string) => price(id, true) },
    subscriptions: {
      list: async () => ({ data: subs }),
      update: async (id: string, p: Stripe.SubscriptionUpdateParams) => {
        updates.push([id, p]);
        return { ...subs.find((s) => s.id === id)!, ...(p as object) } as Stripe.Subscription;
      },
    },
  };
}

const subscription = (planId: string, priceId: string) =>
  ({ id: "sub_1", status: "active", metadata: { firebaseUid: "mem", planId }, items: { data: [{ id: "si_1", price: { id: priceId } }] } }) as unknown as Stripe.Subscription;

const assignment = async (uid: string) => (await db.doc(`membershipAssignments/${uid}`).get()).data();

beforeAll(async () => {
  await db.doc("billingPlans/basic").set({ name: "Basic 4", stripeProductId: "prod_basic", mode: "subscription", sessionCredits: 4, active: true });
  await db.doc("billingPlans/premium").set({ name: "Premium 8", stripeProductId: "prod_premium", mode: "subscription", sessionCredits: 8, active: true });
  await db.doc("billingPlans/pack").set({ name: "5 pack", stripeProductId: "prod_pack", mode: "payment", sessionCredits: 5, active: true });
  for (const uid of ["newbie", "mem", "other"]) await db.doc(`users/${uid}`).set({ role: "client", email: `${uid}@example.com` });
  await db.doc("users/coach").set({ role: "trainer" });
  await db.doc("billing/mem").set({ stripeCustomerId: "cus_mem" });
});

describe("assigning membership tiers", () => {
  it("a client with no membership gets a pending tier to add a card for", async () => {
    const res = await assignMembership(fakeStripe(), { clientId: "newbie", planId: "basic", by: "coach" });
    expect(res).toEqual({ status: "pending", planName: "Basic 4" });
    expect(await assignment("newbie")).toMatchObject({ planId: "basic", status: "pending", assignedBy: "coach" });
  });

  it("clients can only check out the tier they were assigned; packages stay open", async () => {
    await expect(assertCheckoutAllowed("newbie", "basic", "subscription")).resolves.toBeUndefined();
    await expect(assertCheckoutAllowed("newbie", "premium", "subscription")).rejects.toMatchObject({ code: "permission-denied" });
    await expect(assertCheckoutAllowed("other", "basic", "subscription")).rejects.toMatchObject({ code: "permission-denied" });
    await expect(assertCheckoutAllowed("other", "pack", "payment")).resolves.toBeUndefined();
  });

  it("once they sign up, the assignment is active and can't be checked out again", async () => {
    await markAssignmentActive("newbie");
    expect((await assignment("newbie"))?.status).toBe("active");
    await expect(assertCheckoutAllowed("newbie", "basic", "subscription")).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("an existing member is moved to the new tier from the next renewal", async () => {
    const stripe = fakeStripe([subscription("basic", "price_basic")]);
    const res = await assignMembership(stripe, { clientId: "mem", planId: "premium", by: "coach" });
    expect(res.status).toBe("changed");
    const [id, params] = stripe.updates[0];
    expect(id).toBe("sub_1");
    expect(params).toMatchObject({ items: [{ id: "si_1", price: "price_premium" }], proration_behavior: "none", metadata: { planId: "premium", firebaseUid: "mem" } });
    expect(await assignment("mem")).toMatchObject({ planId: "premium", status: "active" });
  });

  it("with two active subscriptions, the newest one is changed", async () => {
    const older = { ...subscription("basic", "price_basic"), id: "sub_old", created: 1_700_000_000 } as Stripe.Subscription;
    const newer = { ...subscription("basic", "price_basic"), id: "sub_new", created: 1_790_000_000 } as Stripe.Subscription;
    const stripe = fakeStripe([older, newer]); // Stripe lists newest first, but don't rely on it
    expect((await assignMembership(stripe, { clientId: "mem", planId: "premium", by: "coach" })).status).toBe("changed");
    expect(stripe.updates.map(([id]) => id)).toEqual(["sub_new"]);
  });

  it("assigning the tier they already have changes nothing in Stripe", async () => {
    const stripe = fakeStripe([subscription("premium", "price_premium")]);
    expect((await assignMembership(stripe, { clientId: "mem", planId: "premium", by: "coach" })).status).toBe("unchanged");
    expect(stripe.updates).toHaveLength(0);
  });

  it("packages can't be assigned as memberships", async () => {
    await expect(assignMembership(fakeStripe(), { clientId: "other", planId: "pack", by: "coach" })).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("only client accounts get memberships", async () => {
    await expect(assignMembership(fakeStripe(), { clientId: "coach", planId: "basic", by: "coach" })).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("ending memberships", () => {
  it("ends at period end, and can be undone", async () => {
    const stripe = fakeStripe([subscription("premium", "price_premium")]);
    expect((await setMembershipEnding(stripe, { clientId: "mem", ending: true, by: "coach" })).status).toBe("ending");
    expect(stripe.updates[0][1]).toEqual({ cancel_at_period_end: true });
    expect((await setMembershipEnding(stripe, { clientId: "mem", ending: false, by: "coach" })).status).toBe("resumed");
    expect(stripe.updates[1][1]).toEqual({ cancel_at_period_end: false });
  });

  it("withdraws a tier the client hasn't signed up for yet", async () => {
    await assignMembership(fakeStripe(), { clientId: "other", planId: "basic", by: "coach" });
    expect((await setMembershipEnding(fakeStripe(), { clientId: "other", ending: true, by: "coach" })).status).toBe("withdrawn");
    expect((await assignment("other"))?.status).toBe("withdrawn");
    await expect(assertCheckoutAllowed("other", "basic", "subscription")).rejects.toMatchObject({ code: "permission-denied" });
  });
});
