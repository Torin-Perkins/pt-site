/**
 * Billing catch-up sync against the Firestore emulator, with a stand-in for
 * Stripe's API (`npm run test:integration`).
 */
import { beforeAll, describe, expect, it } from "vitest";
import type Stripe from "stripe";

process.env.FUNCTIONS_EMULATOR = "true";
process.env.GCLOUD_PROJECT ??= "demo-toro";

const { db } = await import("../../src/lib/firebase.js");
const { syncCustomerBilling, handleStripeEvent } = await import("../../src/billing.js");

const periodEnd = Math.floor(Date.UTC(2026, 11, 7) / 1000);
const sub = (status: string, extra: Record<string, unknown> = {}) =>
  ({
    id: "sub_1",
    object: "subscription",
    customer: "cus_cara",
    status,
    cancel_at_period_end: false,
    canceled_at: null,
    metadata: { firebaseUid: "cara", planId: "monthly" },
    items: { data: [{ price: { id: "price_monthly" }, current_period_end: periodEnd }] },
    ...extra,
  }) as unknown as Stripe.Subscription;

const invoice = (id: string, status: string) =>
  ({
    id,
    object: "invoice",
    customer: "cus_cara",
    status,
    number: `INV-${id}`,
    currency: "usd",
    total: 20000,
    amount_due: 20000,
    amount_paid: status === "paid" ? 20000 : 0,
    amount_remaining: status === "paid" ? 0 : 20000,
    description: null,
    lines: { data: [{ description: "Monthly membership", amount: 20000 }] },
    hosted_invoice_url: "https://invoice.stripe.com/i/x",
    invoice_pdf: null,
    due_date: null,
    created: periodEnd - 30 * 86400,
    metadata: {},
    parent: { subscription_details: { subscription: "sub_1" } },
  }) as unknown as Stripe.Invoice;

function fakeStripe(subs: Stripe.Subscription[], invs: Stripe.Invoice[]) {
  const calls: unknown[] = [];
  return {
    calls,
    subscriptions: { list: async (p: unknown) => (calls.push(p), { data: subs }) },
    invoices: { list: async (p: unknown) => (calls.push(p), { data: invs }) },
  };
}

beforeAll(async () => {
  await db.doc("billing/cara").set({ stripeCustomerId: "cus_cara" });
});

describe("syncCustomerBilling", () => {
  it("copies subscriptions and invoices for the client", async () => {
    const fake = fakeStripe([sub("active")], [invoice("in_paid", "paid"), invoice("in_draft", "draft")]);
    const res = await syncCustomerBilling(fake, "cara");
    expect(res).toEqual({ subscriptions: 1, invoices: 2, creditsGranted: 0 });
    expect(fake.calls[0]).toMatchObject({ customer: "cus_cara", status: "all" });

    const s = (await db.doc("subscriptions/sub_1").get()).data()!;
    expect(s).toMatchObject({ clientId: "cara", planId: "monthly", status: "active", priceId: "price_monthly", cancelAtPeriodEnd: false });
    expect(s.currentPeriodEnd.toMillis()).toBe(periodEnd * 1000);

    const inv = (await db.doc("invoices/in_paid").get()).data()!;
    expect(inv).toMatchObject({ clientId: "cara", status: "paid", amountPaid: 20000, subscriptionId: "sub_1" });
    expect((await db.doc("invoices/in_draft").get()).exists).toBe(false); // drafts stay hidden
  });

  it("does nothing for someone who has never paid", async () => {
    const fake = fakeStripe([sub("active")], []);
    expect(await syncCustomerBilling(fake, "nobody")).toEqual({ subscriptions: 0, invoices: 0, creditsGranted: 0 });
    expect(fake.calls).toHaveLength(0);
  });

  it("a later webhook still wins over the sync", async () => {
    const later = Math.floor(Date.now() / 1000) + 60;
    await handleStripeEvent({
      id: "evt_1",
      type: "customer.subscription.updated",
      created: later,
      data: { object: sub("active", { cancel_at_period_end: true }) },
    } as unknown as Stripe.Event);
    expect((await db.doc("subscriptions/sub_1").get()).get("cancelAtPeriodEnd")).toBe(true);
    // A sync that read Stripe before that event doesn't undo it.
    await syncCustomerBilling(fakeStripe([sub("active")], []), "cara");
    expect((await db.doc("subscriptions/sub_1").get()).get("cancelAtPeriodEnd")).toBe(true);
  });

  it("reads the period end from older Stripe API versions too", async () => {
    await db.doc("billing/dana").set({ stripeCustomerId: "cus_dana" });
    const old = sub("active", { id: "sub_old", customer: "cus_dana", current_period_end: periodEnd, items: { data: [{ price: { id: "price_x" } }] } });
    await syncCustomerBilling(fakeStripe([old], []), "dana");
    expect((await db.doc("subscriptions/sub_old").get()).get("currentPeriodEnd").toMillis()).toBe(periodEnd * 1000);
  });
});
