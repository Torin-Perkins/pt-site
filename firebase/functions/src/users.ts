import * as functionsV1 from "firebase-functions/v1";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { auth, db, COL } from "./lib/firebase.js";
import { ROLES, type Role, parse, requireRole } from "./lib/auth.js";
import { REGION } from "./config.js";

/**
 * Applies a role: sets the custom claim (what security rules check), mirrors
 * it onto users/{uid}, and keeps the public trainers/{uid} directory entry in
 * sync. `claimsUpdatedAt` lets the app know to refresh the user's ID token.
 */
export async function applyRole(uid: string, role: Role): Promise<void> {
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, { ...(user.customClaims ?? {}), role });

  const batch = db.batch();
  batch.set(
    db.collection(COL.users).doc(uid),
    {
      email: user.email ?? null,
      displayName: user.displayName ?? null,
      role,
      claimsUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  const trainerRef = db.collection(COL.trainers).doc(uid);
  if (role === "trainer" || role === "admin") {
    batch.set(
      trainerRef,
      { displayName: user.displayName ?? user.email ?? "Coach", active: true, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  } else {
    batch.set(trainerRef, { active: false, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  await batch.commit();
}

/**
 * Creates users/{uid} and gives the account the client role unless it already
 * has one. Safe to run more than once.
 */
async function provision(uid: string): Promise<Role> {
  const user = await auth.getUser(uid);
  const ref = db.collection(COL.users).doc(uid);
  const snap = await ref.get();
  const fill: Record<string, unknown> = {};
  if (!snap.get("createdAt")) fill.createdAt = FieldValue.serverTimestamp();
  if (!snap.get("email") && user.email) fill.email = user.email;
  // The sign-up form sets the name just after the account is created.
  if (!snap.get("displayName")) fill.displayName = user.displayName ?? null;
  if (!snap.get("photoURL")) fill.photoURL = user.photoURL ?? null;
  if (Object.keys(fill).length) await ref.set(fill, { merge: true });
  const existing = user.customClaims?.role as Role | undefined;
  if (existing && (ROLES as readonly string[]).includes(existing)) return existing;
  await applyRole(uid, "client");
  return "client";
}

/** Every new account starts as a client. Staff are promoted by an admin. */
export const onUserCreated = functionsV1
  .region(REGION)
  .auth.user()
  .onCreate(async (user) => {
    await provision(user.uid);
  });

/**
 * Called by the app right after sign-up / sign-in so the role is in place
 * without waiting for the auth trigger. Afterwards the app should refresh the
 * ID token (`getIdToken(true)`) to pick up the role claim.
 */
export const ensureProfile = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Please sign in.");
  const role = await provision(request.auth.uid);
  return { role, refreshToken: request.auth.token.role !== role };
});

export const onUserDeleted = functionsV1
  .region(REGION)
  .auth.user()
  .onDelete(async (user) => {
    // Keep history (sessions, invoices) but flag the profile.
    await db.collection(COL.users).doc(user.uid).set(
      { deleted: true, deletedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    await db.collection(COL.trainers).doc(user.uid).set({ active: false }, { merge: true });
  });

const SetRoleInput = z
  .object({
    uid: z.string().min(1).optional(),
    email: z.email().optional(),
    role: z.enum(ROLES),
  })
  .refine((v) => v.uid || v.email, { message: "Provide uid or email" });

/** Admin only: change a user's role. */
export const setUserRole = onCall({ region: REGION }, async (request) => {
  const admin = requireRole(request, "admin");
  const input = parse(SetRoleInput, request.data);

  let uid = input.uid;
  if (!uid) {
    try {
      uid = (await auth.getUserByEmail(input.email!)).uid;
    } catch {
      throw new HttpsError("not-found", "No account with that email.");
    }
  }
  if (uid === admin.uid && input.role !== "admin") {
    throw new HttpsError("failed-precondition", "You can't remove your own admin role.");
  }

  await applyRole(uid, input.role);
  logger.info("Role changed", { uid, role: input.role, by: admin.uid });
  return { uid, role: input.role };
});
