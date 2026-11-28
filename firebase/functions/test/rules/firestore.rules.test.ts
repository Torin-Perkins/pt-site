import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

let env: RulesTestEnvironment;

const as = (uid: string, role?: string) =>
  env.authenticatedContext(uid, role ? { role } : {}).firestore();
const admin = () => as("admin1", "admin");
const trainer = () => as("trainer1", "trainer");
const client = () => as("client1", "client");
const otherClient = () => as("client2", "client");
const noRole = () => as("newbie");
const anon = () => env.unauthenticatedContext().firestore();

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-toro",
    firestore: { rules: readFileSync(fileURLToPath(new URL("../../../firestore.rules", import.meta.url)), "utf8") },
  });
});
afterAll(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users/client1"), { role: "client", email: "c1@example.com", displayName: "Cara" });
    await setDoc(doc(db, "users/client2"), { role: "client", email: "c2@example.com" });
    await setDoc(doc(db, "users/trainer1"), { role: "trainer", email: "t@example.com" });
    await setDoc(doc(db, "trainers/trainer1"), { displayName: "Erica", active: true });
    await setDoc(doc(db, "workouts/pub"), { title: "Full body A", published: true, createdBy: "trainer1" });
    await setDoc(doc(db, "workouts/draft"), { title: "WIP", published: false, createdBy: "trainer1" });
    await setDoc(doc(db, "nutritionPlans/p1"), { clientId: "client1", trainerId: "trainer1", title: "Plan", active: true });
    await setDoc(doc(db, "assignments/a1"), { clientId: "client1", trainerId: "trainer1", workoutId: "pub" });
    await setDoc(doc(db, "sessions/s1"), { clientId: "client1", trainerId: "trainer1", status: "requested" });
    await setDoc(doc(db, "invoices/in_1"), { clientId: "client1", amountDue: 9000 });
    await setDoc(doc(db, "users/client1/workoutLogs/l1"), { date: "2026-11-01", notes: "felt good" });
    await setDoc(doc(db, "billingPlans/ten"), { name: "10 pack", active: true });
    await setDoc(doc(db, "clientNotes/client1"), { text: "knee history" });
  });
});

describe("users", () => {
  it("clients read only themselves; staff read everyone", async () => {
    await assertSucceeds(getDoc(doc(client(), "users/client1")));
    await assertFails(getDoc(doc(client(), "users/client2")));
    await assertSucceeds(getDoc(doc(trainer(), "users/client2")));
    await assertFails(getDoc(doc(anon(), "users/client1")));
  });

  it("clients edit their profile but never their role", async () => {
    await assertSucceeds(updateDoc(doc(client(), "users/client1"), { displayName: "Cara B", goals: "Deadlift 100kg" }));
    await assertFails(updateDoc(doc(client(), "users/client1"), { role: "admin" }));
    await assertFails(updateDoc(doc(admin(), "users/client1"), { role: "trainer" }));
    await assertFails(setDoc(doc(noRole(), "users/newbie"), { role: "admin" }));
  });

  it("trainer notes are private to staff", async () => {
    await assertSucceeds(getDoc(doc(trainer(), "clientNotes/client1")));
    await assertFails(getDoc(doc(client(), "clientNotes/client1")));
  });
});

describe("client logs", () => {
  const log = () => ({ date: "2026-11-02", rpe: 7, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });

  it("clients write their own logs", async () => {
    await assertSucceeds(addDoc(collection(client(), "users/client1/workoutLogs"), log()));
    await assertSucceeds(addDoc(collection(client(), "users/client1/nutritionLogs"), log()));
    await assertSucceeds(addDoc(collection(client(), "users/client1/metrics"), { ...log(), weight: 150 }));
    await assertFails(addDoc(collection(otherClient(), "users/client1/workoutLogs"), log()));
    await assertFails(addDoc(collection(client(), "users/client1/workoutLogs"), { ...log(), date: "yesterday" }));
    await assertFails(addDoc(collection(client(), "users/client1/workoutLogs"), { ...log(), trainerComment: "fake" }));
  });

  it("trainers read logs and can only add feedback", async () => {
    await assertSucceeds(getDocs(collection(trainer(), "users/client1/workoutLogs")));
    await assertFails(getDocs(collection(otherClient(), "users/client1/workoutLogs")));
    await assertSucceeds(
      updateDoc(doc(trainer(), "users/client1/workoutLogs/l1"), {
        trainerComment: "Great depth!",
        reviewedBy: "trainer1",
        reviewedAt: serverTimestamp(),
      }),
    );
    await assertFails(updateDoc(doc(trainer(), "users/client1/workoutLogs/l1"), { notes: "rewritten" }));
  });
});

describe("coach-logged workouts", () => {
  const coachLog = (extra = {}) => ({
    date: "2026-11-11",
    title: "Session",
    exercises: [{ name: "Squat", sets: [{ reps: "8", weight: "65", done: true }] }],
    loggedBy: "trainer1",
    loggedByName: "Erica",
    sessionId: "s1",
    status: "in_progress",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...extra,
  });

  it("trainers log a client's workout during a session", async () => {
    await assertSucceeds(setDoc(doc(trainer(), "users/client1/workoutLogs/c1"), coachLog()));
    // keep updating it as the session goes
    await assertSucceeds(updateDoc(doc(trainer(), "users/client1/workoutLogs/c1"), { status: "completed", rpe: 7, updatedAt: serverTimestamp() }));
    // can't pretend another coach logged it, or set a bogus status
    await assertFails(setDoc(doc(trainer(), "users/client1/workoutLogs/c2"), coachLog({ loggedBy: "admin1" })));
    await assertFails(setDoc(doc(trainer(), "users/client1/workoutLogs/c3"), coachLog({ status: "whatever" })));
    // clients can't log as a coach
    await assertFails(setDoc(doc(client(), "users/client1/workoutLogs/c4"), coachLog({ loggedBy: "client1" })));
  });

  it("the client can read it but not change or delete it", async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "users/client1/workoutLogs/c5"), { ...coachLog(), createdAt: new Date(), updatedAt: new Date() }));
    await assertSucceeds(getDoc(doc(client(), "users/client1/workoutLogs/c5")));
    await assertFails(updateDoc(doc(client(), "users/client1/workoutLogs/c5"), { notes: "changed", updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(client(), "users/client1/workoutLogs/c5")));
    await assertFails(getDoc(doc(otherClient(), "users/client1/workoutLogs/c5")));
  });

  it("only the coach who logged it (or an admin) can edit or delete it", async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "users/client1/workoutLogs/c6"), { ...coachLog({ loggedBy: "trainer2" }), createdAt: new Date(), updatedAt: new Date() }));
    await assertFails(updateDoc(doc(trainer(), "users/client1/workoutLogs/c6"), { rpe: 9, updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(trainer(), "users/client1/workoutLogs/c6")));
    await assertSucceeds(updateDoc(doc(admin(), "users/client1/workoutLogs/c6"), { rpe: 9, updatedAt: serverTimestamp() }));
    // feedback still works for any coach
    await assertSucceeds(
      updateDoc(doc(trainer(), "users/client1/workoutLogs/c6"), { trainerComment: "Nice", reviewedBy: "trainer1", reviewedAt: serverTimestamp() }),
    );
    await assertSucceeds(deleteDoc(doc(admin(), "users/client1/workoutLogs/c6")));
  });

  it("clients' own logs are still theirs", async () => {
    await assertSucceeds(updateDoc(doc(client(), "users/client1/workoutLogs/l1"), { notes: "edited", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(trainer(), "users/client1/workoutLogs/l1"), { notes: "edited", updatedAt: serverTimestamp() }));
    await assertSucceeds(deleteDoc(doc(client(), "users/client1/workoutLogs/l1")));
  });
});

describe("workouts", () => {
  const workout = (extra = {}) => ({
    title: "Lower body",
    published: true,
    exercises: [{ name: "Goblet squat", sets: 3, reps: 10 }],
    createdBy: "trainer1",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...extra,
  });

  it("clients see all published workouts, not drafts", async () => {
    await assertSucceeds(getDoc(doc(client(), "workouts/pub")));
    await assertFails(getDoc(doc(client(), "workouts/draft")));
    await assertSucceeds(getDocs(query(collection(client(), "workouts"), where("published", "==", true))));
    await assertFails(getDocs(collection(client(), "workouts")));
    await assertFails(getDoc(doc(noRole(), "workouts/pub")));
  });

  it("only staff manage workouts", async () => {
    await assertSucceeds(addDoc(collection(trainer(), "workouts"), workout()));
    await assertSucceeds(addDoc(collection(admin(), "workouts"), workout({ createdBy: "admin1" })));
    await assertFails(addDoc(collection(client(), "workouts"), workout({ createdBy: "client1" })));
    await assertFails(addDoc(collection(trainer(), "workouts"), workout({ createdBy: "someoneElse" })));
    await assertFails(addDoc(collection(trainer(), "workouts"), workout({ title: "" })));
    await assertSucceeds(deleteDoc(doc(trainer(), "workouts/draft")));
    await assertFails(deleteDoc(doc(client(), "workouts/pub")));
  });
});

describe("assignments & nutrition plans", () => {
  it("clients read only their own", async () => {
    await assertSucceeds(getDoc(doc(client(), "nutritionPlans/p1")));
    await assertFails(getDoc(doc(otherClient(), "nutritionPlans/p1")));
    await assertSucceeds(getDocs(query(collection(client(), "nutritionPlans"), where("clientId", "==", "client1"))));
    await assertFails(getDocs(collection(client(), "nutritionPlans")));
    await assertSucceeds(getDoc(doc(client(), "assignments/a1")));
    await assertFails(getDoc(doc(otherClient(), "assignments/a1")));
  });

  it("trainers manage plans; clients only mark assignments done", async () => {
    const plan = {
      clientId: "client2",
      trainerId: "trainer1",
      title: "Protein focus",
      active: true,
      dailyCalories: 1900,
      macros: { proteinG: 130, carbsG: 180, fatG: 70 },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await assertSucceeds(addDoc(collection(trainer(), "nutritionPlans"), plan));
    await assertFails(addDoc(collection(client(), "nutritionPlans"), { ...plan, trainerId: "client1" }));
    await assertSucceeds(
      updateDoc(doc(client(), "assignments/a1"), { completedAt: serverTimestamp(), updatedAt: serverTimestamp() }),
    );
    await assertFails(updateDoc(doc(client(), "assignments/a1"), { workoutId: "other", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(otherClient(), "assignments/a1"), { completedAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  });
});

describe("scheduling & billing are function-only", () => {
  it("participants read sessions; nobody writes them directly", async () => {
    await assertSucceeds(getDoc(doc(client(), "sessions/s1")));
    await assertFails(getDoc(doc(otherClient(), "sessions/s1")));
    await assertSucceeds(getDoc(doc(trainer(), "sessions/s1")));
    await assertFails(updateDoc(doc(client(), "sessions/s1"), { status: "confirmed" }));
    await assertFails(updateDoc(doc(trainer(), "sessions/s1"), { status: "confirmed" }));
    await assertFails(setDoc(doc(client(), "slots/x"), { trainerId: "trainer1" }));
    await assertFails(setDoc(doc(trainer(), "availability/trainer1"), { timezone: "UTC" }));
    await assertSucceeds(getDoc(doc(client(), "availability/trainer1")));
  });

  it("invoices are visible to their client and staff only", async () => {
    await assertSucceeds(getDoc(doc(client(), "invoices/in_1")));
    await assertFails(getDoc(doc(otherClient(), "invoices/in_1")));
    await assertSucceeds(getDoc(doc(trainer(), "invoices/in_1")));
    await assertFails(updateDoc(doc(client(), "invoices/in_1"), { amountDue: 0 }));
    await assertFails(updateDoc(doc(trainer(), "invoices/in_1"), { amountDue: 0 }));
  });

  it("credit balance and history are visible to their client and staff only", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "billing/client1"), { sessionCredits: 4 });
      await setDoc(doc(ctx.firestore(), "creditLedger/e1"), { clientId: "client1", change: 4 });
    });
    await assertSucceeds(getDoc(doc(client(), "billing/client1")));
    await assertFails(getDoc(doc(otherClient(), "billing/client1")));
    await assertFails(updateDoc(doc(client(), "billing/client1"), { sessionCredits: 99 }));
    await assertSucceeds(getDoc(doc(client(), "creditLedger/e1")));
    await assertFails(getDoc(doc(otherClient(), "creditLedger/e1")));
    await assertSucceeds(getDoc(doc(trainer(), "creditLedger/e1")));
    await assertFails(setDoc(doc(client(), "creditLedger/e2"), { clientId: "client1", change: 10 }));
    await assertFails(setDoc(doc(trainer(), "creditLedger/e2"), { clientId: "client1", change: 10 }));
  });

  it("membership assignments: client reads own, nobody writes directly", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "membershipAssignments/client1"), { planId: "monthly", status: "pending" });
    });
    await assertSucceeds(getDoc(doc(client(), "membershipAssignments/client1")));
    await assertFails(getDoc(doc(otherClient(), "membershipAssignments/client1")));
    await assertSucceeds(getDoc(doc(trainer(), "membershipAssignments/client1")));
    await assertFails(setDoc(doc(client(), "membershipAssignments/client1"), { planId: "premium", status: "pending" }));
    await assertFails(setDoc(doc(trainer(), "membershipAssignments/client2"), { planId: "premium", status: "pending" }));
  });

  it("only admins manage billing plans", async () => {
    await assertSucceeds(getDoc(doc(client(), "billingPlans/ten")));
    await assertSucceeds(updateDoc(doc(admin(), "billingPlans/ten"), { active: false }));
    await assertFails(updateDoc(doc(trainer(), "billingPlans/ten"), { active: false }));
  });

  it("trainers edit only their own directory bio", async () => {
    await assertSucceeds(updateDoc(doc(trainer(), "trainers/trainer1"), { bio: "Strength coach" }));
    await assertFails(updateDoc(doc(trainer(), "trainers/trainer1"), { active: false }));
    await assertFails(updateDoc(doc(client(), "trainers/trainer1"), { bio: "x" }));
  });
});
