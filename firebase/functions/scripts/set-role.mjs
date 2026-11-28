#!/usr/bin/env node
/**
 * Give an existing account a role from the command line. Use this once to make
 * the first admin; after that, admins can change roles from the app
 * (the setUserRole function).
 *
 *   gcloud auth application-default login      # or GOOGLE_APPLICATION_CREDENTIALS=key.json
 *   npm run set-role -- you@example.com admin --project toro-fitness
 *
 * The person must have signed in to the portal at least once, and must sign
 * out and back in (or refresh their token) to pick up the new role.
 */
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const ROLES = ["admin", "trainer", "client"];
const args = process.argv.slice(2);
const projectFlag = args.indexOf("--project");
const projectId = projectFlag >= 0 ? args.splice(projectFlag, 2)[1] : process.env.GCLOUD_PROJECT;
const [email, role] = args;

if (!email || !ROLES.includes(role) || !projectId) {
  console.error("Usage: npm run set-role -- <email> <admin|trainer|client> --project <firebase-project-id>");
  process.exit(1);
}

initializeApp({ projectId });
const auth = getAuth();
const db = getFirestore();

const user = await auth.getUserByEmail(email);
await auth.setCustomUserClaims(user.uid, { ...(user.customClaims ?? {}), role });
await db.doc(`users/${user.uid}`).set(
  { email: user.email ?? null, role, claimsUpdatedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
  { merge: true },
);
const staff = role === "admin" || role === "trainer";
await db.doc(`trainers/${user.uid}`).set(
  { ...(staff ? { displayName: user.displayName ?? user.email ?? "Coach" } : {}), active: staff, updatedAt: FieldValue.serverTimestamp() },
  { merge: true },
);
console.log(`${email} (${user.uid}) is now ${role}.`);
