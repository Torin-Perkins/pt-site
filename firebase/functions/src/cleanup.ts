import { FieldValue } from "firebase-admin/firestore";
import { db, COL } from "./lib/firebase.js";
import { readCredits, writeCreditChange } from "./credits.js";

/*
 * One-time cleanup after switching Stripe from test mode to live mode.
 *
 * Firestore's billing mirrors (subscriptions, invoices, purchases) and the
 * credits granted by test payments were written while testing. Each mirror is
 * checked against Stripe with the LIVE key: anything Stripe doesn't know in
 * live mode came from test mode and is removed; credits granted by those test
 * invoices are taken back (never below zero). Live records are kept and
 * marked livemode: true. Run it as a dry run first to see what it would do.
 */

/** The slice of the Stripe client used here (lets tests pass a fake). */
export interface StripeLookup {
  subscriptions: { retrieve(id: string): Promise<{ livemode: boolean }> };
  invoices: { retrieve(id: string): Promise<{ livemode: boolean }> };
  checkout: { sessions: { retrieve(id: string): Promise<{ livemode: boolean }> } };
}

const missing = (err: unknown) =>
  Boolean(err && typeof err === "object" && ((err as { code?: string }).code === "resource_missing" || /no such/i.test(String((err as { message?: string }).message))));

/** "live" if the object exists in live Stripe, "test" if it doesn't. */
async function modeOf(fetch: () => Promise<{ livemode: boolean }>): Promise<"live" | "test"> {
  try {
    return (await fetch()).livemode ? "live" : "test";
  } catch (err) {
    if (missing(err)) return "test";
    throw err;
  }
}

export interface CleanupReport {
  dryRun: boolean;
  removed: { subscriptions: number; invoices: number; purchases: number };
  kept: { subscriptions: number; invoices: number; purchases: number };
  creditsRemoved: { clientId: string; name: string | null; credits: number }[];
}

export async function cleanupTestData(stripe: StripeLookup, opts: { dryRun: boolean; by: string }): Promise<CleanupReport> {
  const report: CleanupReport = {
    dryRun: opts.dryRun,
    removed: { subscriptions: 0, invoices: 0, purchases: 0 },
    kept: { subscriptions: 0, invoices: 0, purchases: 0 },
    creditsRemoved: [],
  };
  const testInvoiceIds = new Set<string>();

  const passes: [keyof CleanupReport["removed"], string, (id: string) => Promise<{ livemode: boolean }>][] = [
    ["subscriptions", COL.subscriptions, (id) => stripe.subscriptions.retrieve(id)],
    ["invoices", COL.invoices, (id) => stripe.invoices.retrieve(id)],
    ["purchases", COL.purchases, (id) => stripe.checkout.sessions.retrieve(id)],
  ];
  for (const [kind, collection, fetch] of passes) {
    const snap = await db.collection(collection).get();
    for (const d of snap.docs) {
      if (d.get("livemode") === true) {
        report.kept[kind]++;
        continue;
      }
      const mode = await modeOf(() => fetch(d.id));
      if (mode === "live") {
        report.kept[kind]++;
        if (!opts.dryRun) await d.ref.update({ livemode: true });
      } else {
        report.removed[kind]++;
        if (kind === "invoices") testInvoiceIds.add(d.id);
        if (!opts.dryRun) await d.ref.delete();
      }
    }
  }

  // Credits granted by test payments (also catches invoices whose mirror was never written).
  const grants = await db.collection(COL.creditLedger).where("reason", "==", "plan_payment").get();
  const perClient = new Map<string, number>();
  for (const g of grants.docs) {
    const invoiceId = g.get("invoiceId") as string | null;
    if (!invoiceId || g.get("reversed") === true) continue;
    const isTest = testInvoiceIds.has(invoiceId) || (await modeOf(() => stripe.invoices.retrieve(invoiceId))) === "test";
    if (!isTest) continue;
    const clientId = g.get("clientId") as string;
    perClient.set(clientId, (perClient.get(clientId) ?? 0) + Number(g.get("change") ?? 0));
    if (!opts.dryRun) await g.ref.update({ reversed: true, reversedAt: FieldValue.serverTimestamp() });
  }

  for (const [clientId, granted] of perClient) {
    const user = await db.collection(COL.users).doc(clientId).get();
    let removed = granted;
    if (!opts.dryRun) {
      removed = await db.runTransaction(async (tx) => {
        const credits = await readCredits(tx, clientId);
        const take = Math.min(credits.balance, granted);
        if (take > 0) {
          writeCreditChange(tx, credits, clientId, -take, {
            reason: "manual_adjustment",
            note: "Removed credits from Stripe test-mode payments",
            by: opts.by,
          });
        }
        return take;
      });
    } else {
      const balance = ((await db.collection(COL.billing).doc(clientId).get()).get("sessionCredits") as number | undefined) ?? 0;
      removed = Math.min(balance, granted);
    }
    if (removed > 0) report.creditsRemoved.push({ clientId, name: (user.get("displayName") as string | undefined) ?? (user.get("email") as string | undefined) ?? null, credits: removed });
  }
  return report;
}
