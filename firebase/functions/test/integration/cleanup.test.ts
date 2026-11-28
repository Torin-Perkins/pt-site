/**
 * Test-mode cleanup after going live, against the Firestore emulator with a
 * stand-in for live Stripe (`npm run test:integration`).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";

process.env.FUNCTIONS_EMULATOR = "true";
process.env.GCLOUD_PROJECT ??= "demo-toro";

const { db } = await import("../../src/lib/firebase.js");
const { cleanupTestData } = await import("../../src/cleanup.js");

// Only these ids exist in live Stripe.
const LIVE = new Set(["sub_live", "in_live", "cs_live"]);
const lookup = async (id: string) => {
  if (!LIVE.has(id)) throw Object.assign(new Error(`No such object: '${id}'`), { code: "resource_missing" });
  return { livemode: true };
};
const liveStripe = { subscriptions: { retrieve: lookup }, invoices: { retrieve: lookup }, checkout: { sessions: { retrieve: lookup } } };

const balance = async (uid: string) => (await db.doc(`billing/${uid}`).get()).get("sessionCredits");

beforeAll(async () => {
  await db.doc("users/tess").set({ displayName: "Tess Test", role: "client" });
  await db.doc("users/liv").set({ displayName: "Liv Live", role: "client" });
  // Tess only ever paid in test mode, then used 3 of her 8 test credits; Erica also comped her 2.
  await db.doc("billing/tess").set({ stripeCustomerId: "cus_test", sessionCredits: 7 });
  await db.doc("subscriptions/sub_test").set({ clientId: "tess", status: "active" });
  await db.doc("invoices/in_test").set({ clientId: "tess", status: "paid" });
  await db.doc("purchases/cs_test").set({ clientId: "tess" });
  await db.doc("creditLedger/invoice_in_test").set({ clientId: "tess", reason: "plan_payment", change: 8, invoiceId: "in_test", createdAt: Timestamp.now() });
  await db.doc("creditLedger/comp").set({ clientId: "tess", reason: "manual_adjustment", change: 2, createdAt: Timestamp.now() });
  // Liv has paid in live mode.
  await db.doc("billing/liv").set({ stripeCustomerIdLive: "cus_live", sessionCredits: 8 });
  await db.doc("subscriptions/sub_live").set({ clientId: "liv", status: "active" });
  await db.doc("invoices/in_live").set({ clientId: "liv", status: "paid" });
  await db.doc("purchases/cs_live").set({ clientId: "liv" });
  await db.doc("creditLedger/invoice_in_live").set({ clientId: "liv", reason: "plan_payment", change: 8, invoiceId: "in_live", createdAt: Timestamp.now() });
  // A test grant whose invoice mirror was never written.
  await db.doc("creditLedger/invoice_in_orphan").set({ clientId: "liv", reason: "plan_payment", change: 4, invoiceId: "in_orphan", createdAt: Timestamp.now() });
});

describe("cleanupTestData", () => {
  it("a dry run reports without changing anything", async () => {
    const r = await cleanupTestData(liveStripe, { dryRun: true, by: "erica" });
    // (Other integration files share this database, so counts are at least ours.)
    expect(r.removed.subscriptions).toBeGreaterThanOrEqual(1);
    expect(r.removed.invoices).toBeGreaterThanOrEqual(1);
    expect(r.removed.purchases).toBeGreaterThanOrEqual(1);
    expect(r.kept).toEqual({ subscriptions: 1, invoices: 1, purchases: 1 });
    expect(r.creditsRemoved).toEqual(
      expect.arrayContaining([
        { clientId: "tess", name: "Tess Test", credits: 7 },
        { clientId: "liv", name: "Liv Live", credits: 4 },
      ]),
    );
    expect((await db.doc("subscriptions/sub_test").get()).exists).toBe(true);
    expect(await balance("tess")).toBe(7);
  });

  it("removes test records and test credits, keeps live ones", async () => {
    await cleanupTestData(liveStripe, { dryRun: false, by: "erica" });
    for (const p of ["subscriptions/sub_test", "invoices/in_test", "purchases/cs_test"]) expect((await db.doc(p).get()).exists).toBe(false);
    for (const p of ["subscriptions/sub_live", "invoices/in_live", "purchases/cs_live"]) {
      const d = await db.doc(p).get();
      expect(d.exists).toBe(true);
      expect(d.get("livemode")).toBe(true);
    }
    // Tess got 8 from test payments but only has 7 left: take 7, never below zero.
    expect(await balance("tess")).toBe(0);
    // Liv keeps her 8 live credits; the 4 from the orphan test invoice are removed.
    expect(await balance("liv")).toBe(4);
    const adj = await db.collection("creditLedger").where("clientId", "==", "tess").where("reason", "==", "manual_adjustment").get();
    expect(adj.docs.map((d) => d.get("change")).sort()).toEqual([-7, 2]);
  });

  it("running it again changes nothing", async () => {
    const r = await cleanupTestData(liveStripe, { dryRun: false, by: "erica" });
    expect(r.removed).toEqual({ subscriptions: 0, invoices: 0, purchases: 0 });
    expect(r.creditsRemoved).toEqual([]);
    expect(await balance("liv")).toBe(4);
  });
});
