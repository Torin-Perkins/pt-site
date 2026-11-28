import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { FieldValue, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import type Stripe from "stripe";
import { z } from "zod";
import { db, COL } from "./lib/firebase.js";
import { parse, requireRole } from "./lib/auth.js";
import { REGION } from "./config.js";

/*
 * Session credits. A client's balance lives on billing/{uid}.sessionCredits;
 * every change is recorded in creditLedger (+n for a payment, -1 for a
 * booking, +1 for a refund, ± for manual adjustments).
 *
 * Credits are granted when Stripe reports an invoice as paid and the invoice
 * belongs to a billingPlans entry with sessionCredits: every paid invoice of a
 * membership (each renewal), and the one invoice of a package. The ledger id
 * is derived from the invoice id, so the webhook and the catch-up sync can
 * both see the same payment without granting twice.
 */

export type LedgerReason =
  | "plan_payment"
  | "session_booked"
  | "session_refund"
  | "manual_adjustment";

export interface CreditBalance {
  ref: DocumentReference;
  balance: number;
}

/** Reads a client's balance inside a transaction (call before any writes). */
export async function readCredits(tx: Transaction, uid: string): Promise<CreditBalance> {
  const ref = db.collection(COL.billing).doc(uid);
  const snap = await tx.get(ref);
  return { ref, balance: (snap.get("sessionCredits") as number | undefined) ?? 0 };
}

/** Applies a change and records it in the ledger (inside the same transaction). */
export function writeCreditChange(
  tx: Transaction,
  credits: CreditBalance,
  clientId: string,
  change: number,
  entry: { reason: LedgerReason; note?: string | null; sessionId?: string | null; invoiceId?: string | null; planId?: string | null; by?: string | null },
  ledgerRef: DocumentReference = db.collection(COL.creditLedger).doc(),
): number {
  const balanceAfter = credits.balance + change;
  tx.set(credits.ref, { sessionCredits: balanceAfter, creditsUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
  tx.set(ledgerRef, {
    clientId,
    change,
    balanceAfter,
    reason: entry.reason,
    note: entry.note ?? null,
    sessionId: entry.sessionId ?? null,
    invoiceId: entry.invoiceId ?? null,
    planId: entry.planId ?? null,
    by: entry.by ?? null,
    createdAt: FieldValue.serverTimestamp(),
  });
  credits.balance = balanceAfter;
  return balanceAfter;
}

/** Which billing plan an invoice pays for: invoice metadata, subscription metadata, then price. */
async function planForInvoice(inv: Stripe.Invoice): Promise<{ id: string; credits: number } | null> {
  const fromMeta = inv.metadata?.planId || inv.parent?.subscription_details?.metadata?.planId;
  if (fromMeta) {
    const snap = await db.collection(COL.billingPlans).doc(fromMeta).get();
    if (snap.exists) return { id: snap.id, credits: Number(snap.get("sessionCredits") ?? 0) };
  }
  // No metadata: match the plan by product (current plans) or price (older plans).
  const lines = (inv.lines?.data ?? []).map((l) => {
    const line = l as Stripe.InvoiceLineItem & { price?: { id: string; product?: string | { id: string } } | null };
    const details = line.pricing?.price_details;
    const price = details?.price ?? line.price ?? null;
    const legacyProduct = line.price?.product;
    return {
      priceId: typeof price === "string" ? price : price?.id ?? null,
      productId: details?.product ?? (typeof legacyProduct === "string" ? legacyProduct : legacyProduct?.id ?? null),
    };
  });
  for (const { priceId, productId } of lines) {
    for (const [field, value] of [["stripeProductId", productId], ["stripePriceId", priceId]] as const) {
      if (!value) continue;
      const q = await db.collection(COL.billingPlans).where(field, "==", value).limit(1).get();
      if (!q.empty) return { id: q.docs[0].id, credits: Number(q.docs[0].get("sessionCredits") ?? 0) };
    }
  }
  return null;
}

/**
 * Grants the plan's session credits for a paid invoice, once per invoice.
 * Returns the number of credits granted (0 if none were due or already given).
 */
export async function grantCreditsForInvoice(inv: Stripe.Invoice, clientId: string | null): Promise<number> {
  if (inv.status !== "paid" || !clientId || !inv.id) return 0;
  const plan = await planForInvoice(inv);
  if (!plan || !(plan.credits > 0)) return 0;
  const credits = Math.floor(plan.credits);

  const ledgerRef = db.collection(COL.creditLedger).doc(`invoice_${inv.id}`);
  const granted = await db.runTransaction(async (tx) => {
    const already = await tx.get(ledgerRef);
    if (already.exists) return 0;
    const balance = await readCredits(tx, clientId);
    writeCreditChange(tx, balance, clientId, credits, { reason: "plan_payment", invoiceId: inv.id, planId: plan.id }, ledgerRef);
    return credits;
  });
  if (granted) logger.info("Session credits granted", { clientId, invoiceId: inv.id, planId: plan.id, credits });
  return granted;
}

const AdjustInput = z.object({
  clientId: z.string().min(1),
  change: z.number().int().min(-100).max(100).refine((n) => n !== 0, "Change can't be zero"),
  note: z.string().trim().min(1, "Add a short note").max(300),
});

/** Trainer/admin: add or remove credits by hand (comps, corrections). */
export const adjustCredits = onCall({ region: REGION }, async (request) => {
  const c = requireRole(request, "trainer", "admin");
  const { clientId, change, note } = parse(AdjustInput, request.data);
  const user = await db.collection(COL.users).doc(clientId).get();
  if (!user.exists) throw new HttpsError("not-found", "Client not found.");
  const balanceAfter = await db.runTransaction(async (tx) => {
    const credits = await readCredits(tx, clientId);
    if (credits.balance + change < 0) {
      throw new HttpsError("failed-precondition", `The client only has ${credits.balance} credit${credits.balance === 1 ? "" : "s"}.`);
    }
    return writeCreditChange(tx, credits, clientId, change, { reason: "manual_adjustment", note, by: c.uid });
  });
  return { sessionCredits: balanceAfter };
});
