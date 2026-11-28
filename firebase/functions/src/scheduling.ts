import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore";
import { z } from "zod";
import { db, COL } from "./lib/firebase.js";
import { caller, parse, requireRole, type Caller } from "./lib/auth.js";
import {
  type Availability,
  SESSION_MS,
  SLOT_PROBLEM_MESSAGES,
  WEEKDAYS,
  checkSlot,
  isLateCancellation,
  blockIds,
  listOpenSlots,
  nearbyBlockIds,
  overlaps,
  slotId,
  validateAvailability,
} from "./lib/schedule.js";
import { REGION } from "./config.js";
import { readCredits, writeCreditChange } from "./credits.js";

/** A client may have at most this many requests waiting on a trainer. */
const MAX_PENDING_REQUESTS = 5;
const MAX_SLOT_RANGE_DAYS = 31;

export type SessionStatus = "requested" | "confirmed" | "declined" | "cancelled" | "completed" | "no_show";
const ACTIVE: SessionStatus[] = ["requested", "confirmed"];

export interface SessionDoc {
  clientId: string;
  clientName: string | null;
  trainerId: string;
  trainerName: string | null;
  start: Timestamp;
  end: Timestamp;
  status: SessionStatus;
  /** First 15-minute block (older bookings locked only this one). */
  slotId: string;
  /** Every 15-minute block the session covers, once confirmed. */
  slotIds?: string[];
  clientNote?: string | null;
  trainerNote?: string | null;
  cancelReason?: string | null;
  cancelledBy?: string | null;
  lateCancellation?: boolean;
  invoiceId?: string | null;
  /** A session credit was spent on this session (and may be refunded). */
  creditUsed?: boolean;
  creditRefunded?: boolean;
  createdBy: string;
}

const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const note = z.string().trim().max(1000).optional();

// ---------------------------------------------------------------- helpers

async function loadAvailability(trainerId: string, tx?: Transaction): Promise<Availability> {
  const ref = db.collection(COL.availability).doc(trainerId);
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (!snap.exists) throw new HttpsError("failed-precondition", "This trainer hasn't published availability yet.");
  return snap.data() as Availability;
}

async function displayName(collection: string, uid: string): Promise<string | null> {
  const snap = await db.collection(collection).doc(uid).get();
  return (snap.get("displayName") as string | undefined) ?? (snap.get("email") as string | undefined) ?? null;
}

async function assertTrainer(trainerId: string): Promise<void> {
  const snap = await db.collection(COL.users).doc(trainerId).get();
  const role = snap.get("role");
  if (role !== "trainer" && role !== "admin") throw new HttpsError("not-found", "Trainer not found.");
}

async function assertClient(clientId: string): Promise<void> {
  const snap = await db.collection(COL.users).doc(clientId).get();
  if (!snap.exists || snap.get("deleted")) throw new HttpsError("not-found", "Client not found.");
}

/** The client's upcoming active sessions that would overlap a new hour. */
async function clientConflicts(tx: Transaction, clientId: string, start: Date) {
  const snap = await tx.get(
    db
      .collection(COL.sessions)
      .where("clientId", "==", clientId)
      .where("start", ">", Timestamp.fromMillis(start.getTime() - SESSION_MS))
      .where("start", "<", Timestamp.fromMillis(start.getTime() + SESSION_MS)),
  );
  return snap.docs.filter((d) => {
    const s = d.data() as SessionDoc;
    return (
      ACTIVE.includes(s.status) &&
      overlaps(s.start.toMillis(), s.end.toMillis(), start.getTime(), start.getTime() + SESSION_MS)
    );
  });
}

/**
 * True if a booked session of this trainer overlaps [start, end). Reads the
 * lock documents of nearby 15-minute blocks inside the transaction, so two
 * overlapping bookings can't both be confirmed.
 */
async function trainerBusy(tx: Transaction, trainerId: string, start: Date, end: Date, ignoreSessionId?: string): Promise<boolean> {
  const refs = nearbyBlockIds(trainerId, start, end).map((id) => db.collection(COL.slots).doc(id));
  const snaps = await tx.getAll(...refs);
  return snaps.some((snap) => {
    if (!snap.exists || snap.get("sessionId") === ignoreSessionId) return false;
    const s = (snap.get("start") as Timestamp).toMillis();
    const e = (snap.get("end") as Timestamp).toMillis();
    return overlaps(s, e, start.getTime(), end.getTime());
  });
}

/** Locks every 15-minute block of a confirmed session (call after trainerBusy). */
function lockBlocks(tx: Transaction, trainerId: string, start: Timestamp, end: Timestamp, sessionId: string): string[] {
  const ids = blockIds(trainerId, start.toDate(), end.toDate());
  for (const id of ids) tx.create(db.collection(COL.slots).doc(id), { trainerId, start, end, sessionId });
  return ids;
}

/** Reads a session's lock documents (before any writes) and returns a function that releases them. */
async function prepareRelease(tx: Transaction, s: SessionDoc, sessionId: string): Promise<() => void> {
  const refs = (s.slotIds?.length ? s.slotIds : [s.slotId]).map((id) => db.collection(COL.slots).doc(id));
  const snaps = await tx.getAll(...refs);
  return () => snaps.forEach((snap) => snap.exists && snap.get("sessionId") === sessionId && tx.delete(snap.ref));
}

function assertSlotFits(start: Date, availability: Availability, enforceNotice: boolean) {
  const problem = checkSlot(start, availability, new Date(), { enforceNotice });
  if (problem) throw new HttpsError("failed-precondition", SLOT_PROBLEM_MESSAGES[problem]);
}

function assertSessionTrainer(c: Caller, s: SessionDoc) {
  if (c.role === "admin") return;
  if (c.role === "trainer" && s.trainerId === c.uid) return;
  throw new HttpsError("permission-denied", "Only this session's trainer can do that.");
}

// ---------------------------------------------------------------- availability

const Window = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/),
});

const AvailabilityInput = z.object({
  trainerId: z.string().optional(), // admins may edit any trainer
  timezone: z.string().default("America/Los_Angeles"),
  weekly: z.partialRecord(z.enum(WEEKDAYS), z.array(Window).max(12)),
  blackoutDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(366).default([]),
  minNoticeHours: z.number().min(0).max(24 * 14).optional(),
  maxDaysAhead: z.number().int().min(1).max(365).optional(),
  cancellationWindowHours: z.number().min(0).max(24 * 7).optional(),
  acceptingRequests: z.boolean().default(true),
  slotStepMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(15),
});

/** Trainer: publish weekly hours, blackout dates and booking rules. */
export const setAvailability = onCall({ region: REGION }, async (request) => {
  const c = requireRole(request, "trainer", "admin");
  const { trainerId: target, ...input } = parse(AvailabilityInput, request.data);
  const trainerId = target ?? c.uid;
  if (trainerId !== c.uid && c.role !== "admin") {
    throw new HttpsError("permission-denied", "You can only edit your own availability.");
  }
  try {
    validateAvailability(input);
  } catch (e) {
    throw new HttpsError("invalid-argument", (e as Error).message);
  }
  await db.collection(COL.availability).doc(trainerId).set({
    ...input,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: c.uid,
  });
  return { ok: true };
});

// ---------------------------------------------------------------- open slots

const SlotsInput = z.object({ trainerId: z.string().min(1), from: isoDate, to: isoDate });

/** Anyone signed in: open one-hour start times for a trainer in a date range. */
export const getOpenSlots = onCall({ region: REGION }, async (request) => {
  caller(request);
  const { trainerId, from, to } = parse(SlotsInput, request.data);
  if (to <= from) throw new HttpsError("invalid-argument", "`to` must be after `from`.");
  if (to.getTime() - from.getTime() > MAX_SLOT_RANGE_DAYS * 86_400_000) {
    throw new HttpsError("invalid-argument", `Ask for at most ${MAX_SLOT_RANGE_DAYS} days at a time.`);
  }
  const availability = await loadAvailability(trainerId);
  // Booked sessions that could overlap the range (one may have started up to an hour earlier).
  const taken = await db
    .collection(COL.slots)
    .where("trainerId", "==", trainerId)
    .where("start", ">", Timestamp.fromMillis(from.getTime() - SESSION_MS))
    .where("start", "<", Timestamp.fromDate(to))
    .get();
  const busy = taken.docs.map((d) => ({ start: (d.get("start") as Timestamp).toMillis(), end: (d.get("end") as Timestamp).toMillis() }));
  const slots = listOpenSlots(availability, from, to, busy, new Date());
  return { timezone: availability.timezone, slots: slots.map((d) => d.toISOString()) };
});

// ---------------------------------------------------------------- requests

const RequestInput = z.object({ trainerId: z.string().min(1), start: isoDate, note });

/** Client: ask for a one-hour session. The trainer confirms or declines it. */
export const requestSession = onCall({ region: REGION }, async (request) => {
  const c = requireRole(request, "client");
  const { trainerId, start, note: clientNote } = parse(RequestInput, request.data);
  await assertTrainer(trainerId);
  const [clientName, trainerName] = await Promise.all([
    displayName(COL.users, c.uid),
    displayName(COL.trainers, trainerId),
  ]);

  const ref = db.collection(COL.sessions).doc();
  const id = slotId(trainerId, start);
  const end = new Date(start.getTime() + SESSION_MS);
  await db.runTransaction(async (tx) => {
    const availability = await loadAvailability(trainerId, tx);
    const busy = await trainerBusy(tx, trainerId, start, end);
    const conflicts = await clientConflicts(tx, c.uid, start);
    const pending = await tx.get(
      db.collection(COL.sessions).where("clientId", "==", c.uid).where("status", "==", "requested"),
    );
    const credits = await readCredits(tx, c.uid);

    assertSlotFits(start, availability, true);
    if (credits.balance < 1) {
      throw new HttpsError(
        "failed-precondition",
        "You don't have any session credits left. Buy a package or membership on the Billing page to book.",
      );
    }
    if (busy) throw new HttpsError("already-exists", "That time has already been booked.");
    if (conflicts.length) throw new HttpsError("already-exists", "You already have a session at that time.");
    if (pending.size >= MAX_PENDING_REQUESTS) {
      throw new HttpsError("resource-exhausted", "You have several requests waiting — please wait for a reply.");
    }

    const doc: SessionDoc = {
      clientId: c.uid,
      clientName,
      trainerId,
      trainerName,
      start: Timestamp.fromDate(start),
      end: Timestamp.fromMillis(start.getTime() + SESSION_MS),
      status: "requested",
      slotId: id,
      clientNote: clientNote ?? null,
      createdBy: c.uid,
      creditUsed: true,
    };
    tx.create(ref, { ...doc, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    writeCreditChange(tx, credits, c.uid, -1, { reason: "session_booked", sessionId: ref.id, by: c.uid });
  });
  return { sessionId: ref.id, status: "requested" };
});

const BookInput = z.object({
  clientId: z.string().min(1),
  trainerId: z.string().optional(),
  start: isoDate,
  note,
  /** Spend one of the client's credits if they have any (default). */
  useCredit: z.boolean().default(true),
});

/**
 * Trainer: put a confirmed session on the calendar directly (e.g. booked in
 * person). Skips the minimum-notice rule but still respects availability.
 */
export const bookSession = onCall({ region: REGION }, async (request) => {
  const c = requireRole(request, "trainer", "admin");
  const { clientId, start, note: trainerNote, useCredit, ...rest } = parse(BookInput, request.data);
  const trainerId = rest.trainerId ?? c.uid;
  if (trainerId !== c.uid && c.role !== "admin") {
    throw new HttpsError("permission-denied", "You can only book your own sessions.");
  }
  await Promise.all([assertTrainer(trainerId), assertClient(clientId)]);
  const [clientName, trainerName] = await Promise.all([
    displayName(COL.users, clientId),
    displayName(COL.trainers, trainerId),
  ]);

  const ref = db.collection(COL.sessions).doc();
  const id = slotId(trainerId, start);
  const creditUsed = await db.runTransaction(async (tx) => {
    const availability = await loadAvailability(trainerId, tx);
    const busy = await trainerBusy(tx, trainerId, start, new Date(start.getTime() + SESSION_MS));
    const conflicts = await clientConflicts(tx, clientId, start);
    const credits = await readCredits(tx, clientId);

    assertSlotFits(start, availability, false);
    if (busy) throw new HttpsError("already-exists", "That time overlaps another session.");
    if (conflicts.length) throw new HttpsError("already-exists", "The client already has a session at that time.");

    const end = Timestamp.fromMillis(start.getTime() + SESSION_MS);
    const slotIds = lockBlocks(tx, trainerId, Timestamp.fromDate(start), end, ref.id);
    const doc: SessionDoc = {
      clientId,
      clientName,
      trainerId,
      trainerName,
      start: Timestamp.fromDate(start),
      end,
      status: "confirmed",
      slotId: id,
      slotIds,
      trainerNote: trainerNote ?? null,
      createdBy: c.uid,
      creditUsed: useCredit && credits.balance >= 1,
    };
    tx.create(ref, {
      ...doc,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      confirmedAt: FieldValue.serverTimestamp(),
    });
    if (doc.creditUsed) writeCreditChange(tx, credits, clientId, -1, { reason: "session_booked", sessionId: ref.id, by: c.uid });
    return Boolean(doc.creditUsed);
  });
  return { sessionId: ref.id, status: "confirmed", creditUsed };
});

// ---------------------------------------------------------------- respond

const RespondInput = z.object({
  sessionId: z.string().min(1),
  action: z.enum(["confirm", "decline"]),
  note,
});

/** Trainer: confirm (locks the hour) or decline a client's request. */
export const respondToSession = onCall({ region: REGION }, async (request) => {
  const c = requireRole(request, "trainer", "admin");
  const { sessionId, action, note: trainerNote } = parse(RespondInput, request.data);
  const ref = db.collection(COL.sessions).doc(sessionId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Session not found.");
    const s = snap.data() as SessionDoc;
    assertSessionTrainer(c, s);
    if (s.status !== "requested") throw new HttpsError("failed-precondition", `This session is already ${s.status}.`);

    const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp(), respondedBy: c.uid };
    if (trainerNote !== undefined) update.trainerNote = trainerNote;

    if (action === "decline") {
      const credits = s.creditUsed ? await readCredits(tx, s.clientId) : null;
      tx.update(ref, {
        ...update,
        status: "declined",
        declinedAt: FieldValue.serverTimestamp(),
        ...(credits ? { creditRefunded: true } : {}),
      });
      if (credits) writeCreditChange(tx, credits, s.clientId, 1, { reason: "session_refund", note: "Request declined", sessionId, by: c.uid });
      return { sessionId, status: "declined", creditRefunded: Boolean(credits) };
    }

    if (s.start.toMillis() <= Date.now()) throw new HttpsError("failed-precondition", "That time has passed.");
    if (await trainerBusy(tx, s.trainerId, s.start.toDate(), s.end.toDate(), sessionId)) {
      throw new HttpsError("already-exists", "That time overlaps another session you've confirmed.");
    }
    const slotIds = lockBlocks(tx, s.trainerId, s.start, s.end, sessionId);
    tx.update(ref, { ...update, status: "confirmed", slotIds, confirmedAt: FieldValue.serverTimestamp() });
    return { sessionId, status: "confirmed" };
  });
});

// ---------------------------------------------------------------- cancel

const CancelInput = z.object({ sessionId: z.string().min(1), reason: note });

/**
 * Client, the session's trainer, or an admin: cancel a requested or confirmed
 * session and free the hour. Client cancellations of a confirmed session
 * inside the trainer's cancellation window are flagged `lateCancellation` and
 * keep the session credit; every other cancellation refunds it.
 */
export const cancelSession = onCall({ region: REGION }, async (request) => {
  const c = caller(request);
  const { sessionId, reason } = parse(CancelInput, request.data);
  const ref = db.collection(COL.sessions).doc(sessionId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Session not found.");
    const s = snap.data() as SessionDoc;

    const isClient = s.clientId === c.uid;
    if (!isClient) assertSessionTrainer(c, s);
    if (!ACTIVE.includes(s.status)) throw new HttpsError("failed-precondition", `This session is already ${s.status}.`);
    if (s.start.toMillis() <= Date.now()) {
      throw new HttpsError("failed-precondition", "This session has already started.");
    }

    const availSnap = await tx.get(db.collection(COL.availability).doc(s.trainerId));
    const late =
      isClient && s.status === "confirmed" && isLateCancellation(s.start.toDate(), new Date(), availSnap.data() as Availability | undefined);

    const release = s.status === "confirmed" ? await prepareRelease(tx, s, sessionId) : null;
    const refund = Boolean(s.creditUsed) && !late;
    const credits = refund ? await readCredits(tx, s.clientId) : null;

    release?.();
    tx.update(ref, {
      status: "cancelled",
      cancelReason: reason ?? null,
      cancelledBy: c.uid,
      lateCancellation: late,
      creditRefunded: refund,
      cancelledAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (credits) {
      writeCreditChange(tx, credits, s.clientId, 1, {
        reason: "session_refund",
        note: isClient ? "Cancelled by client" : "Cancelled by coach",
        sessionId,
        by: c.uid,
      });
    }
    return { sessionId, status: "cancelled", lateCancellation: late, creditRefunded: refund };
  });
});

// ---------------------------------------------------------------- complete

const CompleteInput = z.object({
  sessionId: z.string().min(1),
  outcome: z.enum(["completed", "no_show"]),
  note,
});

/** Trainer: mark a confirmed session that has started as completed or a no-show. */
export const completeSession = onCall({ region: REGION }, async (request) => {
  const c = requireRole(request, "trainer", "admin");
  const { sessionId, outcome, note: trainerNote } = parse(CompleteInput, request.data);
  const ref = db.collection(COL.sessions).doc(sessionId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Session not found.");
    const s = snap.data() as SessionDoc;
    assertSessionTrainer(c, s);
    if (s.status !== "confirmed") throw new HttpsError("failed-precondition", `This session is ${s.status}.`);
    if (s.start.toMillis() > Date.now()) throw new HttpsError("failed-precondition", "This session hasn't started yet.");
    tx.update(ref, {
      status: outcome,
      ...(trainerNote !== undefined ? { trainerNote } : {}),
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { sessionId, status: outcome };
  });
});

