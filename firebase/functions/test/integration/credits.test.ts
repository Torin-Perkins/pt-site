/**
 * Session credits granted from Stripe payments, against the Firestore
 * emulator (`npm run test:integration`).
 */
import { beforeAll, describe, expect, it } from "vitest";
import type Stripe from "stripe";

process.env.FUNCTIONS_EMULATOR = "true";
process.env.GCLOUD_PROJECT ??= "demo-toro";

const { db } = await import("../../src/lib/firebase.js");
const { handleStripeEvent, syncCustomerBilling } = await import("../../src/billing.js");

const balance = async (uid: string) => (await db.doc(`billing/${uid}`).get()).get("sessionCredits") ?? 0;
const ledger = async (uid: string) => (await db.collection("creditLedger").where("clientId", "==", uid).get()).docs.map((d) => d.data());

const paidInvoice = (id: string, opts: { customer: string; meta?: Record<string, string>; subMeta?: Record<string, string>; price?: string; status?: string; created?: number }) =>
  ({
    id,
    object: "invoice",
    customer: opts.customer,
    status: opts.status ?? "paid",
    number: id,
    currency: "usd",
    total: 20000,
    amount_due: 20000,
    amount_paid: 20000,
    amount_remaining: 0,
    description: null,
    lines: { data: [{ description: "Plan", amount: 20000, pricing: opts.price ? { type: "price_details", price_details: { price: opts.price } } : null }] },
    hosted_invoice_url: null,
    invoice_pdf: null,
    due_date: null,
    created: opts.created ?? Math.floor(Date.now() / 1000) - 86400,
    metadata: opts.meta ?? {},
    parent: opts.subMeta ? { subscription_details: { subscription: "sub_x", metadata: opts.subMeta } } : null,
  }) as unknown as Stripe.Invoice;

const event = (id: string, type: string, obj: unknown) =>
  ({ id, type, created: Math.floor(Date.now() / 1000), data: { object: obj } }) as unknown as Stripe.Event;

const noStripe = (invs: Stripe.Invoice[]) => ({
  subscriptions: { list: async () => ({ data: [] }) },
  invoices: { list: async () => ({ data: invs }) },
});

beforeAll(async () => {
  await db.doc("billingPlans/monthly").set({ name: "Monthly 8", mode: "subscription", stripePriceId: "price_monthly", sessionCredits: 8, active: true });
  await db.doc("billingPlans/pack10").set({ name: "10 pack", mode: "payment", stripePriceId: "price_pack", sessionCredits: 10, active: true });
  await db.doc("billingPlans/nocredits").set({ name: "Nutrition", mode: "subscription", stripePriceId: "price_nut", active: true });
  for (const [uid, cus] of [["mia", "cus_mia"], ["pat", "cus_pat"], ["lee", "cus_lee"], ["kim", "cus_kim"]]) {
    await db.doc(`billing/${uid}`).set({ stripeCustomerId: cus });
  }
});

describe("credits from payments", () => {
  it("each paid membership invoice adds the plan's credits once", async () => {
    const inv = paidInvoice("in_m1", { customer: "cus_mia", subMeta: { firebaseUid: "mia", planId: "monthly" } });
    await handleStripeEvent(event("evt_a", "invoice.paid", inv));
    expect(await balance("mia")).toBe(8);
    // Same invoice again (another event type, and the catch-up sync): no double credit.
    await handleStripeEvent(event("evt_b", "invoice.payment_succeeded", inv));
    await syncCustomerBilling(noStripe([inv]), "mia");
    expect(await balance("mia")).toBe(8);
    // Next month's renewal adds more; unused credits roll over.
    await handleStripeEvent(event("evt_c", "invoice.paid", paidInvoice("in_m2", { customer: "cus_mia", subMeta: { planId: "monthly" } })));
    expect(await balance("mia")).toBe(16);
    const entries = await ledger("mia");
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.reason === "plan_payment" && e.change === 8 && e.planId === "monthly")).toBe(true);
  });

  it("a package adds its credits when paid", async () => {
    await handleStripeEvent(event("evt_d", "invoice.paid", paidInvoice("in_p1", { customer: "cus_pat", meta: { firebaseUid: "pat", planId: "pack10" } })));
    expect(await balance("pat")).toBe(10);
  });

  it("finds the plan from the price when metadata is missing", async () => {
    await syncCustomerBilling(noStripe([paidInvoice("in_l1", { customer: "cus_lee", price: "price_pack" })]), "lee");
    expect(await balance("lee")).toBe(10);
  });

  it("finds the plan by Stripe product, whatever the current price is", async () => {
    await db.doc("billingPlans/prodplan").set({ name: "By product", stripeProductId: "prod_monthly6", sessionCredits: 6, active: true });
    await db.doc("billing/ana").set({ stripeCustomerId: "cus_ana" });
    const inv = paidInvoice("in_a1", { customer: "cus_ana" });
    (inv.lines.data[0] as unknown as { pricing: unknown }).pricing = { type: "price_details", price_details: { price: "price_brand_new", product: "prod_monthly6" } };
    await syncCustomerBilling(noStripe([inv]), "ana");
    expect(await balance("ana")).toBe(6);
  });

  it("the catch-up sync ignores old invoices (from before credits existed)", async () => {
    await db.doc("billing/old").set({ stripeCustomerId: "cus_old" });
    const old = paidInvoice("in_o1", { customer: "cus_old", subMeta: { planId: "monthly" }, created: Math.floor(Date.now() / 1000) - 60 * 86400 });
    await syncCustomerBilling(noStripe([old]), "old");
    expect(await balance("old")).toBe(0);
  });

  it("no credits for unpaid invoices, trainer invoices or plans without credits", async () => {
    await handleStripeEvent(event("evt_e", "invoice.finalized", paidInvoice("in_k1", { customer: "cus_kim", subMeta: { planId: "monthly" }, status: "open" })));
    await handleStripeEvent(event("evt_f", "invoice.paid", paidInvoice("in_k2", { customer: "cus_kim", meta: { firebaseUid: "kim", createdBy: "erica" } })));
    await handleStripeEvent(event("evt_g", "invoice.paid", paidInvoice("in_k3", { customer: "cus_kim", subMeta: { planId: "nocredits" } })));
    expect(await balance("kim")).toBe(0);
    expect(await ledger("kim")).toHaveLength(0);
  });
});
