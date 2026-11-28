import { onCall, onRequest, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import Stripe from "stripe";
import { z } from "zod";
import { db, COL } from "./lib/firebase.js";
import { parse, requireRole } from "./lib/auth.js";
import { grantCreditsForInvoice } from "./credits.js";
import { cleanupTestData } from "./cleanup.js";
import { describeProduct, PlanPriceError, resolvePlanPrice } from "./lib/planPrice.js";
import { assertCheckoutAllowed, assignMembership as assignMembershipCore, markAssignmentActive, setMembershipEnding as setMembershipEndingCore } from "./memberships.js";
import { button, esc, firstName, layout, para, send, transport } from "./notifications.js";
import { customerField, stripeMode, appBaseUrl, CURRENCY, REGION, RESEND_API_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } from "./config.js";

/*
 * Billing runs on Stripe. Firestore only holds read-only mirrors so the app
 * can show balances and history:
 *   billing/{uid}            Stripe customer id for a client
 *   invoices/{invoiceId}     one-off invoices (sessions, late cancels, …) and subscription invoices
 *   subscriptions/{subId}    recurring memberships
 *   purchases/{checkoutId}   completed Checkout purchases (packages)
 *   billingPlans/{planId}    admin-managed catalog clients can buy from
 * The mirrors are written by these functions and by the Stripe webhook only.
 */

let stripeClient: Stripe | undefined;
function stripe(): Stripe {
  stripeClient ??= new Stripe(STRIPE_SECRET_KEY.value());
  return stripeClient;
}

const secrets = [STRIPE_SECRET_KEY];

/**
 * Wraps a billing callable so Stripe/network failures reach the app as a
 * readable message instead of a bare "INTERNAL".
 */
function billingCallable<T>(handler: (request: CallableRequest) => Promise<T>) {
  return onCall({ region: REGION, secrets }, async (request) => {
    try {
      return await handler(request);
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("Billing call failed", err);
      const msg = err instanceof Stripe.errors.StripeError ? err.message : "Billing is unavailable right now.";
      throw new HttpsError("internal", `Stripe: ${msg}`);
    }
  });
}

/** True for Stripe's "No such …" errors (an id from the other mode, or deleted). */
export const isMissing = (err: unknown) =>
  err instanceof Stripe.errors.StripeError && (err.code === "resource_missing" || /no such/i.test(err.message));

/**
 * Returns the client's Stripe customer id for the current mode (test/live),
 * creating the customer on first use. A stored customer that no longer exists
 * in Stripe (deleted, or from the other mode) is replaced.
 */
async function ensureCustomer(uid: string): Promise<string> {
  const ref = db.collection(COL.billing).doc(uid);
  const field = customerField();
  const existing = (await ref.get()).get(field) as string | undefined;
  if (existing) {
    try {
      const c = await stripe().customers.retrieve(existing);
      if (!("deleted" in c && c.deleted)) return existing;
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    logger.warn("Stored Stripe customer is missing; creating a new one", { uid, mode: stripeMode() });
  }

  const user = await db.collection(COL.users).doc(uid).get();
  if (!user.exists) throw new HttpsError("not-found", "Client not found.");
  const customer = await stripe().customers.create(
    {
      email: user.get("email") ?? undefined,
      name: user.get("displayName") ?? undefined,
      metadata: { firebaseUid: uid },
    },
    { idempotencyKey: `customer-${stripeMode()}-${uid}-${existing ?? "new"}` },
  );
  await ref.set({ [field]: customer.id, createdAt: FieldValue.serverTimestamp() }, { merge: true });
  return customer.id;
}

async function uidForCustomer(customerId: string): Promise<string | null> {
  const snap = await db.collection(COL.billing).where(customerField(), "==", customerId).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  v == null ? null : typeof v === "string" ? v : v.id;

function invoiceMirror(inv: Stripe.Invoice, clientId: string | null) {
  return {
    clientId,
    livemode: Boolean(inv.livemode),
    stripeCustomerId: idOf(inv.customer),
    number: inv.number ?? null,
    status: inv.status ?? null,
    currency: inv.currency,
    total: inv.total,
    amountDue: inv.amount_due,
    amountPaid: inv.amount_paid,
    amountRemaining: inv.amount_remaining,
    description: inv.description ?? null,
    lines: (inv.lines?.data ?? []).map((l) => ({ description: l.description ?? null, amount: l.amount })),
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    invoicePdf: inv.invoice_pdf ?? null,
    dueDate: inv.due_date ? Timestamp.fromMillis(inv.due_date * 1000) : null,
    subscriptionId: idOf(inv.parent?.subscription_details?.subscription),
    sessionId: inv.metadata?.sessionId || null,
    createdBy: inv.metadata?.createdBy || null,
    stripeCreated: Timestamp.fromMillis(inv.created * 1000),
  };
}

// ---------------------------------------------------------------- invoices

const InvoiceInput = z.object({
  clientId: z.string().min(1),
  items: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(200),
        /** Unit price in cents. */
        unitAmount: z.number().int().positive().max(1_000_000),
        quantity: z.number().int().min(1).max(100).default(1),
      }),
    )
    .min(1)
    .max(20),
  daysUntilDue: z.number().int().min(0).max(90).default(7),
  memo: z.string().trim().max(500).optional(),
  /** Links the invoice to a session (e.g. a late cancellation). */
  sessionId: z.string().optional(),
});

/** Trainer/admin: bill a client. Stripe emails the invoice with a pay link. */
export const createInvoice = billingCallable(async (request) => {
  const c = requireRole(request, "trainer", "admin");
  const input = parse(InvoiceInput, request.data);

  if (input.sessionId) {
    const s = await db.collection(COL.sessions).doc(input.sessionId).get();
    if (!s.exists || s.get("clientId") !== input.clientId) {
      throw new HttpsError("invalid-argument", "That session doesn't belong to this client.");
    }
  }

  const customer = await ensureCustomer(input.clientId);
  const s = stripe();
  const draft = await s.invoices.create({
    customer,
    collection_method: "send_invoice",
    days_until_due: input.daysUntilDue,
    auto_advance: false,
    pending_invoice_items_behavior: "exclude",
    currency: CURRENCY.value(),
    description: input.memo,
    metadata: { firebaseUid: input.clientId, createdBy: c.uid, sessionId: input.sessionId ?? "" },
  });

  try {
    for (const item of input.items) {
      await s.invoiceItems.create({
        customer,
        invoice: draft.id,
        currency: CURRENCY.value(),
        description: item.quantity > 1 ? `${item.description} × ${item.quantity}` : item.description,
        amount: item.unitAmount * item.quantity,
      });
    }
    const finalized = await s.invoices.finalizeInvoice(draft.id!);
    const sent = await s.invoices.sendInvoice(finalized.id!);

    await db.collection(COL.invoices).doc(sent.id!).set({
      ...invoiceMirror(sent, input.clientId),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (input.sessionId) {
      await db.collection(COL.sessions).doc(input.sessionId).update({ invoiceId: sent.id });
    }
    return { invoiceId: sent.id, hostedInvoiceUrl: sent.hosted_invoice_url ?? null, amountDue: sent.amount_due };
  } catch (err) {
    // Don't leave a half-built draft behind.
    await s.invoices.del(draft.id!).catch(() => undefined);
    logger.error("createInvoice failed", err);
    throw new HttpsError("internal", "Stripe couldn't create the invoice.");
  }
});

const VoidInput = z.object({ invoiceId: z.string().startsWith("in_") });

/** Trainer/admin: void an open invoice that was sent by mistake. */
export const voidInvoice = billingCallable(async (request) => {
  requireRole(request, "trainer", "admin");
  const { invoiceId } = parse(VoidInput, request.data);
  const inv = await stripe().invoices.voidInvoice(invoiceId);
  await db.collection(COL.invoices).doc(invoiceId).set(
    { ...invoiceMirror(inv, await uidForCustomer(idOf(inv.customer)!)), updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return { invoiceId, status: inv.status };
});

// ---------------------------------------------------------------- checkout & portal

const CheckoutInput = z.object({ planId: z.string().min(1) });

/**
 * Client: buy a package or start a membership from billingPlans. The price
 * comes from the plan document, never from the client.
 */
export const createCheckoutSession = billingCallable(async (request) => {
  const c = requireRole(request, "client");
  const { planId } = parse(CheckoutInput, request.data);
  const plan = await db.collection(COL.billingPlans).doc(planId).get();
  if (!plan.exists || plan.get("active") !== true) throw new HttpsError("not-found", "That plan isn't available.");

  // The product's current default price (or a legacy plan's fixed price).
  let resolved;
  try {
    resolved = await resolvePlanPrice(stripe(), { stripeProductId: plan.get("stripeProductId"), stripePriceId: plan.get("stripePriceId") });
  } catch (err) {
    if (err instanceof PlanPriceError) {
      logger.error("Plan can't be sold", { planId, reason: err.message });
      throw new HttpsError("failed-precondition", "This item can't be purchased right now. Please contact your coach.");
    }
    throw err;
  }
  const { priceId, mode } = resolved;
  // Membership tiers are assigned by a coach; clients can only start the one they were given.
  await assertCheckoutAllowed(c.uid, planId, mode);
  const customer = await ensureCustomer(c.uid);
  // Members manage their plan in the billing portal; they don't buy another one here.
  const current = await stripe().subscriptions.list({ customer, status: "all", limit: 20 });
  if (current.data.some((sub) => ["active", "trialing", "past_due", "incomplete"].includes(sub.status))) {
    throw new HttpsError("failed-precondition", "You already have a membership. Manage it from your Billing page.");
  }
  const base = appBaseUrl();
  const session = await stripe().checkout.sessions.create({
    mode,
    customer,
    client_reference_id: c.uid,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${base}/portal/billing?checkout=success`,
    cancel_url: `${base}/portal/billing?checkout=cancelled`,
    metadata: { firebaseUid: c.uid, planId },
    ...(mode === "subscription"
      ? { subscription_data: { metadata: { firebaseUid: c.uid, planId } } }
      : { invoice_creation: { enabled: true, invoice_data: { metadata: { firebaseUid: c.uid, planId } } } }),
  });
  return { url: session.url };
});

// ---------------------------------------------------------------- membership tiers (staff)

const AssignInput = z.object({ clientId: z.string().min(1), planId: z.string().min(1) });

/**
 * Trainer/admin: put a client on a membership tier. New members get an email
 * and a "add your card" prompt on their Billing page; existing members move to
 * the new tier in Stripe from their next renewal.
 */
export const assignMembership = onCall({ region: REGION, secrets: [STRIPE_SECRET_KEY, RESEND_API_KEY] }, async (request) => {
  const c = requireRole(request, "trainer", "admin");
  const input = parse(AssignInput, request.data);
  let result;
  try {
    result = await assignMembershipCore(stripe(), { ...input, by: c.uid });
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    logger.error("assignMembership failed", err);
    throw new HttpsError("internal", `Stripe: ${err instanceof Stripe.errors.StripeError ? err.message : "Billing is unavailable right now."}`);
  }
  if (result.status === "changed") {
    const sub = result.subscription;
    await upsertIfNewer(`${COL.subscriptions}/${sub.id}`, Math.floor(Date.now() / 1000), subscriptionMirror(sub, input.clientId));
  }
  if (result.status === "pending") await emailAssignedMembership(input.clientId, result.planName, c.uid).catch((err) => logger.error("Membership email failed", err));
  return { status: result.status, planName: result.planName };
});

const EndingInput = z.object({ clientId: z.string().min(1), ending: z.boolean() });

/** Trainer/admin: end a membership at period end (or undo that), or withdraw a pending one. */
export const setMembershipEnding = billingCallable(async (request) => {
  const c = requireRole(request, "trainer", "admin");
  const input = parse(EndingInput, request.data);
  const res = await setMembershipEndingCore(stripe(), { ...input, by: c.uid });
  if (res.subscription) {
    await upsertIfNewer(`${COL.subscriptions}/${res.subscription.id}`, Math.floor(Date.now() / 1000), subscriptionMirror(res.subscription, input.clientId));
  }
  return { status: res.status };
});

async function emailAssignedMembership(clientId: string, planName: string, coachId: string) {
  const [client, coach] = await Promise.all([db.collection(COL.users).doc(clientId).get(), db.collection(COL.users).doc(coachId).get()]);
  const to = client.get("email") as string | undefined;
  if (!to || transport() === "log") return;
  const coachName = (coach.get("displayName") as string | undefined) || "Your coach";
  const hi = firstName((client.get("displayName") as string | undefined) ?? "");
  const link = `${appBaseUrl()}/portal/billing`;
  await send({
    to,
    replyTo: (coach.get("email") as string | undefined) ?? undefined,
    subject: `${coachName} set you up with ${planName}`,
    text: `Hi${hi ? ` ${hi}` : ""}, ${coachName} has set you up with the ${planName} membership. Add your card to start: ${link}`,
    html: layout(
      "Your membership is ready",
      [
        para(`Hi${hi ? ` ${esc(hi)}` : ""}, ${esc(coachName)} has set you up with the <strong>${esc(planName)}</strong> membership.`),
        para("Add your card to start it. You'll be charged automatically each billing period, and your session credits are added every time."),
        `<p style="margin:18px 0 4px">${button(link, "Add your card")}</p>`,
      ],
      "Sent by the Toro Fitness client portal. Reply to reach your coach.",
    ),
  });
}

const CleanupInput = z.object({ dryRun: z.boolean().default(true) });

/**
 * Admin, after switching to the live Stripe key: remove billing records and
 * credits left over from test mode (see cleanup.ts). Dry run by default.
 */
export const cleanupTestBillingData = billingCallable(async (request) => {
  const c = requireRole(request, "admin");
  const { dryRun } = parse(CleanupInput, request.data);
  if (stripeMode() !== "live") {
    throw new HttpsError("failed-precondition", "Stripe is still in test mode. Run this after switching to the live key.");
  }
  const report = await cleanupTestData(stripe(), { dryRun, by: c.uid });
  logger.info("Test billing cleanup", { dryRun, removed: report.removed, credits: report.creditsRemoved.length });
  return report;
});

const ProductInput = z.object({ productId: z.string().trim().startsWith("prod_", "Stripe product IDs start with prod_") });

/** Admin: read a Stripe product so the plan form can fill in its details. */
export const lookupStripeProduct = billingCallable(async (request) => {
  requireRole(request, "admin");
  const { productId } = parse(ProductInput, request.data);
  try {
    return await describeProduct(stripe(), productId);
  } catch (err) {
    if (err instanceof Stripe.errors.StripeInvalidRequestError && err.code === "resource_missing") {
      throw new HttpsError("not-found", "No product with that ID in Stripe. Check you're in the same mode (test or live).");
    }
    throw err;
  }
});

/** Client: open Stripe's portal to update cards, see receipts, manage membership. */
export const createBillingPortalSession = billingCallable(async (request) => {
  const c = requireRole(request, "client");
  const customer = await ensureCustomer(c.uid);
  const portal = await stripe().billingPortal.sessions.create({
    customer,
    return_url: `${appBaseUrl()}/portal/billing`,
  });
  return { url: portal.url };
});

// ---------------------------------------------------------------- webhook

/**
 * Writes a mirror document only if this event is newer than the last one
 * applied to it (Stripe doesn't guarantee delivery order).
 */
async function upsertIfNewer(path: string, eventCreated: number, data: Record<string, unknown>) {
  const ref = db.doc(path);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const last = snap.get("lastEventCreated") as number | undefined;
    if (last !== undefined && last > eventCreated) return;
    tx.set(
      ref,
      {
        ...data,
        lastEventCreated: eventCreated,
        updatedAt: FieldValue.serverTimestamp(),
        ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      },
      { merge: true },
    );
  });
}

function subscriptionMirror(sub: Stripe.Subscription, clientId: string | null) {
  const item = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_end?: number }) | undefined;
  // Older Stripe API versions keep the period end on the subscription itself.
  const periodEnd = item?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end;
  return {
    clientId,
    livemode: Boolean(sub.livemode),
    stripeCustomerId: idOf(sub.customer),
    planId: sub.metadata?.planId || null,
    status: sub.status,
    priceId: item?.price?.id ?? null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    currentPeriodEnd: periodEnd ? Timestamp.fromMillis(periodEnd * 1000) : null,
    canceledAt: sub.canceled_at ? Timestamp.fromMillis(sub.canceled_at * 1000) : null,
    stripeCreated: sub.created ? Timestamp.fromMillis(sub.created * 1000) : null,
  };
}

/** The slice of the Stripe client that syncCustomerBilling uses (lets tests pass a fake). */
export interface StripeReader {
  subscriptions: { list(p: Stripe.SubscriptionListParams): Promise<{ data: Stripe.Subscription[] }> };
  invoices: { list(p: Stripe.InvoiceListParams): Promise<{ data: Stripe.Invoice[] }> };
}

/**
 * Copies a client's current subscriptions and recent invoices from Stripe into
 * Firestore. The webhook normally keeps these up to date; this catches up when
 * a webhook is late, failed, or isn't set up yet.
 */
export async function syncCustomerBilling(client: StripeReader, uid: string) {
  const customer = (await db.collection(COL.billing).doc(uid).get()).get(customerField()) as string | undefined;
  if (!customer) return { subscriptions: 0, invoices: 0, creditsGranted: 0 };
  let subs, invs;
  try {
    [subs, invs] = await Promise.all([
      client.subscriptions.list({ customer, status: "all", limit: 20 }),
      client.invoices.list({ customer, limit: 30 }),
    ]);
  } catch (err) {
    if (isMissing(err)) return { subscriptions: 0, invoices: 0, creditsGranted: 0 }; // customer gone; recreated on next checkout
    throw err;
  }
  if (subs.data.some((s) => ["active", "trialing", "past_due"].includes(s.status))) await markAssignmentActive(uid);
  const asOf = Math.floor(Date.now() / 1000); // anything Stripe sends later is newer than this read
  await Promise.all([
    ...subs.data.map((sub) => upsertIfNewer(`${COL.subscriptions}/${sub.id}`, asOf, subscriptionMirror(sub, uid))),
    ...invs.data
      .filter((inv) => inv.status !== "draft")
      .map((inv) => upsertIfNewer(`${COL.invoices}/${inv.id}`, asOf, invoiceMirror(inv, uid))),
  ]);
  // Paid plan invoices the webhook hasn't credited yet (each invoice is credited
  // once). Only recent ones: older invoices predate session credits, or were
  // already credited by the webhook.
  const recent = Date.now() - 35 * 86_400_000;
  let creditsGranted = 0;
  for (const inv of invs.data) {
    if (inv.created * 1000 >= recent) creditsGranted += await grantCreditsForInvoice(inv, uid);
  }
  return { subscriptions: subs.data.length, invoices: invs.data.length, creditsGranted };
}

const SyncInput = z.object({ clientId: z.string().min(1).optional() });

/**
 * Refresh a client's billing from Stripe. Clients refresh their own (the
 * Billing page does this on load); trainers pass a clientId.
 */
export const syncBilling = billingCallable(async (request) => {
  const c = requireRole(request, "client", "trainer", "admin");
  const { clientId } = parse(SyncInput, request.data);
  const uid = c.role === "client" ? c.uid : clientId;
  if (!uid) throw new HttpsError("invalid-argument", "clientId is required.");
  return syncCustomerBilling(stripe(), uid);
});

export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  const obj = event.data.object as unknown as Record<string, unknown>;

  if (event.type.startsWith("invoice.") && obj.object === "invoice") {
    const inv = obj as unknown as Stripe.Invoice;
    const uid = inv.metadata?.firebaseUid || (await uidForCustomer(idOf(inv.customer)!));
    await upsertIfNewer(`${COL.invoices}/${inv.id}`, event.created, invoiceMirror(inv, uid));
    await grantCreditsForInvoice(inv, uid);
    return;
  }

  if (event.type.startsWith("customer.subscription.")) {
    const sub = obj as unknown as Stripe.Subscription;
    const uid = sub.metadata?.firebaseUid || (await uidForCustomer(idOf(sub.customer)!));
    await upsertIfNewer(`${COL.subscriptions}/${sub.id}`, event.created, subscriptionMirror(sub, uid));
    return;
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const cs = obj as unknown as Stripe.Checkout.Session;
    if (cs.mode === "subscription") await markAssignmentActive(cs.client_reference_id ?? cs.metadata?.firebaseUid);
    await upsertIfNewer(`${COL.purchases}/${cs.id}`, event.created, {
      clientId: cs.client_reference_id ?? cs.metadata?.firebaseUid ?? null,
      livemode: Boolean(cs.livemode),
      planId: cs.metadata?.planId ?? null,
      mode: cs.mode,
      paymentStatus: cs.payment_status,
      amountTotal: cs.amount_total,
      currency: cs.currency,
      invoiceId: idOf(cs.invoice),
      subscriptionId: idOf(cs.subscription),
    });
  }
}

/**
 * Stripe → Firestore sync. In the Stripe dashboard add an endpoint pointing at
 * this function's URL and subscribe to: invoice.*, customer.subscription.*,
 * checkout.session.completed, checkout.session.async_payment_succeeded.
 */
export const stripeWebhook = onRequest(
  { region: REGION, secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }
    let event: Stripe.Event;
    try {
      event = stripe().webhooks.constructEvent(
        req.rawBody,
        req.header("stripe-signature") ?? "",
        STRIPE_WEBHOOK_SECRET.value(),
      );
    } catch (err) {
      // Usually STRIPE_WEBHOOK_SECRET doesn't match this endpoint's signing secret,
      // or it was changed without redeploying (functions read secrets at deploy time).
      logger.warn("Rejected Stripe webhook: signature check failed", { message: (err as Error).message });
      res.status(400).send("Bad signature");
      return;
    }

    if (!event.data?.object) {
      // "Thin" event destinations only send an id; this handler needs the full object.
      logger.error("Stripe sent a thin event; set the destination's payload style to Snapshot", { id: event.id, type: event.type });
      res.status(400).send("Thin events aren't supported: edit the event destination and choose the Snapshot payload.");
      return;
    }

    const seen = db.collection(COL.stripeEvents).doc(event.id);
    if ((await seen.get()).exists) {
      res.json({ received: true, duplicate: true });
      return;
    }
    try {
      await handleStripeEvent(event);
      await seen.set({ type: event.type, processedAt: FieldValue.serverTimestamp() });
      res.json({ received: true });
    } catch (err) {
      logger.error("Stripe webhook handling failed", { id: event.id, type: event.type, err });
      res.status(500).send("Handler error"); // Stripe retries
    }
  },
);
