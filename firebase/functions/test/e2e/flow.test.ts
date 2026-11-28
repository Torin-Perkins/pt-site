/**
 * End-to-end: runs against the Auth, Firestore and Functions emulators
 * (`npm run test:e2e`). Exercises sign-up → roles → availability →
 * request → confirm → double-booking guard → cancel.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, type Auth } from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { connectFirestoreEmulator, doc, getDoc, getFirestore } from "firebase/firestore";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { getFirestore as adminDb } from "firebase-admin/firestore";

const PROJECT = "demo-toro";
const REGION = "us-west1";
initAdmin({ projectId: PROJECT });

interface Actor {
  app: FirebaseApp;
  auth: Auth;
  uid: string;
  call: <T = any>(name: string, data?: unknown) => Promise<T>;
  db: ReturnType<typeof getFirestore>;
}

const apps: FirebaseApp[] = [];
async function signUp(name: string): Promise<Actor> {
  const app = initializeApp({ projectId: PROJECT, apiKey: "fake-api-key", authDomain: "localhost" }, name);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const fns = getFunctions(app, REGION);
  connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  const cred = await createUserWithEmailAndPassword(auth, `${name}-${Date.now()}@example.com`, "password123");
  return {
    app,
    auth,
    db,
    uid: cred.user.uid,
    call: async (fn, data) => (await httpsCallable(fns, fn)(data)).data as any,
  };
}

/** Waits for the role claim to show up in a freshly refreshed ID token. */
async function waitForRole(a: Actor, role: string) {
  for (let i = 0; i < 60; i++) {
    const t = await a.auth.currentUser!.getIdTokenResult(true);
    if (t.claims.role === role) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`role ${role} never appeared`);
}

async function expectError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code: `functions/${code}` });
}

/** Next Monday 10:00 America/Los_Angeles, as an ISO string, plus n hours. */
function nextMondayPacific(hoursAfter10 = 0): string {
  const now = new Date();
  for (let d = 2; d < 10; d++) {
    const day = new Date(now.getTime() + d * 86_400_000);
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(day);
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).format(day);
    if (wd === "Mon") {
      // Find the UTC instant that is 10:00 local on that date (offset -7 or -8).
      for (const off of [7, 8]) {
        const cand = new Date(`${ymd}T${String(10 + off + hoursAfter10).padStart(2, "0")}:00:00Z`);
        const local = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23",
        }).format(cand);
        if (Number(local) === 10 + hoursAfter10) return cand.toISOString();
      }
    }
  }
  throw new Error("no monday");
}

let adminA: Actor, trainerA: Actor, clientA: Actor, clientB: Actor;

const credits = async (a: Actor) => (await adminDb().doc(`billing/${a.uid}`).get()).get("sessionCredits") ?? 0;

beforeAll(async () => {
  [adminA, trainerA, clientA, clientB] = await Promise.all(
    ["admin", "trainer", "clienta", "clientb"].map((n) => signUp(n)),
  );
  // The app calls ensureProfile right after sign-up (the auth trigger does the
  // same thing as a backstop).
  for (const a of [adminA, trainerA, clientA, clientB]) {
    expect(await a.call("ensureProfile")).toMatchObject({ role: "client" });
  }
  await Promise.all([adminA, trainerA, clientA, clientB].map((a) => waitForRole(a, "client")));

  // Bootstrap the first admin the way scripts/set-role.mjs does.
  await adminAuth().setCustomUserClaims(adminA.uid, { role: "admin" });
  await adminDb().doc(`users/${adminA.uid}`).set({ role: "admin" }, { merge: true });
  await waitForRole(adminA, "admin");
}, 60_000);

afterAll(async () => {
  await Promise.all(apps.map((a) => deleteApp(a)));
});

describe("roles", () => {
  it("new accounts are clients and get a profile", async () => {
    const snap = await getDoc(doc(clientA.db, `users/${clientA.uid}`));
    expect(snap.get("role")).toBe("client");
    // Idempotent, and never downgrades staff.
    expect(await clientA.call("ensureProfile")).toEqual({ role: "client", refreshToken: false });
  });

  it("only admins change roles", async () => {
    await expectError(clientA.call("setUserRole", { uid: clientA.uid, role: "admin" }), "permission-denied");
    await expect(adminA.call("setUserRole", { uid: trainerA.uid, role: "trainer" })).resolves.toMatchObject({
      role: "trainer",
    });
    await waitForRole(trainerA, "trainer");
    expect(await trainerA.call("ensureProfile")).toMatchObject({ role: "trainer" });
    const t = await getDoc(doc(clientA.db, `trainers/${trainerA.uid}`));
    expect(t.get("active")).toBe(true);
    await expectError(adminA.call("setUserRole", { uid: adminA.uid, role: "client" }), "failed-precondition");
  });
});

describe("scheduling", () => {
  const slot = nextMondayPacific(0);
  let sessionA: string;
  let sessionB: string;

  it("trainer publishes availability", async () => {
    await expectError(clientA.call("setAvailability", { weekly: {} }), "permission-denied");
    await expectError(
      trainerA.call("setAvailability", { timezone: "America/Los_Angeles", weekly: { mon: [{ start: "10:00", end: "09:00" }] } }),
      "invalid-argument",
    );
    await trainerA.call("setAvailability", {
      timezone: "America/Los_Angeles",
      weekly: { mon: [{ start: "09:00", end: "12:00" }] },
      minNoticeHours: 1,
    });
  });

  it("clients see open hours", async () => {
    const from = new Date(new Date(slot).getTime() - 2 * 3_600_000).toISOString();
    const to = new Date(new Date(slot).getTime() + 4 * 3_600_000).toISOString();
    const res = await clientA.call<{ slots: string[] }>("getOpenSlots", { trainerId: trainerA.uid, from, to });
    expect(res.slots).toContain(slot);
    expect(res.slots).toHaveLength(9); // every 15 minutes from 9:00 to 11:00
  });

  it("clients request one-hour blocks only", async () => {
    const offHour = new Date(new Date(slot).getTime() + 10 * 60_000).toISOString(); // 10:10 isn't a start time
    await expectError(clientA.call("requestSession", { trainerId: trainerA.uid, start: offHour }), "failed-precondition");
    await expectError(clientA.call("requestSession", { trainerId: clientB.uid, start: slot }), "not-found");
    await expectError(trainerA.call("requestSession", { trainerId: trainerA.uid, start: slot }), "permission-denied");

    // No credits, no booking.
    await expectError(clientA.call("requestSession", { trainerId: trainerA.uid, start: slot }), "failed-precondition");
    await expectError(clientA.call("adjustCredits", { clientId: clientA.uid, change: 5, note: "free" }), "permission-denied");
    await expectError(trainerA.call("adjustCredits", { clientId: clientA.uid, change: -1, note: "oops" }), "failed-precondition");
    await trainerA.call("adjustCredits", { clientId: clientA.uid, change: 2, note: "Intro offer" });
    await trainerA.call("adjustCredits", { clientId: clientB.uid, change: 1, note: "Intro offer" });

    sessionA = (await clientA.call("requestSession", { trainerId: trainerA.uid, start: slot, note: "Hip mobility?" })).sessionId;
    sessionB = (await clientB.call("requestSession", { trainerId: trainerA.uid, start: slot })).sessionId;
    expect(await credits(clientA)).toBe(1); // a request holds a credit
    expect(await credits(clientB)).toBe(0);
    await expectError(clientB.call("requestSession", { trainerId: trainerA.uid, start: nextMondayPacific(1) }), "failed-precondition");
    await expectError(clientA.call("requestSession", { trainerId: trainerA.uid, start: slot }), "already-exists");

    const s = await getDoc(doc(clientA.db, `sessions/${sessionA}`));
    expect(s.get("status")).toBe("requested");
    expect(s.get("end").toMillis() - s.get("start").toMillis()).toBe(3_600_000);
  });

  it("trainer confirms one request; the hour can't be double-booked", async () => {
    await expectError(clientA.call("respondToSession", { sessionId: sessionA, action: "confirm" }), "permission-denied");
    await expect(trainerA.call("respondToSession", { sessionId: sessionA, action: "confirm" })).resolves.toMatchObject({
      status: "confirmed",
    });
    await expectError(trainerA.call("respondToSession", { sessionId: sessionB, action: "confirm" }), "already-exists");
    const declined = await trainerA.call("respondToSession", { sessionId: sessionB, action: "decline", note: "Taken — try 11?" });
    expect(declined.creditRefunded).toBe(true);
    expect(await credits(clientB)).toBe(1);
    await expectError(clientB.call("requestSession", { trainerId: trainerA.uid, start: slot }), "already-exists");

    // Clients can't read each other's sessions.
    await expect(getDoc(doc(clientB.db, `sessions/${sessionA}`))).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("cancelling frees the hour", async () => {
    await expectError(clientB.call("cancelSession", { sessionId: sessionA }), "permission-denied");
    const res = await clientA.call("cancelSession", { sessionId: sessionA, reason: "Sick" });
    expect(res.status).toBe("cancelled");
    expect(res.lateCancellation).toBe(false);
    expect(res.creditRefunded).toBe(true);
    expect(await credits(clientA)).toBe(2);
    const again = await clientB.call("requestSession", { trainerId: trainerA.uid, start: slot });
    expect(again.status).toBe("requested");
    expect(await credits(clientB)).toBe(0);

    // The client's credit history shows each step.
    const ledger = await adminDb().collection("creditLedger").where("clientId", "==", clientA.uid).get();
    expect(ledger.docs.map((d) => d.get("change")).sort()).toEqual([-1, 1, 2]);
  });

  it("trainer can book a client directly", async () => {
    const eleven = nextMondayPacific(1);
    // The web SDK sends blank optional fields as null.
    const res = await trainerA.call("bookSession", { clientId: clientA.uid, start: eleven, note: null, trainerId: null });
    expect(res.status).toBe("confirmed");
    expect(res.creditUsed).toBe(true);
    expect(await credits(clientA)).toBe(1);
    await expectError(trainerA.call("bookSession", { clientId: clientB.uid, start: eleven }), "already-exists");
    await expectError(clientA.call("bookSession", { clientId: clientA.uid, start: eleven }), "permission-denied");
    // A client with no credits can still be booked by the coach (and invoiced).
    const nine = await trainerA.call("bookSession", { clientId: clientB.uid, start: nextMondayPacific(-1) });
    expect(nine.creditUsed).toBe(false);
    expect(await credits(clientB)).toBe(0);

    // A late cancellation by the client keeps the credit.
    await adminDb().doc(`availability/${trainerA.uid}`).update({ cancellationWindowHours: 24 * 30 });
    const late = await clientA.call("cancelSession", { sessionId: res.sessionId });
    expect(late).toMatchObject({ lateCancellation: true, creditRefunded: false });
    expect(await credits(clientA)).toBe(1);
  });
});

describe("15-minute start times", () => {
  const at = (hoursAfter10: number, minutes: number, weeks = 0) =>
    new Date(new Date(nextMondayPacific(hoursAfter10)).getTime() + minutes * 60_000 + weeks * 7 * 86_400_000).toISOString();

  it("sessions can start on the quarter hour but never overlap", async () => {
    // Client B is booked 9:00-10:00 (from the scheduling tests).
    await expectError(trainerA.call("bookSession", { clientId: clientA.uid, start: at(-1, 30) }), "already-exists"); // 9:30
    const quarter = await trainerA.call("bookSession", { clientId: clientA.uid, start: at(0, 15) }); // 10:15-11:15
    expect(quarter.status).toBe("confirmed");
    const s = await adminDb().doc(`sessions/${quarter.sessionId}`).get();
    expect(s.get("slotIds")).toHaveLength(4);

    // B's 10:00 request now overlaps 10:15 and can't be confirmed.
    const pending = await adminDb().collection("sessions").where("clientId", "==", clientB.uid).where("status", "==", "requested").get();
    await expectError(trainerA.call("respondToSession", { sessionId: pending.docs[0].id, action: "confirm" }), "already-exists");

    // Open times leave out everything overlapping 9:00-10:00 and 10:15-11:15.
    const res = await clientA.call<{ slots: string[] }>("getOpenSlots", { trainerId: trainerA.uid, from: at(-2, 0), to: at(4, 0) });
    expect(res.slots).toEqual([]);

    // Cancelling frees all four blocks: 10:30 is bookable again.
    await trainerA.call("cancelSession", { sessionId: quarter.sessionId });
    const again = await clientA.call<{ slots: string[] }>("getOpenSlots", { trainerId: trainerA.uid, from: at(-2, 0), to: at(4, 0) });
    expect(again.slots).toContain(at(0, 30));
    expect(again.slots).not.toContain(at(-1, 45)); // still overlaps B's 9:00-10:00
  });

  it("respects sessions booked before quarter-hour starts existed", async () => {
    // An older booking locked only its first block.
    const legacyStart = new Date(at(-1, 0, 1));
    await adminDb().doc(`slots/${trainerA.uid}_${legacyStart.toISOString().slice(0, 16).replace(":", "")}`).set({
      trainerId: trainerA.uid,
      start: legacyStart,
      end: new Date(legacyStart.getTime() + 3_600_000),
      sessionId: "legacy",
    });
    await expectError(trainerA.call("bookSession", { clientId: clientB.uid, start: at(-1, 45, 1) }), "already-exists");
    const ok = await trainerA.call("bookSession", { clientId: clientB.uid, start: at(0, 0, 1) });
    expect(ok.status).toBe("confirmed");
  });
});

describe("billing guards", () => {
  it("clients can't invoice", async () => {
    await expectError(
      clientA.call("createInvoice", { clientId: clientA.uid, items: [{ description: "x", unitAmount: 100 }] }),
      "permission-denied",
    );
  });
  it("checkout only accepts active catalog plans", async () => {
    await expectError(clientA.call("createCheckoutSession", { planId: "nope" }), "not-found");
  });
});
